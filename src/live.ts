import type { AgentMode } from '../shared/policies';
import type { ClientMessage, LabEvent, Provider, ServerMessage } from '../shared/protocol';
import { parseRealtime } from '../shared/realtime';
import { defaultSessionSettings, sessionSettingsSchema, type SessionSettings } from '../shared/session-settings';
import pauseWorkletUrl from './pause-worklet.ts?worker&url';
import type { Pricing } from '../shared/judge-cost';

export interface LiveCallbacks {
  event: (event: LabEvent) => void;
  status: (status: string) => void;
  error: (message: string) => void;
}
export class LiveCall {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private ws?: WebSocket;
  private stream?: MediaStream;
  private remoteRenderer = new Audio();
  private muted = true;
  private outputGain?: GainNode;
  private outputSource?: MediaStreamAudioSourceNode;
  private pauseNode?: AudioWorkletNode;
  private settings = defaultSessionSettings;
  private armedTurn?: number;
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private frame?: number;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastHeartbeat = performance.now();
  private stopped = false;
  private ready = false;
  private remoteReady = false;
  private currentInput?: string;
  private speaking = false;
  private speechEnd?: number;
  private armedId?: string;
  private authorizedRequests = new Set<string>();
  private responseId?: string;
  private playbackAt?: number;
  private transcriptAt?: number;
  private energyMeasured = false;
  private offsetMeasured = false;
  private startAt = performance.now();
  constructor(private callbacks: LiveCallbacks) {}

