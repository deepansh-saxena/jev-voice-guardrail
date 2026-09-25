import { decodePcm, PCM_SAMPLE_RATE, PcmResponseBuffer, type AudioPartId, type AudioPartSummary } from '../shared/audio';
import type { AudioIdentity } from '../shared/protocol';

interface HeldAudio {
  identity: AudioIdentity;
  buffer: PcmResponseBuffer;
  revision?: number;
  source?: AudioBufferSourceNode;
  startedAt: number;
}
export interface GatedPlayerCallbacks {
  started: (identity: AudioIdentity) => void;
  ended: (identity: AudioIdentity) => void;
  energy: (identity: AudioIdentity, heldMs: number) => void;
}
export class GatedPlayer {
  private held?: HeldAudio;
  private gate: GainNode;
  private analyser: AnalyserNode;
  private frame?: number;
  private disposed = false;
  constructor(private context: AudioContext, private callbacks: GatedPlayerCallbacks) {
    this.gate = context.createGain();
    this.gate.gain.value = 0;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.gate.connect(this.analyser);
    this.analyser.connect(context.destination);
  }
  private matches(identity: AudioIdentity) {
    const current = this.held?.identity;
    return current?.responseId === identity.responseId && current.requestId === identity.requestId && current.turn === identity.turn;
  }
  begin(identity: AudioIdentity) {
    if (this.disposed) return;
    if (this.held) throw new Error('Overlapping native responses cannot share an audio buffer.');
    this.held = { identity, buffer: new PcmResponseBuffer(), startedAt: performance.now() };
  }
  append(responseId: string, part: AudioPartId, data: string) {
    if (this.held?.identity.responseId === responseId) this.held.buffer.append(part, decodePcm(data));
  }
  finishPart(responseId: string, part: AudioPartId) {
    if (this.held?.identity.responseId === responseId) this.held.buffer.finishPart(part);
  }
  complete(identity: AudioIdentity, revision: number, parts: AudioPartSummary[]) {
    if (!this.matches(identity)) return;
    this.held!.buffer.seal(parts);
    this.held!.revision = revision;
  }
  release(identity: AudioIdentity, revision: number): boolean {
    if (this.disposed || !this.matches(identity)) return false;
    const held = this.held!;
    if (held.source || (held.revision !== undefined && held.revision !== revision)) return false;
    if (held.revision === undefined) throw new Error('Native audio release arrived before complete media collection.');
    if (this.context.state !== 'running') throw new Error('Audio playback is suspended. Allow audio and start a new session.');
    const samples = held.buffer.toFloat32();
    const audio = this.context.createBuffer(1, samples.length, PCM_SAMPLE_RATE);
    audio.getChannelData(0).set(samples);
    held.buffer.discard();
    const source = this.context.createBufferSource();
    held.source = source;
    source.buffer = audio;
    source.connect(this.gate);
    source.onended = () => {
      if (this.held !== held || this.disposed) return;
      this.gate.gain.value = 0;
      source.disconnect();
      this.held = undefined;
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.callbacks.ended(identity);
    };
    this.gate.gain.value = 1;
    source.start();
    this.callbacks.started(identity);
    const measure = () => {
      if (this.held !== held || this.disposed) return;
      const values = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(values);
      const energy = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
      if (energy > 0.015) this.callbacks.energy(identity, performance.now() - held.startedAt);
      else this.frame = requestAnimationFrame(measure);
    };
    this.frame = requestAnimationFrame(measure);
    return true;
  }
  cancel() {
    this.gate.gain.value = 0;
    const held = this.held;
    this.held = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    if (held?.source) {
      held.source.onended = null;
      held.source.stop();
      held.source.disconnect();
    }
    held?.buffer.discard();
  }
  dispose() {
    this.cancel();
    this.disposed = true;
    this.gate.disconnect();
    this.analyser.disconnect();
  }
}
