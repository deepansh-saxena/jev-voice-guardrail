import { describe, expect, it } from 'vitest';
import { AudioPauseDetector } from '../shared/audio-pause';
import { defaultSessionSettings, sessionSettingsSchema } from '../shared/session-settings';
import { clientMessageSchema, evalRequestSchema } from '../shared/protocol';
const audio = (ms: number, value: number) => new Float32Array(ms * 24).fill(value);
describe('sample-clock assistant audio pauses', () => {
  it('ignores initial silence, low noise and short transients; emits once after voiced silence', () => {
    const d = new AudioPauseDetector(24000, 500);
    expect(d.push(audio(500, 0))).toEqual([]);
    expect(d.push(audio(500, 0.005))).toEqual([]);
    expect(d.push(audio(50, 0.2))).toEqual([]);
    expect(d.push(audio(500, 0))).toEqual([]);
    expect(d.push(audio(100, 0.021))).toEqual([]);
    expect(d.push(audio(490, 0))).toEqual([]);
    expect(d.push(audio(10, 0))).toHaveLength(1);
    expect(d.push(audio(2000, 0))).toEqual([]);
    d.push(audio(100, 0.03));
    expect(d.push(audio(500, 0))).toHaveLength(1);
  });
  it('uses hysteresis and resets silence on resumed speech', () => {
    const d = new AudioPauseDetector(24000, 200);
    d.push(audio(100, 0.03));
    expect(d.push(audio(500, 0.015))).toEqual([]);
    d.push(audio(190, 0)); d.push(audio(10, 0.03));
    expect(d.push(audio(190, 0))).toEqual([]);
    expect(d.push(audio(10, 0))).toHaveLength(1);
  });
  it('is invariant to sample chunk boundaries and ignores wall-clock/network gaps', () => {
    const all = new Float32Array([...audio(120, 0.1), ...audio(500, 0), ...audio(120, 0.1), ...audio(500, 0)]);
    const full = new AudioPauseDetector(24000, 500).push(all);
    const split = new AudioPauseDetector(24000, 500);
    const result: number[] = [];
    for (let i = 0; i < all.length; i += 127) result.push(...split.push(all.subarray(i, i + 127)));
    expect(result).toEqual(full);
    expect(result).toHaveLength(2);
  });
  it('detects held native PCM before playback and enforces valid inputs', () => {
    const pcm = Buffer.alloc(24000 * 2);
    for (let i = 0; i < 2400; i++) pcm.writeInt16LE(4000, i * 2);
    expect(new AudioPauseDetector(24000, 500).pushPcm16(pcm)).toEqual([600]);
    expect(() => new AudioPauseDetector(0, 500)).toThrow();
    expect(() => new AudioPauseDetector(24000, 99)).toThrow();
    expect(() => new AudioPauseDetector(24000, 500).push([NaN])).toThrow();
  });
});
describe('validated live settings and real-only evaluation', () => {
  it.each([NaN, Infinity, 99, 2001, 500.5])('rejects invalid silence and cadence values %s', value => {
    for (const field of ['inputSilenceMs', 'outputIntervalMs', 'assistantPauseMs'])
      expect(sessionSettingsSchema.safeParse({ ...defaultSessionSettings, [field]: value }).success).toBe(false);
  });
  it('keeps defaults for older clients, never accepts an old simulator request', () => {
    const parsed = clientMessageSchema.parse({ type: 'connect-gated', outputMode: 'gated', provider: 'jev', mode: 'normal' });
    expect(parsed).toHaveProperty('settings', defaultSessionSettings);
    expect(evalRequestSchema.safeParse({ source: 'fixture', split: 'all' }).success).toBe(false);
    expect(evalRequestSchema.safeParse({ source: 'provider-replay', split: 'all' }).success).toBe(true);
  });
});
