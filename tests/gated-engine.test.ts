import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailEngine } from '../server/engine';
import { phasePolicies, type Phase } from '../shared/policies';
import type { Decision, JudgeInput, ServerMessage, Verdict } from '../shared/protocol';
import type { Judge } from '../server/judges';
import { defaultSessionSettings, type SessionSettings } from '../shared/session-settings';

function verdict(phase: Phase, decision: Decision = 'allow'): Verdict {
  return { decision, provider: 'llm', model: 'test', source: 'live', serviceMs: 1,
    policies: phasePolicies(phase).map((p, i) => ({ policy: p.id, decision: i === 0 ? decision : 'allow' })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function harness(judge: Judge = async input => verdict(input.phase), settings: SessionSettings = defaultSessionSettings) {
  const browser: ServerMessage[] = [];
  const provider: Record<string, unknown>[] = [];
  const engine = new GuardrailEngine(judge, { browser: e => browser.push(e), provider: e => provider.push(e)   }, 1000, 'gated', settings);
  const arm = () => browser.filter((e): e is Extract<ServerMessage, { type: 'arm' }> => e.type === 'arm').at(-1)!;
  const user = (id = 'u1') => {
    engine.receive({ type: 'input_audio_buffer.speech_started', item_id: id });
    engine.receive({ type: 'input_audio_buffer.speech_stopped', item_id: id });
    engine.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: 'Help with Relay.' });
  };
  const response = (id = 'r1') => {
    engine.armed(arm().requestId);
    engine.receive({ type: 'response.created', response: { id, status: 'in_progress', metadata: { relay_request: arm().requestId } } });
  };
  const audio = (id = 'r1', done = true) => {
    const fields = { response_id: id, item_id: `a-${id}`, output_index: 0, content_index: 0 };
    engine.receive({ type: 'response.output_audio.delta', ...fields, delta: Buffer.alloc(4800).toString('base64') });
    if (done) engine.receive({ type: 'response.output_audio.done', ...fields });
  };
  const text = (value = 'Current Relay features.', id = 'r1') => engine.receive({
    type: 'response.output_audio_transcript.done', response_id: id, item_id: `a-${id}`,
    output_index: 0, content_index: 0, transcript: value,
  });
  const finish = (value = 'Current Relay features.', id = 'r1', status = 'completed') => engine.receive({
    type: 'response.done', response: { id, status, output: [{ id: `a-${id}`, type: 'message', role: 'assistant',
      content: [{ type: 'output_audio', transcript: value }] }] },
  });
  const released = () => browser.filter(e => e.type === 'audio-release');
  const cleanup = (id = 'r1') => {
    const mute = browser.findLast((e): e is Extract<ServerMessage, { type: 'mute' }> => e.type === 'mute')!;
    engine.muted(mute.actionId, 0);
    engine.receive({ type: 'conversation.item.deleted', item_id: `a-${id}` });
  };
  return { engine, browser, provider, arm, user, response, audio, text, finish, released, cleanup };
}
describe('whole-response native output gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('checks acoustic pauses in held PCM but cannot release until its separate final allow', async () => {
    const seen: JudgeInput[] = [];
    const h = harness(async input => { seen.push(input); return verdict(input.phase); }, { ...defaultSessionSettings, outputCadence: 'pauses' });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.text();
    const pcm = Buffer.alloc(14400 * 2);
    for (let i = 0; i < 2400; i++) pcm.writeInt16LE(4000, i * 2);
    const fields = { response_id: 'r1', item_id: 'a-r1', output_index: 0, content_index: 0 };
    h.engine.receive({ type: 'response.output_audio.delta', ...fields, delta: pcm.toString('base64') });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toMatchObject({ phase: 'output', final: false });
    expect(h.released()).toHaveLength(0);
    h.engine.receive({ type: 'response.output_audio.done', ...fields });
    h.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toMatchObject({ final: true });
    expect(h.released()).toHaveLength(1);
    h.engine.close();
  });
  it('complete-only never judges partial held text and flushes final even with no acoustic pause', async () => {
    const seen: JudgeInput[] = [];
    const h = harness(async input => { seen.push(input); return verdict(input.phase); }, { ...defaultSessionSettings, outputCadence: 'complete' });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.text(); h.audio();
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(1); expect(h.released()).toHaveLength(0);
    h.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(2); expect(seen[1].final).toBe(true); expect(h.released()).toHaveLength(1);
    h.engine.close();
  });
  it('requires completed audio, normal generation and the exact final allow before releasing once', async () => {
    const final = deferred<Verdict>();
    const h = harness(async input => input.phase === 'output' && input.final ? final.promise : verdict(input.phase));
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.audio(); h.text();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.released()).toHaveLength(0);
    h.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(h.browser.some(e => e.type === 'audio-complete')).toBe(true);
    expect(h.released()).toHaveLength(0);
    final.resolve(verdict('output')); await vi.advanceTimersByTimeAsync(0);
    expect(h.released()).toHaveLength(1);
    expect(h.browser.some(e => e.type === 'event' && e.event.name === 'Listening')).toBe(false);
    h.engine.localPlayback('r1', h.arm().requestId, 'started');
    expect(h.browser.some(e => e.type === 'event' && e.event.name === 'Listening')).toBe(false);
    h.engine.localPlayback('r1', h.arm().requestId, 'ended');
    expect(h.browser.some(e => e.type === 'event' && e.event.name === 'Listening')).toBe(true);
    expect(h.provider.some(e => e.type === 'output_audio_buffer.clear')).toBe(false);
    h.engine.close();
  });
  it('does not reuse an earlier allowed revision after the final transcript replaces it', async () => {
    const old = deferred<Verdict>();
    const seen: JudgeInput[] = [];
    const h = harness(input => {
      seen.push(input);
      return input.phase === 'output' && !input.final ? old.promise : Promise.resolve(verdict(input.phase, input.phase === 'output' ? 'violate' : 'allow'));
    });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.audio(); h.text('Safe prefix.');
    await vi.advanceTimersByTimeAsync(200);
    h.finish('Final restricted replacement.');
    old.resolve(verdict('output')); await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toMatchObject({ final: true, text: 'Final restricted replacement.' });
    expect(h.released()).toHaveLength(0);
    h.engine.close();
  });
  it.each(['violate', 'uncertain'] as const)('discards %s output and keeps native recovery behind its own final gate', async decision => {
    const finalRecovery = deferred<Verdict>();
    let recovery = false;
    const h = harness(input => {
      if (input.phase === 'input') return Promise.resolve(verdict('input'));
      if (!recovery) return Promise.resolve(verdict('output', decision));
      return input.final ? finalRecovery.promise : Promise.resolve(verdict('output'));
    });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.audio(); h.text();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.provider.some(e => e.type === 'response.cancel')).toBe(true);
    expect(h.provider.some(e => e.type === 'conversation.item.delete')).toBe(false);
    h.finish('Restricted', 'r1', 'cancelled'); h.cleanup();
    expect(h.released()).toHaveLength(0);
    recovery = true;
    h.response('r2'); h.audio('r2'); h.text('Safe redirect.', 'r2');
    await vi.advanceTimersByTimeAsync(200); h.finish('Safe redirect.', 'r2'); await vi.advanceTimersByTimeAsync(0);
    expect(h.released()).toHaveLength(0);
    finalRecovery.resolve(verdict('output')); await vi.advanceTimersByTimeAsync(0);
    expect(h.released()).toEqual([expect.objectContaining({ responseId: 'r2' })]);
    h.engine.close();
  });
  it('ignores late final approvals and playback acknowledgments after a new speech turn', async () => {
    const final = deferred<Verdict>();
    const h = harness(input => input.phase === 'input' ? Promise.resolve(verdict('input')) : final.promise);
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.audio(); h.finish();
    const oldRequest = h.arm().requestId;
    h.engine.speechStarted('u2');
    final.resolve(verdict('output')); await vi.advanceTimersByTimeAsync(0);
    h.engine.localPlayback('r1', oldRequest, 'started'); h.engine.localPlayback('r1', oldRequest, 'ended');
    expect(h.released()).toHaveLength(0);
    h.engine.close();
  });
  it.each(['missing-audio', 'missing-audio-done', 'generation-failed', 'malformed-audio', 'judge-error', 'judge-timeout'])('never releases %s', async failure => {
    const h = harness(async input => {
      if (input.phase === 'output' && failure === 'judge-error') throw new Error('Invalid judge result');
      if (input.phase === 'output' && failure === 'judge-timeout') return new Promise(() => {});
      return verdict(input.phase);
    });
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response();
    if (failure === 'malformed-audio') h.engine.receive({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a-r1', output_index: 0, content_index: 0, delta: '???' });
    else if (failure !== 'missing-audio') h.audio('r1', failure !== 'missing-audio-done');
    h.finish('Text', 'r1', failure === 'generation-failed' ? 'failed' : 'completed');
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.released()).toHaveLength(0);
    expect(h.browser.some(e => e.type === 'fatal')).toBe(true);
    h.engine.close();
  });
  it('terminates rejected recovery instead of bypassing the gate or retrying indefinitely', async () => {
    const h = harness(async input => verdict(input.phase, input.phase === 'output' ? 'violate' : 'allow'));
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.audio(); h.text();
    await vi.advanceTimersByTimeAsync(200); h.finish('Restricted', 'r1', 'cancelled'); h.cleanup();
    h.response('r2'); h.audio('r2'); h.text('Still restricted', 'r2');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.browser.some(e => e.type === 'fatal')).toBe(true);
    expect(h.released()).toHaveLength(0);
    expect(h.provider.filter(e => e.type === 'response.create')).toHaveLength(2);
  });
  it('requires a complete transcript for every audio part, not just one nonempty transcript', async () => {
    const h = harness();
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.audio();
    const fields = { response_id: 'r1', item_id: 'a-r1', output_index: 0, content_index: 1 };
    h.engine.receive({ type: 'response.output_audio.delta', ...fields, delta: Buffer.alloc(4800).toString('base64') });
    h.engine.receive({ type: 'response.output_audio.done', ...fields });
    h.engine.receive({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [{
      id: 'a-r1', type: 'message', role: 'assistant',
      content: [{ type: 'output_audio', transcript: 'Safe first part.' }, { type: 'output_audio' }],
    }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.released()).toHaveLength(0);
    expect(h.browser.some(e => e.type === 'fatal')).toBe(true);
    h.engine.close();
  });
  it.each(['missing-start', 'missing-end', 'unapproved-start'])('fails closed on %s local playback', async failure => {
    const h = harness();
    h.user(); await vi.advanceTimersByTimeAsync(0); h.response(); h.audio();
    if (failure === 'unapproved-start') h.engine.localPlayback('r1', h.arm().requestId, 'started');
    else {
      h.finish(); await vi.advanceTimersByTimeAsync(0);
      if (failure === 'missing-end') h.engine.localPlayback('r1', h.arm().requestId, 'started');
      await vi.advanceTimersByTimeAsync(failure === 'missing-end' ? 35001 : 5001);
    }
    expect(h.browser.some(e => e.type === 'fatal')).toBe(true);
    h.engine.close();
  });
  it('cancels unexpected native WS generation without WebRTC-only buffer commands', () => {
    const h = harness();
    h.engine.receive({ type: 'response.created', response: { id: 'unexpected', status: 'in_progress' } });
    expect(h.provider.some(e => e.type === 'response.cancel')).toBe(true);
    expect(h.provider.some(e => e.type === 'output_audio_buffer.clear')).toBe(false);
    expect(h.browser.some(e => e.type === 'fatal')).toBe(true);
    h.engine.close();
  });
});
