import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costSummary, estimateUsd, pricingSchema, referencePricing, reportedUsage, retainUsage, usd, type JudgeUsage } from '../shared/judge-cost';
import type { JudgeInput } from '../shared/protocol';
import { bounded } from '../server/async';
const pricing = referencePricing('jev-1.13.0', 'gpt-5.4-mini');
const input: JudgeInput = { phase: 'input', text: 'Relay prices?', recentContext: [], final: true };
const jevUsage = { usage: { input_tokens: 1000, output_tokens: 10 } };
describe('reported judge costs', () => {
  it('charges Jev input once for a multi-policy request; output is free', () => {
    expect(estimateUsd(reportedUsage('jev', jevUsage), pricing.jev)).toBeCloseTo(0.000042, 12);
  });
  it('subtracts cached input and never adds reasoning tokens a second time', () => {
    const usage = reportedUsage('llm', { usage: { prompt_tokens: 1000, completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 70 } } });
    expect(usage).toEqual({ input: 1000, cachedInput: 600, output: 100 });
    expect(estimateUsd(usage, pricing.llm)).toBeCloseTo(0.000795, 12);
  });
  it('keeps missing/invalid usage and prices explicitly unavailable', () => {
    expect(reportedUsage('jev', {})).toBeNull();
    for (const n of [-1, NaN, Infinity, 0.2])
      expect(reportedUsage('jev', { usage: { input_tokens: n, output_tokens: 0 } })).toBeNull();
    expect(reportedUsage('llm', { usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } } })).toBeNull();
    expect(estimateUsd(reportedUsage('llm', { usage: { prompt_tokens: 1, completion_tokens: 1 } }), pricing.llm)).toBeNull();
    expect(referencePricing('unknown', 'unknown')).toEqual({ jev: null, llm: null });
    expect(pricingSchema.safeParse({ ...pricing, llm: { ...pricing.llm, input: -1 } }).success).toBe(false);
    expect(usd(0.000000042)).not.toBe('$0.000000');
  });
  it('deduplicates attempts, preserves rate snapshots and separates phases/providers', () => {
    const record: JudgeUsage = { callId: 'one', provider: 'jev', phase: 'input', model: 'jev-1.13.0',
      status: 'reported', usage: { input: 1000, cachedInput: 0, output: 10 }, rates: { ...pricing.jev! }, estimatedUsd: 0.000042 };
    let records = retainUsage({}, { ...record, status: 'pending', usage: null, estimatedUsd: null });
    records = retainUsage(records, record); records = retainUsage(records, record);
    records = retainUsage(records, { ...record, status: 'pending', usage: null, estimatedUsd: null });
    records = retainUsage(records, { ...record, callId: 'recovery', phase: 'output' });
    expect(costSummary(Object.values(records))).toMatchObject({ calls: 2, reported: 2, priced: 2, input: 2000, output: 20 });
    expect(costSummary(Object.values(records)).subtotal).toBeCloseTo(0.000084, 12);
    expect(records.one.rates?.input).toBe(0.042);
  });
});
describe('usage accounting independent of safety verdict delivery', () => {
  beforeEach(() => {
    vi.resetModules(); vi.stubEnv('JEV_API_KEY', 'test-only-key');
    vi.stubEnv('LLM_API_KEY', 'test-only-key'); vi.stubEnv('LLM_BASE_URL', 'https://example.invalid/v1');
    vi.stubEnv('LLM_MODEL', 'gpt-5.4-mini');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('counts reported tokens even if the safety response is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(jevUsage))));
    const records: JudgeUsage[] = [];
    const { createJudge } = await import('../server/judges');
    await expect(createJudge('jev', 'live', r => records.push(r), pricing)(input, new AbortController().signal)).rejects.toMatchObject({ code: 'malformed' });
    expect(costSummary(records)).toMatchObject({ calls: 1, priced: 1, reported: 1 });
  });
  it('keeps a valid verdict when optional accounting usage is invalid', async () => {
    const answer = { type: 'choice', choice: 'allow', confidence: 1, probabilities: { allow: 1, violate: 0, uncertain: 0 } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1.13.0',
      answers: { scope: answer, override: answer, privacy: answer }, usage: { input_tokens: -1, output_tokens: 1 } }))));
    const records: JudgeUsage[] = [];
    const { createJudge } = await import('../server/judges');
    expect((await createJudge('jev', 'live', r => records.push(r), pricing)(input, new AbortController().signal)).decision).toBe('allow');
    expect(costSummary(records)).toMatchObject({ calls: 1, reported: 0, unavailable: 1, priced: 0 });
  });
  it('counts late usage despite a canceled/suppressed caller result', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const records: JudgeUsage[] = [];
    const { createJudge } = await import('../server/judges');
    const judge = createJudge('jev', 'live', r => records.push(r), pricing);
    const controller = new AbortController();
    const result = bounded(signal => judge(input, signal), 1000, controller.signal);
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort(); await expect(result).rejects.toMatchObject({ code: 'aborted' });
    finish(new Response(JSON.stringify(jevUsage)));
    await vi.waitFor(() => expect(costSummary(records).reported).toBe(1));
    expect(costSummary(records).calls).toBe(1);
  });
  it('marks failed/canceled HTTP attempts unavailable rather than free', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Aborted'); }));
    const records: JudgeUsage[] = [];
    const { createJudge } = await import('../server/judges');
    await expect(createJudge('llm', 'live', r => records.push(r), pricing)(input, new AbortController().signal)).rejects.toMatchObject({ code: 'network' });
    expect(costSummary(records)).toMatchObject({ calls: 1, unavailable: 1, priced: 0 });
    expect(records.at(-1)?.warning).toContain('may still be billed');
  });
});
