import type { AgentMode } from '../shared/policies';
import type { ClientMessage, Provider, ServerMessage } from '../shared/protocol';
import { PCM_SAMPLE_RATE } from '../shared/audio';
import { GatedPlayer } from './gated-player';
import type { LiveCallbacks } from './live';
import workletUrl from './pcm-worklet.ts?worker&url';

export class GatedLiveCall {
  private ws?: WebSocket;
  private stream?: MediaStream;
  private context?: AudioContext;
  private input?: MediaStreamAudioSourceNode;
  private encoder?: AudioWorkletNode;
  private player?: GatedPlayer;
  private stopped = false;
  private ready = false;
  private currentInput?: string;
  private speaking = false;
  private speechEnd?: number;
  private armed?: { requestId: string; turn: number };
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastHeartbeat = performance.now();
  private began = performance.now();
  constructor(private callbacks: LiveCallbacks) {}

  async start(provider: Provider, mode: AgentMode) {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone API unavailable on this browser.');
      this.callbacks.status('Requesting microphone');
      const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      this.context = context;
      await context.resume();
      if (this.stopped) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      stream.getTracks().forEach(t => { t.enabled = false; });
      if (context.sampleRate !== PCM_SAMPLE_RATE || !context.audioWorklet) throw new Error('This browser does not support native 24 kHz worklet capture.');
      await context.audioWorklet.addModule(workletUrl);
      if (this.stopped) return;
      this.player = new GatedPlayer(context, {
        started: identity => {
          this.send({ type: 'local-playback', state: 'started', responseId: identity.responseId, requestId: identity.requestId });
          this.callbacks.status('Approved output playing');
        },
        ended: identity => this.send({ type: 'local-playback', state: 'ended', responseId: identity.responseId, requestId: identity.requestId }),
        energy: (identity, heldMs) => {
          this.metric('gated-whole-response-wait', heldMs, identity.responseId);
          if (this.speechEnd !== undefined) this.metric('speech-end-to-audio-energy', performance.now() - this.speechEnd, identity.responseId);
        },
      });
      const encoder = new AudioWorkletNode(context, 'relay-pcm-input', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
      this.encoder = encoder;
      encoder.onprocessorerror = () => this.fail('Native microphone encoding failed. Buffered output discarded.');
      encoder.port.onmessage = ({ data }: MessageEvent<{ pcm?: ArrayBuffer; error?: string }>) => {
        if (this.stopped) return;
        if (data.error) { this.fail(data.error); return; }
        if (!this.ready || !data.pcm) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 96000) {
          this.fail('Native input relay is unavailable or overloaded. Call stopped.'); return;
        }
        const bytes = new Uint8Array(data.pcm);
        this.send({ type: 'audio-input', data: btoa(String.fromCharCode(...bytes)) });
      };
      this.input = context.createMediaStreamSource(stream);
      this.input.connect(encoder);
      encoder.connect(context.destination); // The input processor emits only zero-valued output.
      this.lastHeartbeat = performance.now();
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      this.ws = ws;
      this.callbacks.status('Connecting native PCM relay');
      ws.onopen = () => this.send({ type: 'connect-gated', outputMode: 'gated', provider, mode });
      ws.onmessage = event => {
        if (this.stopped) return;
        try { this.receive(JSON.parse(event.data) as ServerMessage); }
        catch (error) { this.fail(error instanceof Error ? error.message : 'Native buffered audio validation failed.'); }
      };
      ws.onerror = () => this.fail('Cannot connect to the local native audio relay.');
      ws.onclose = () => { if (!this.stopped) this.fail('Local audio relay disconnected. Microphone and buffered output stopped.'); };
      this.heartbeat = setInterval(() => {
        if (performance.now() - this.lastHeartbeat > 6500) this.fail('Local guardrail heartbeat lost. Buffered speech discarded.');
      }, 1000);
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof DOMException ? `Native microphone/audio setup failed (${error.name}).`
        : error instanceof Error ? error.message : 'Native microphone/audio setup failed.');
    }
  }
  private receive(message: ServerMessage) {
    switch (message.type) {
      case 'heartbeat': this.lastHeartbeat = performance.now(); break;
      case 'ready':
        this.ready = true;
        this.stream?.getTracks().forEach(t => { t.enabled = true; });
        this.callbacks.status('Listening');
        break;
      case 'input-speech':
        if (message.state === 'started') {
          this.currentInput = message.itemId;
          this.speaking = true;
          this.speechEnd = undefined;
          this.armed = undefined;
          this.player?.cancel();
        } else if (this.currentInput === message.itemId) {
          this.speaking = false;
          this.speechEnd = performance.now();
        }
        break;
      case 'arm':
        if (this.currentInput !== message.inputItemId || this.speaking) return;
        this.armed = message;
        this.send({ type: 'armed', requestId: message.requestId });
        break;
      case 'audio-start':
        if (message.requestId !== this.armed?.requestId || message.turn !== this.armed.turn || this.speaking) return;
        this.player?.begin(message);
        this.callbacks.status('Output held; checking whole response');
        break;
      case 'audio-chunk': this.player?.append(message.responseId, message.part, message.data); break;
      case 'audio-part-done': this.player?.finishPart(message.responseId, message.part); break;
      case 'audio-complete': this.player?.complete(message, message.revision, message.parts); break;
      case 'audio-release':
        if (message.requestId !== this.armed?.requestId || message.turn !== this.armed.turn || this.speaking) return;
        this.player?.release(message, message.revision);
        break;
      case 'mute': {
        const start = performance.now();
        this.player?.cancel();
        this.armed = undefined;
        this.send({ type: 'muted', actionId: message.actionId, durationMs: performance.now() - start });
        break;
      }
      case 'event':
        this.callbacks.event(message.event);
        if (message.event.kind === 'transcript' && message.event.phase === 'input' && this.speechEnd !== undefined)
          this.metric('transcription-event-delay', performance.now() - this.speechEnd);
        break;
      case 'fatal': this.fail(message.message); break;
      case 'answer': this.fail('Unexpected WebRTC answer in a native PCM session.'); break;
    }
  }
  private metric(name: Extract<ClientMessage, { type: 'metric' }>['name'], durationMs: number, responseId?: string) {
    const atMs = performance.now() - this.began;
    this.send({ type: 'metric', name, durationMs, atMs, responseId });
    this.callbacks.event({ id: crypto.randomUUID(), source: 'live', clock: 'browser', kind: 'metric', name,
      durationMs, atMs, responseId, outputMode: 'gated', transport: 'azure-websocket-pcm-relay' });
  }
  private send(message: ClientMessage) { if (!this.stopped && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.callbacks.error(message);
  }
  stop() {
    if (this.stopped) return;
    this.send({ type: 'stop' });
    this.stopped = true;
    this.ready = false;
    this.armed = undefined;
    this.player?.dispose();
    this.stream?.getTracks().forEach(t => { t.enabled = false; t.stop(); });
    this.encoder?.port.close();
    this.encoder?.disconnect();
    this.input?.disconnect();
    this.ws?.close();
    clearInterval(this.heartbeat);
    if (this.context?.state !== 'closed') void this.context?.close();
    this.callbacks.status('Stopped');
  }
}