  async start(provider: Provider, mode: AgentMode, settings: SessionSettings = defaultSessionSettings, pricing?: Pricing) {
    try {
      this.settings = sessionSettingsSchema.parse(settings);
      if (!navigator.mediaDevices?.getUserMedia) {
        this.fail('Microphone API unavailable. Use a supported browser on localhost or HTTPS.');
        return;
      }
      this.callbacks.status('Requesting microphone');
      this.remoteRenderer.muted = true;
      this.audioContext = new AudioContext();
      await this.audioContext.resume();
      if (this.stopped) return;
      if (settings.outputCadence === 'pauses') {
        await this.audioContext.audioWorklet.addModule(pauseWorkletUrl);
        if (this.stopped) return;
        this.pauseNode = new AudioWorkletNode(this.audioContext, 'relay-assistant-pauses', {
          channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
        });
        this.pauseNode.connect(this.audioContext.destination); // Detector output is always zero.
        this.pauseNode.onprocessorerror = () => this.fail('Assistant acoustic pause detection failed. Start a new call.');
        this.pauseNode.port.onmessage = ({ data }: MessageEvent<Omit<Extract<ClientMessage, { type: 'assistant-pause' }>, 'type'>>) => {
          if (!this.stopped && !this.muted && !this.speaking && data.responseId === this.responseId && data.requestId === this.armedId)
            this.send({ type: 'assistant-pause', ...data });
        };
      }
      this.outputGain = this.audioContext.createGain();
      this.outputGain.gain.value = 0;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getTracks().forEach(track => { track.enabled = false; });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      pc.ontrack = event => {
        if (this.stopped) { event.track.stop(); return; }
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        // Chromium needs a playing media renderer to pull remote WebRTC audio into Web Audio.
        // This renderer stays muted; only the guardrail-controlled gain can reach speakers.
        this.remoteRenderer.srcObject = remote;
        void this.remoteRenderer.play().catch(() => this.fail('Browser audio playback could not start. Allow sound for this site, then start a new call.'));
        if (this.audioContext && this.outputGain) {
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 512;
          this.outputSource = this.audioContext.createMediaStreamSource(remote);
          this.outputSource.connect(this.outputGain);
          if (this.pauseNode) this.outputSource.connect(this.pauseNode);
          this.outputGain.connect(this.analyser);
          this.analyser.connect(this.audioContext.destination);
          this.measureEnergy();
        }
      };
      pc.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState) && !this.stopped)
          this.fail(`WebRTC ${pc.connectionState}. Microphone and audio stopped.`);
      };
      this.dc = pc.createDataChannel('relay-events', { ordered: true });
      this.dc.onopen = () => this.enableMic();
      this.dc.onclose = () => { if (!this.stopped) this.fail('Realtime data channel closed. Call stopped.'); };
      this.dc.onerror = () => this.fail('Realtime data channel failed. Call stopped.');
      this.dc.onmessage = event => {
        if (this.stopped) return;
        try {
          const realtime = parseRealtime(JSON.parse(event.data));
          if (!realtime) return;
          switch (realtime.type) {
            case 'input_audio_buffer.speech_started': {
              const before = performance.now();
              this.setMuted(true);
              this.armedId = undefined;
              this.currentInput = realtime.item_id;
              this.speaking = true;
              this.speechEnd = undefined;
              this.metric('local-barge-in-mute', performance.now() - before);
              this.send({ type: 'barge-in', itemId: realtime.item_id });
              break;
            }
            case 'input_audio_buffer.speech_stopped':
              if (this.currentInput === realtime.item_id) { this.speaking = false; this.speechEnd = performance.now(); }
              break;
            case 'conversation.item.input_audio_transcription.completed':
              if (this.currentInput === realtime.item_id && this.speechEnd !== undefined)
                this.metric('transcription-event-delay', performance.now() - this.speechEnd);
              break;
            case 'response.created':
              if (realtime.response.metadata?.relay_request !== this.armedId) {
                const request = realtime.response.metadata?.relay_request;
                if (request && this.authorizedRequests.has(request)) break;
                this.fail('Unapproved response observed on the native channel. Audio stopped.');
                return;
              }
              this.responseId = realtime.response.id;
              this.energyMeasured = false;
              this.offsetMeasured = false;
              this.playbackAt = undefined;
              this.transcriptAt = undefined;
              break;
            case 'output_audio_buffer.started':
              if (realtime.response_id === this.responseId) {
                this.playbackAt = performance.now();
                if (!this.muted && this.armedId && this.armedTurn !== undefined) this.pauseNode?.port.postMessage({
                  identity: { responseId: this.responseId, requestId: this.armedId, turn: this.armedTurn }, pauseMs: this.settings.assistantPauseMs,
                });
                this.metric('playback-start-event', this.playbackAt - this.startAt);
                this.measureOffset();
              }
              break;
            case 'output_audio_buffer.stopped':
            case 'output_audio_buffer.cleared':
              if (realtime.response_id === this.responseId) {
                this.pauseNode?.port.postMessage({ pauseMs: this.settings.assistantPauseMs });
                this.metric('playback-stop-event', performance.now() - this.startAt);
              }
              break;
            case 'response.output_audio_transcript.delta':
              if (this.responseId === realtime.response_id && this.transcriptAt === undefined) {
                this.transcriptAt = performance.now();
                this.measureOffset();
              }
              break;
          }
        } catch { this.fail('Invalid Azure data-channel event. Call stopped.'); }
      };
      this.callbacks.status('Connecting native audio');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.stopped) return;
      this.lastHeartbeat = performance.now();
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => {
        if (this.stopped) { ws.close(); return; }
        this.send({ type: 'connect', outputMode: 'monitor', sdp: offer.sdp!,         provider, mode, settings: this.settings, pricing });
      };
      ws.onmessage = async event => {
        if (this.stopped) return;
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          if (message.type === 'heartbeat') { this.lastHeartbeat = performance.now(); return; }
          if (message.type === 'answer') {
            await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
            this.remoteReady = true;
            this.enableMic();
          } else if (message.type === 'ready') {
            this.ready = true;
            this.enableMic();
          } else if (message.type === 'event') this.callbacks.event(message.event);
          else if (message.type === 'fatal') this.fail(message.message);
          else if (message.type === 'arm') {
            if (this.currentInput !== message.inputItemId || this.speaking) return;
            this.armedId = message.requestId;
            this.armedTurn = message.turn;
            this.authorizedRequests.add(message.requestId);
            this.setMuted(false);
            this.send({ type: 'armed', requestId: message.requestId });
          } else if (message.type === 'mute') {
            const start = performance.now();
            this.setMuted(true);
            this.armedId = undefined;
            this.send({ type: 'muted', actionId: message.actionId, durationMs: performance.now() - start });
          }
        } catch { this.fail('Local control message or SDP answer failed. Call stopped.'); }
      };
      ws.onclose = () => { if (!this.stopped) this.fail('Local guardrail server disconnected. Microphone and audio stopped.'); };
      ws.onerror = () => this.fail('Cannot connect to the local guardrail server.');
      this.heartbeat = setInterval(() => {
        if (performance.now() - this.lastHeartbeat > 6500) this.fail('Local guardrail heartbeat lost. Microphone and audio stopped.');
      }, 1000);
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof DOMException
        ? error.name === 'NotAllowedError'
          ? 'Microphone permission denied. Allow microphone access for localhost, then start again.'
          : `Native media setup failed (${error.name}). Check microphone availability and browser WebRTC support.`
        : 'Microphone or native WebRTC setup failed. Check your device and browser permissions.');
    }
  }
  private enableMic() {
    if (this.stopped || !this.ready || !this.remoteReady || this.dc?.readyState !== 'open') return;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = true; });
    this.callbacks.status('Listening');
  }
  private send(message: ClientMessage) { if (!this.stopped && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  private setMuted(value: boolean) {
    this.muted = value;
    if (this.outputGain) this.outputGain.gain.value = value ? 0 : 1;
    if (value) this.pauseNode?.port.postMessage({ pauseMs: this.settings.assistantPauseMs });
  }
  private metric(name: Extract<ClientMessage, { type: 'metric' }>['name'], durationMs: number) {
    const atMs = performance.now() - this.startAt;
    this.send({ type: 'metric', name, durationMs, atMs, responseId: this.responseId });
    this.callbacks.event({ id: crypto.randomUUID(), source: 'live', clock: 'browser', kind: 'metric',
      name, durationMs, atMs, responseId: this.responseId, settings: this.settings, outputMode: 'monitor', transport: 'azure-webrtc-sideband' });
  }
  private measureOffset() {
    if (!this.offsetMeasured && this.transcriptAt !== undefined && this.playbackAt !== undefined) {
      this.offsetMeasured = true;
      this.metric('transcript-vs-playback-event-offset', this.transcriptAt - this.playbackAt);
    }
  }
  private measureEnergy() {
    if (this.stopped || !this.analyser) return;
    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    const energy = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    if (!this.muted && this.playbackAt !== undefined && !this.energyMeasured && energy > 0.015 && this.speechEnd !== undefined) {
      this.energyMeasured = true;
      this.metric('speech-end-to-audio-energy', performance.now() - this.speechEnd);
    }
    this.frame = requestAnimationFrame(() => this.measureEnergy());
  }
  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.callbacks.error(message);
  }
  stop() {
    if (this.stopped) return;
    this.setMuted(true);
    this.remoteRenderer.pause();
    this.remoteRenderer.srcObject = null;
    this.send({ type: 'stop' });
    this.stopped = true;
    this.stream?.getTracks().forEach(track => { track.enabled = false; track.stop(); });
    this.pc?.getReceivers().forEach(receiver => receiver.track?.stop());
    this.outputSource?.disconnect();
    this.pauseNode?.port.close();
    this.pauseNode?.disconnect();
    this.outputGain?.disconnect();
    this.analyser?.disconnect();
    this.dc?.close();
    this.pc?.close();
    this.ws?.close();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    clearInterval(this.heartbeat);
    if (this.audioContext?.state !== 'closed') void this.audioContext?.close();
    this.callbacks.status('Stopped');
  }
}
