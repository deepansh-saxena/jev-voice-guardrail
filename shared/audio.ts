export const PCM_SAMPLE_RATE = 24000;
export const MAX_OUTPUT_SECONDS = 30;
export const MAX_OUTPUT_SAMPLES = PCM_SAMPLE_RATE * MAX_OUTPUT_SECONDS;
export const MAX_AUDIO_PARTS = 32;
export const MAX_AUDIO_CHUNKS = 4096;
export const MAX_AUDIO_CHUNK_BYTES = 192000;

export interface AudioPartId {
  itemId: string;
  outputIndex: number;
  contentIndex: number;
}
export interface AudioPartSummary extends AudioPartId {
  samples: number;
}
export const audioPartKey = (part: AudioPartId) => `${part.outputIndex}:${part.itemId}:${part.contentIndex}`;

export function decodePcm(base64: string): Uint8Array {
  if (!base64.length || base64.length > MAX_AUDIO_CHUNK_BYTES / 3 * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
    throw new Error('Invalid or oversized native PCM audio chunk.');
  const binary = atob(base64);
  if (binary.length % 2) throw new Error('Native PCM audio chunk is not aligned to 16-bit samples.');
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

interface BufferedPart {
  id: AudioPartId;
  chunks: Uint8Array[];
  samples: number;
  done: boolean;
}

export class PcmResponseBuffer {
  private parts = new Map<string, BufferedPart>();
  private count = 0;
  private chunks = 0;
  private sealed = false;
  private discarded = false;
  get samples() { return this.count; }
  summaries(): AudioPartSummary[] { return [...this.parts.values()].map(part => ({ ...part.id, samples: part.samples })); }

  private writable() {
    if (this.discarded || this.sealed) throw new Error('Native response audio buffer is closed.');
  }
  private validatePart(id: AudioPartId) {
    if (!id.itemId || !Number.isInteger(id.outputIndex) || !Number.isInteger(id.contentIndex)
      || id.outputIndex < 0 || id.contentIndex < 0)
      throw new Error('Invalid native audio part identity.');
    for (const part of this.parts.values())
      if (part.id.outputIndex === id.outputIndex && part.id.itemId !== id.itemId)
        throw new Error('Conflicting native output item identity.');
  }
  append(id: AudioPartId, bytes: Uint8Array) {
    this.writable();
    this.validatePart(id);
    if (!bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > MAX_AUDIO_CHUNK_BYTES)
      throw new Error('Invalid native PCM audio chunk size.');
    const key = audioPartKey(id);
    let part = this.parts.get(key);
    if (part?.done) throw new Error('Native audio arrived after its part completed.');
    if (this.count + bytes.byteLength / 2 > MAX_OUTPUT_SAMPLES || this.chunks >= MAX_AUDIO_CHUNKS)
      throw new Error('Native response audio exceeded the 30-second buffer or chunk limit.');
    if (!part) {
      if (this.parts.size >= MAX_AUDIO_PARTS) throw new Error('Too many native response audio parts.');
      part = { id: { ...id }, chunks: [], samples: 0, done: false };
      this.parts.set(key, part);
    }
    part.chunks.push(bytes.slice());
    part.samples += bytes.byteLength / 2;
    this.count += bytes.byteLength / 2;
    this.chunks++;
  }
  finishPart(id: AudioPartId) {
    this.writable();
    const part = this.parts.get(audioPartKey(id));
    if (!part || part.done) throw new Error('Missing or duplicate native audio completion.');
    part.done = true;
  }
  seal(expected: AudioPartSummary[]) {
    this.writable();
    const seen = new Set<string>();
    if (!this.count || expected.length !== this.parts.size) throw new Error('Incomplete native response audio.');
    for (const id of expected) {
      const key = audioPartKey(id);
      const part = this.parts.get(key);
      if (seen.has(key) || !part?.done || part.samples !== id.samples)
        throw new Error('Native audio completion does not match the collected samples.');
      seen.add(key);
    }
    this.sealed = true;
  }
  toFloat32(): Float32Array {
    if (!this.sealed || this.discarded) throw new Error('Native audio is not complete or was discarded.');
    const samples = new Float32Array(this.count);
    let offset = 0;
    for (const part of [...this.parts.values()].sort((a, b) => a.id.outputIndex - b.id.outputIndex || a.id.contentIndex - b.id.contentIndex)) {
      for (const bytes of part.chunks) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < bytes.byteLength; i += 2) samples[offset++] = view.getInt16(i, true) / 32768;
      }
    }
    return samples;
  }
  discard() {
    this.discarded = true;
    this.parts.clear();
    this.count = 0;
    this.chunks = 0;
  }
}
