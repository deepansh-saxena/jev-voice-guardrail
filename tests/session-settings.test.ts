import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultSessionSettings } from '../shared/session-settings';
const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    readyState = 1; bufferedAmount = 0;
    constructor() { super(); setTimeout(() => this.emit('open'), 0); }
    send(raw: string) {
      const event = JSON.parse(raw); sent.push(event);
      if (event.type === 'session.update') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated', session: event.session }))));
    }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('wires the same custom user silence and disabled response gates through both native transports', async () => {
  vi.stubEnv('AZURE_OPENAI_API_KEY', 'test-only-key');
  vi.stubEnv('AZURE_TRANSCRIPTION_DEPLOYMENT', 'test-transcribe');
  vi.stubEnv('AZURE_REALTIME_ENDPOINT', 'https://example.invalid/openai/v1/realtime?model=test-voice');
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ value: 'test-ephemeral-value' })))
    .mockResolvedValueOnce(new Response('v=0\r\ntest-sdp', { status: 201, headers: { location: '/openai/v1/realtime/calls/test-call' } })));
  const { connectAzure, sessionConfig } = await import('../server/azure');
  const { connectGatedAzure } = await import('../server/azure-gated');
  const settings = { ...defaultSessionSettings, inputSilenceMs: 1200 };
  const signal = new AbortController().signal;
  const fail = vi.fn();
  const rtc = await connectAzure('v=0\r\ntest-offer', 'normal', signal, () => {}, fail, settings);
  const pcm = await connectGatedAzure('normal', signal, () => {}, fail, settings);
  expect(sent).toHaveLength(2);
  for (const event of sent) expect(event).toMatchObject({ session: { audio: { input: { turn_detection: {
    type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1200,
    create_response: false, interrupt_response: false,
  } } } } });
  expect(sessionConfig('stress').audio.input.turn_detection.silence_duration_ms).toBe(500);
  expect(() => sessionConfig('normal', { ...settings, inputSilenceMs: NaN })).toThrow();
  rtc.close(); pcm.close(); expect(fail).not.toHaveBeenCalled();
});
