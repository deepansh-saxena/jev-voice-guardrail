import { afterEach, expect, it, vi } from 'vitest';
import { GuardrailEngine } from '../server/engine';
import { bounded } from '../server/async';
import { parseRealtime } from '../shared/realtime';
import type { ServerMessage } from '../shared/protocol';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('allows input more time without changing the output deadline or authorizing a timed-out turn', async () => {
  vi.useFakeTimers();
  const messages: ServerMessage[] = [];
  const provider = vi.fn();
  const engine = new GuardrailEngine(() => new Promise(() => {}), {
    browser: e => messages.push(e), provider,
  }, 4000, 'monitor', undefined, 10000);
  engine.receive({ type: 'input_audio_buffer.speech_started', item_id: 'u' });
  engine.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'Pause Relay.' });
  await vi.advanceTimersByTimeAsync(4001);
  expect(messages.some(e => e.type === 'event' && e.event.kind === 'error')).toBe(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(messages.some(e => e.type === 'event' && e.event.recoverable && e.event.name.includes('10000 ms'))).toBe(true);
  expect(messages.some(e => e.type === 'arm' || e.type === 'fatal')).toBe(false);
  expect(provider.mock.calls.some(([e]) => e.type === 'response.create')).toBe(false);
  engine.close();
});

it('identifies voice setup timeouts separately from judge failures', async () => {
  vi.useFakeTimers();
  const result = expect(bounded(() => new Promise(() => {}), 20, undefined, 'Azure native audio setup'))
    .rejects.toThrow('Azure native audio setup: timed out after 20 ms.');
  await vi.advanceTimersByTimeAsync(21);
  await result;
});

it('retains recognized completion reasons but discards raw provider details', () => {
  const parsed = parseRealtime({ type: 'response.done', response: { id: 'r', status: 'incomplete',
    status_details: { reason: 'max_output_tokens', error: { message: 'private payload' } } } });
  expect(JSON.stringify(parsed)).toContain('max_output_tokens');
  expect(JSON.stringify(parsed)).not.toContain('private payload');
});
