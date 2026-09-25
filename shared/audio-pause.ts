// Sample-clock energy detection, not text punctuation or wall-clock packet spacing.
export class AudioPauseDetector {
  private frameSamples: number;
  private sum = 0;
  private frameCount = 0;
  private samples = 0;
  private voicedSamples = 0;
  private silentSamples = 0;
  private voiced = false;
  constructor(private sampleRate: number, private pauseMs: number) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000
      || !Number.isInteger(pauseMs) || pauseMs < 100 || pauseMs > 2000)
      throw new Error('Invalid audio pause detector configuration.');
    this.frameSamples = Math.round(sampleRate / 100);
  }
  private sample(value: number): number | undefined {
    if (!Number.isFinite(value)) throw new Error('Invalid acoustic sample.');
    this.sum += value * value;
    this.frameCount++;
    this.samples++;
    if (this.frameCount < this.frameSamples) return;
    const rms = Math.sqrt(this.sum / this.frameCount);
    const count = this.frameCount;
    this.sum = 0; this.frameCount = 0;
    if (rms >= (this.voiced ? 0.01 : 0.02)) {
      this.voicedSamples += count;
      this.silentSamples = 0;
      if (this.voicedSamples >= this.sampleRate * 0.1) this.voiced = true;
    } else if (this.voiced) {
      this.silentSamples += count;
      if (this.silentSamples >= this.sampleRate * this.pauseMs / 1000) {
        this.voiced = false; this.voicedSamples = 0; this.silentSamples = 0;
        return this.samples / this.sampleRate * 1000;
      }
    } else this.voicedSamples = 0;
  }
  push(samples: ArrayLike<number>): number[] {
    const pauses: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      const at = this.sample(samples[i]);
      if (at !== undefined) pauses.push(at);
    }
    return pauses;
  }
  pushPcm16(bytes: Uint8Array): number[] {
    if (bytes.byteLength % 2) throw new Error('Unaligned acoustic PCM samples.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pauses: number[] = [];
    for (let i = 0; i < bytes.byteLength; i += 2) {
      const at = this.sample(view.getInt16(i, true) / 32768);
      if (at !== undefined) pauses.push(at);
    }
    return pauses;
  }
}
