import { expect, it } from 'vitest';
import { PcmInputLimiter } from '../server/pcm-input';

const chunk = Buffer.alloc(960).toString('base64');

it('accepts uninterrupted native microphone audio', () => {
  let now = 0;
  const limiter = new PcmInputLimiter(() => now);
  for (let i = 0; i < 15000; i++) {
    now += 20;
    limiter.accept(chunk);
  }
});

it('accepts 1.6 seconds of valid PCM delivered together after a scheduling stall', () => {
  let now = 0;
  const limiter = new PcmInputLimiter(() => now);
  for (let i = 0; i < 50; i++) { now += 20; limiter.accept(chunk); }
  now += 1600;
  for (let i = 0; i < 80; i++) limiter.accept(chunk);
  for (let i = 0; i < 100; i++) { now += 20; limiter.accept(chunk); }
});

it('rejects unbounded bursts and sustained excessive input', () => {
  let now = 0;
  const limiter = new PcmInputLimiter(() => now);
  for (let i = 0; i < 100; i++) limiter.accept(chunk);
  expect(() => limiter.accept(chunk)).toThrow('2-second burst allowance');
  const fast = new PcmInputLimiter(() => now);
  expect(() => {
    for (let i = 0; i < 300; i++) { now += 10; fast.accept(chunk); }
  }).toThrow('2-second burst allowance');
});

it('does not bank unlimited capacity during silence', () => {
  let now = 0;
  const limiter = new PcmInputLimiter(() => now);
  now = 60000;
  for (let i = 0; i < 100; i++) limiter.accept(chunk);
  expect(() => limiter.accept(chunk)).toThrow('2-second burst allowance');
});

it('distinguishes malformed samples and oversized chunks', () => {
  const limiter = new PcmInputLimiter();
  expect(() => limiter.accept('not base64')).toThrow('Malformed');
  expect(() => limiter.accept(Buffer.alloc(3).toString('base64'))).toThrow('Malformed');
  expect(() => limiter.accept(Buffer.alloc(4802).toString('base64'))).toThrow('100 ms limit');
});
