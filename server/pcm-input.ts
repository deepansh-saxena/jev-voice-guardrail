import { decodePcm, PCM_SAMPLE_RATE } from '../shared/audio';

const BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
const BURST_BYTES = BYTES_PER_SECOND * 2;

// AudioWorklet messages can arrive together after an event-loop stall. Allow
// bounded catch-up while still limiting sustained input to the native PCM rate.
export class PcmInputLimiter {
  private available = BURST_BYTES;
  private updatedAt: number;
  constructor(private now = () => performance.now()) { this.updatedAt = now(); }

  accept(data: string) {
    let bytes: Uint8Array;
    try { bytes = decodePcm(data); }
    catch { throw new Error('Malformed native PCM input. Call stopped.'); }
    if (!bytes.byteLength || bytes.byteLength > 4800)
      throw new Error('Native PCM input chunk exceeds the 100 ms limit. Call stopped.');
    const now = this.now();
    this.available = Math.min(BURST_BYTES, this.available + Math.max(0, now - this.updatedAt) * BYTES_PER_SECOND / 1000);
    this.updatedAt = now;
    if (bytes.byteLength > this.available)
      throw new Error('Native microphone backlog exceeded the 2-second burst allowance. Call stopped; start a new session.');
    this.available -= bytes.byteLength;
  }
}
