import { describe, expect, it } from 'vitest';
import { decodePcm, MAX_AUDIO_CHUNK_BYTES, MAX_OUTPUT_SAMPLES, PcmResponseBuffer } from '../shared/audio';

const first = { itemId: 'a1', outputIndex: 0, contentIndex: 0 };
const second = { itemId: 'a2', outputIndex: 1, contentIndex: 0 };
function pcm(values: number[]) {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setInt16(i * 2, value, true));
  return bytes;
}
describe('bounded native PCM response buffer', () => {
  it('keeps every sample from the beginning and orders complete audio parts', () => {
    const buffer = new PcmResponseBuffer();
    buffer.append(second, pcm([123, -123]));
    buffer.append(first, pcm([-32768, 0]));
    buffer.append(first, pcm([32767]));
    buffer.finishPart(second);
    buffer.finishPart(first);
    buffer.seal([{ ...first, samples: 3 }, { ...second, samples: 2 }]);
    expect([...buffer.toFloat32()]).toEqual([-1, 0, 32767 / 32768, 123 / 32768, -123 / 32768]);
  });
  it('never exposes playable samples before all audio parts complete and match', () => {
    const buffer = new PcmResponseBuffer();
    buffer.append(first, pcm([7, 8]));
    expect(() => buffer.toFloat32()).toThrow('not complete');
    expect(() => buffer.seal([{ ...first, samples: 2 }])).toThrow();
    buffer.finishPart(first);
    expect(() => buffer.seal([{ ...first, samples: 3 }])).toThrow();
    expect(() => buffer.seal([])).toThrow();
    buffer.seal([{ ...first, samples: 2 }]);
    expect(buffer.toFloat32()).toHaveLength(2);
  });
  it('does not mix independent responses and permanently invalidates discarded buffers', () => {
    const old = new PcmResponseBuffer();
    old.append(first, pcm([100]));
    old.finishPart(first);
    old.seal([{ ...first, samples: 1 }]);
    old.discard();
    const next = new PcmResponseBuffer();
    next.append(first, pcm([200]));
    next.finishPart(first);
    next.seal([{ ...first, samples: 1 }]);
    expect([...next.toFloat32()]).toEqual([200 / 32768]);
    expect(() => old.toFloat32()).toThrow();
    expect(() => old.append(first, pcm([300]))).toThrow();
    expect(old.samples).toBe(0);
  });
  it('fails on malformed, late or conflicting audio instead of silently truncating', () => {
    const buffer = new PcmResponseBuffer();
    expect(() => buffer.append(first, new Uint8Array(1))).toThrow();
    expect(() => buffer.append(first, new Uint8Array(MAX_AUDIO_CHUNK_BYTES + 2))).toThrow();
    buffer.append(first, pcm([1]));
    expect(() => buffer.append({ ...first, itemId: 'different' }, pcm([1]))).toThrow('Conflicting');
    buffer.finishPart(first);
    expect(() => buffer.append(first, pcm([1]))).toThrow('after its part completed');
    expect(() => buffer.finishPart(first)).toThrow();
  });
  it('enforces the exact 30-second memory bound', () => {
    const buffer = new PcmResponseBuffer();
    while (buffer.samples < MAX_OUTPUT_SAMPLES) {
      const bytes = Math.min(MAX_AUDIO_CHUNK_BYTES, (MAX_OUTPUT_SAMPLES - buffer.samples) * 2);
      buffer.append(first, new Uint8Array(bytes));
    }
    expect(buffer.samples).toBe(MAX_OUTPUT_SAMPLES);
    expect(() => buffer.append(first, pcm([0]))).toThrow('30-second');
  });
  it('validates canonical base64 and PCM sample alignment', () => {
    expect([...decodePcm(Buffer.from(pcm([-2, 7])).toString('base64'))]).toEqual([...pcm([-2, 7])]);
    for (const invalid of ['', '???', 'AA==', 'AAAA====', 'AA AA']) expect(() => decodePcm(invalid)).toThrow();
  });
});
