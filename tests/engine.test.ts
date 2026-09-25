import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailEngine } from '../server/engine';
import { phasePolicies, recovery, type Phase } from '../shared/policies';
import { aggregate, type Decision, type JudgeInput, type ServerMessage, type Verdict } from '../shared/protocol';
import type { RealtimeEvent } from '../shared/realtime';
import { defaultSessionSettings, type SessionSettings } from '../shared/session-settings';

function verdict(phase: Phase, decision: Decision = 'allow'): Verdict {
  const policies = phasePolicies(phase).map((p, i) => ({ policy: p.id, decision: i === 0 ? decision : 'allow' as const }));
  return { provider: 'jev', source: 'live', model: 'test-double', policies, decision: aggregate(policies), serviceMs: 5 };
}
function pending<T>() { let resolve!: (v: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (v: T) => resolve(v) }; }
function harness(implementation = async (i: JudgeInput) => verdict(i.phase), settings: SessionSettings = defaultSessionSettings) {
  const provider: Record<string, unknown>[] = [];
  const browser: ServerMessage[] = [];
  const judge = vi.fn(implementation);
  const engine = new GuardrailEngine(judge, { provider: e => provider.push(e), browser: m => browser.push(m), now: () => Date.now()   }, 1000, 'monitor', settings);
  const arm = () => browser.filter((m): m is Extract<ServerMessage, { type: 'arm' }> => m.type === 'arm').at(-1)!;
  const user = (id = 'user1', text = 'Help with Relay.') => {
    engine.receive({ type: 'input_audio_buffer.speech_started', item_id: id });
    engine.receive({ type: 'input_audio_buffer.speech_stopped', item_id: id });
    engine.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
  };
  const respond = () => {
    engine.armed(arm().requestId);
    engine.receive({ type: 'response.created', response: { id: 'r1', status: 'in_progress', metadata: { relay_request: arm().requestId } } });
  };
  const delta = (text: string, item = 'a1', content = 0, output = 0) => engine.receive({
    type: 'response.output_audio_transcript.delta', response_id: 'r1', item_id: item, output_index: output, content_index: content, delta: text,
  });
  const finish = (text = 'Public Relay information.', status = 'completed') => engine.receive({
    type: 'response.done', response: { id: 'r1', status, output: [{ id: 'a1', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: text }] }] },
  });
  return { engine, judge, provider, browser, arm, user, respond, delta, finish };
}
describe('response gating and live interruption lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('complete-only skips all partials and checks the complete normal response exactly once', async () => {
    const h = harness(undefined, { ...defaultSessionSettings, outputCadence: 'complete' });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Unfinished');
    h.engine.receive({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'a1', output_index: 0, content_index: 0, transcript: 'Part complete' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.judge).toHaveBeenCalledTimes(1);
    h.finish('Authoritative final text'); await vi.advanceTimersByTimeAsync(0);
    expect(h.judge.mock.calls.at(-1)?.[0]).toMatchObject({ text: 'Authoritative final text', final: true });
    h.finish('Authoritative final text'); await vi.advanceTimersByTimeAsync(1000);
    expect(h.judge).toHaveBeenCalledTimes(2);
    h.engine.close();
  });
  it('pause timing ignores stale/duplicate markers and coalesces a pause awaiting transcript text', async () => {
    const h = harness(undefined, { ...defaultSessionSettings, outputCadence: 'pauses' });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond();
    h.engine.assistantPause('old', h.arm().requestId, 1, 1, 500);
    h.delta('Current'); await vi.advanceTimersByTimeAsync(1000);
    expect(h.judge).toHaveBeenCalledTimes(1);
    h.engine.assistantPause('r1', h.arm().requestId, 1, 1, 600);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.judge).toHaveBeenCalledTimes(2);
    h.engine.assistantPause('r1', h.arm().requestId, 1, 1, 600);
    h.delta(' updated'); await vi.advanceTimersByTimeAsync(0);
    expect(h.judge).toHaveBeenCalledTimes(2);
    h.engine.assistantPause('r1', h.arm().requestId, 1, 2, 1200);
    await vi.advanceTimersByTimeAsync(0);
    h.engine.assistantPause('r1', h.arm().requestId, 1, 3, 1800);
    h.delta(' after pause'); await vi.advanceTimersByTimeAsync(0);
    expect(h.judge.mock.calls.at(-1)?.[0].text).toBe('Current updated after pause');
    h.finish('Full response'); await vi.advanceTimersByTimeAsync(0);
    expect(h.judge.mock.calls.at(-1)?.[0]).toMatchObject({ final: true, text: 'Full response' });
    h.engine.close();
  });
  it('uses the configured periodic interval and always flushes final without a pause', async () => {
    const h = harness(undefined, { ...defaultSessionSettings, outputIntervalMs: 1000 });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Some text');
    await vi.advanceTimersByTimeAsync(999); expect(h.judge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.judge).toHaveBeenCalledTimes(2);
    h.finish('Full text'); await vi.advanceTimersByTimeAsync(0);
    expect(h.judge.mock.calls.at(-1)?.[0]).toMatchObject({ final: true });
    h.engine.close();
  });
  it('never creates a response before a final input verdict AND browser acknowledgment', async () => {
    const request = pending<Verdict>();
    const h = harness(() => request.promise);
    h.user();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.provider).toEqual([]);
    request.resolve(verdict('input'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.arm()).toBeDefined();
    expect(h.provider).toEqual([]);
    h.engine.armed(h.arm().requestId);
    expect(h.provider[0]).toMatchObject({ type: 'response.create', response: { input: [{ type: 'item_reference', id: 'user1' }] } });
    h.engine.close();
  });
  it.each(['violate', 'uncertain'] as const)('uses an isolated fixed recovery for input %s', async decision => {
    const h = harness(async i => verdict(i.phase, decision));
    h.user();
    await vi.advanceTimersByTimeAsync(0);
    h.engine.armed(h.arm().requestId);
    expect(h.provider[0]).toMatchObject({ response: { input: [], tools: [] } });
    expect(JSON.stringify(h.provider[0])).toContain(decision === 'violate' ? recovery.scope : recovery.uncertain);
    h.engine.close();
  });
  it('drops stale input approvals and out-of-order transcripts', async () => {
    const request = pending<Verdict>();
    const h = harness(() => request.promise);
    h.user('user1');
    await vi.advanceTimersByTimeAsync(0);
    h.engine.speechStarted('user2');
    h.engine.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user1', transcript: 'late correction' });
    request.resolve(verdict('input'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.browser.some(m => m.type === 'arm')).toBe(false);
    expect(h.provider).toEqual([]);
    h.engine.close();
  });
  it('deduplicates browser/sideband speech starts and final transcriptions', async () => {
    const h = harness();
    h.engine.speechStarted('user1'); h.user('user1'); h.user('user1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.judge).toHaveBeenCalledTimes(1);
    expect(h.arm().turn).toBe(1);
    h.engine.close();
  });
  it('invalidates a queued arm when a newer user starts speaking', async () => {
    const h = harness(); h.user(); await vi.advanceTimersByTimeAsync(0);
    const arm = h.arm(); h.engine.speechStarted('user2'); h.engine.armed(arm.requestId);
    expect(h.provider).toEqual([]);
    h.engine.close();
  });
  it('cancels a response whose creation raced a new speech turn', async () => {
    const h = harness(); h.user(); await vi.advanceTimersByTimeAsync(0);
    h.engine.armed(h.arm().requestId); h.engine.speechStarted('user2');
    h.engine.receive({ type: 'response.created', response: { id: 'late', status: 'in_progress', metadata: { relay_request: h.arm().requestId } } });
    expect(h.provider.some(e => e.type === 'response.cancel' && e.response_id === 'late')).toBe(true);
    expect(h.browser.some(m => m.type === 'mute')).toBe(true);
    h.engine.close();
  });
  it('accumulates response parts in output/content order and ignores deltas after final text', async () => {
    const h = harness(); h.user(); await vi.advanceTimersByTimeAsync(0); h.respond();
    h.delta('Second', 'a2', 0, 1); h.delta('First', 'a1');
    h.engine.receive({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'a1', output_index: 0, content_index: 0, transcript: 'First final' });
    h.delta('stale suffix', 'a1');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.judge.mock.calls.filter(c => c[0].phase === 'output').at(-1)?.[0].text).toBe('First final\nSecond');
    h.engine.close();
  });
  it('checks only new text and flushes final output without waiting another 200ms', async () => {
    const h = harness(); h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Hello');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.judge).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(h.judge).toHaveBeenCalledTimes(2);
    h.finish('Hello final');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.judge.mock.calls.at(-1)?.[0]).toMatchObject({ text: 'Hello final', final: true });
    h.engine.close();
  });
  it('handles late violation after generation ends while playback may still run', async () => {
    const output = pending<Verdict>();
    const h = harness(i => i.phase === 'input' ? Promise.resolve(verdict('input')) : output.promise);
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Restricted');
    await vi.advanceTimersByTimeAsync(200); h.finish('Restricted final');
    output.resolve(verdict('output', 'violate')); await vi.advanceTimersByTimeAsync(0);
    expect(h.browser.some(m => m.type === 'mute')).toBe(true);
    expect(h.provider.some(e => e.type === 'output_audio_buffer.clear')).toBe(true);
    expect(h.provider.some(e => e.type === 'response.cancel')).toBe(false);
    h.engine.close();
  });
  it('waits for mute, cancel completion, buffer clear and context deletion before recovery', async () => {
    const h = harness(async i => verdict(i.phase, i.phase === 'output' ? 'violate' : 'allow'));
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Restricted');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.provider.some(e => e.type === 'response.cancel')).toBe(true);
    expect(h.provider.some(e => e.type === 'output_audio_buffer.clear')).toBe(false);
    const mute = h.browser.find((m): m is Extract<ServerMessage, { type: 'mute' }> => m.type === 'mute')!;
    h.engine.muted(mute.actionId, 0.2);
    h.finish('Restricted', 'cancelled');
    expect(h.provider.filter(e => e.type === 'output_audio_buffer.clear')).toHaveLength(1);
    h.engine.receive({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
    expect(h.browser.filter(m => m.type === 'arm')).toHaveLength(1);
    h.engine.receive({ type: 'conversation.item.deleted', item_id: 'a1' });
    expect(h.browser.filter(m => m.type === 'arm')).toHaveLength(2);
    h.engine.armed(h.arm().requestId);
    expect(h.provider.filter(p => p.type === 'response.create').at(-1)).toMatchObject({ response: { input: [] } });
    h.engine.close();
  });
  it('clears only after cancellation so late generated audio cannot survive into recovery', async () => {
    const h = harness(async i => verdict(i.phase, i.phase === 'output' ? 'violate' : 'allow'));
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Restricted');
    await vi.advanceTimersByTimeAsync(200);
    const mute = h.browser.find((m): m is Extract<ServerMessage, { type: 'mute' }> => m.type === 'mute')!;
    h.engine.muted(mute.actionId, 0);
    h.engine.receive({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
    h.engine.receive({ type: 'output_audio_buffer.started', response_id: 'r1' });
    expect(h.provider.some(e => e.type === 'output_audio_buffer.clear')).toBe(false);
    expect(h.provider.some(e => e.type === 'conversation.item.delete')).toBe(false);
    h.finish('Restricted', 'cancelled');
    h.finish('Restricted', 'cancelled');
    expect(h.provider.filter(e => e.type === 'output_audio_buffer.clear')).toHaveLength(1);
    h.engine.receive({ type: 'conversation.item.deleted', item_id: 'a1' });
    expect(h.browser.filter(m => m.type === 'arm')).toHaveLength(1);
    h.engine.receive({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
    expect(h.browser.filter(m => m.type === 'arm')).toHaveLength(2);
    h.engine.close();
  });
  it('ignores output verdicts superseded by user interruption and does not loop recovery', async () => {
    const out = pending<Verdict>();
    const h = harness(i => i.phase === 'input' ? Promise.resolve(verdict('input')) : out.promise);
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Some text');
    await vi.advanceTimersByTimeAsync(200);
    h.engine.speechStarted('user2'); out.resolve(verdict('output', 'violate'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.browser.filter(m => m.type === 'event' && m.event.name.startsWith('Output violate'))).toHaveLength(0);
    h.engine.close();
  });
  it('stays muted and fails closed when cancellation completion never arrives', async () => {
    const h = harness(async i => verdict(i.phase, i.phase === 'output' ? 'violate' : 'allow'));
    h.user(); await vi.advanceTimersByTimeAsync(0); h.respond(); h.delta('Restricted');
    await vi.advanceTimersByTimeAsync(200);
    const mute = h.browser.find((m): m is Extract<ServerMessage, { type: 'mute' }> => m.type === 'mute')!;
    h.engine.muted(mute.actionId, 0);
    await vi.advanceTimersByTimeAsync(6001);
    expect(h.browser.some(m => m.type === 'fatal')).toBe(true);
    expect(h.browser.filter(m => m.type === 'arm')).toHaveLength(1);
    expect(h.provider.some(e => e.type === 'output_audio_buffer.clear')).toBe(false);
    h.finish('Restricted', 'cancelled');
    expect(h.browser.filter(m => m.type === 'arm')).toHaveLength(1);
  });
  it('fails closed on input timeout without counting an outage as a detection', async () => {
    const h = harness(() => new Promise(() => {})); h.user();
    await vi.advanceTimersByTimeAsync(1001);
    expect(h.browser.some(m => m.type === 'fatal')).toBe(true);
    expect(h.provider.some(e => e.type === 'response.create')).toBe(false);
    expect(h.browser.some(m => m.type === 'event' && m.event.kind === 'check-end')).toBe(false);
  });
  it('fails closed on missing live output transcripts', async () => {
    const h = harness(); h.user(); await vi.advanceTimersByTimeAsync(0); h.respond();
    h.engine.receive({ type: 'output_audio_buffer.started', response_id: 'r1' });
    await vi.advanceTimersByTimeAsync(1501);
    expect(h.browser.some(m => m.type === 'fatal')).toBe(true);
  });
  it('stops on malformed provider errors, unexpected responses or changed auto-response config', () => {
    const events: RealtimeEvent[] = [
      { type: 'error', error: { code: 'bad_event' } },
      { type: 'response.created', response: { id: 'unknown', status: 'in_progress' } },
      { type: 'session.updated', session: { audio: { input: { turn_detection: { create_response: true, interrupt_response: false }, transcription: { model: 'transcribe' } } } } },
    ];
    for (const event of events) {
      const h = harness(); h.engine.receive(event);
      expect(h.browser.some(m => m.type === 'fatal')).toBe(true);
    }
  });
  it('does not process callbacks or issue responses after close', async () => {
    const request = pending<Verdict>(); const h = harness(() => request.promise);
    h.user(); await vi.advanceTimersByTimeAsync(0); h.engine.close();
    request.resolve(verdict('input')); await vi.advanceTimersByTimeAsync(2000);
    expect(h.browser.some(m => m.type === 'arm')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
