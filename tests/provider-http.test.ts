import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeInput } from '../shared/protocol';

const input: JudgeInput = { phase: 'input', text: 'How much is Relay Plus?', recentContext: [], final: true };
describe('provider HTTP integration with in-process mocked responses', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('JEV_API_KEY', 'fixture-key-not-real');
    vi.stubEnv('LLM_API_KEY', 'fixture-llm-key-not-real');
    vi.stubEnv('LLM_BASE_URL', 'https://example.invalid/openai/v1');
    vi.stubEnv('LLM_MODEL', 'separate-judge-deployment');
    vi.stubEnv('LLM_AUTH', 'bearer');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('sends the official SDK Jev bearer Authorization header, atomic questions and pinned version', async () => {
    const answer = { type: 'choice', choice: 'allow', confidence: 1, probabilities: { allow: 1, violate: 0, uncertain: 0 } };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { scope: answer, override: answer, privacy: answer } })));
    vi.stubGlobal('fetch', fetch);
    const { createJudge } = await import('../server/judges');
    const result = await createJudge('jev')(input, new AbortController().signal);
    expect(result.decision).toBe('allow');
    expect(result.serviceMs).toBeGreaterThanOrEqual(0);
    expect(fetch).toHaveBeenCalledWith('https://api.typesafe.ai/v1/systemone', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer fixture-key-not-real', 'Content-Type': 'application/json' },
      body: expect.stringContaining('"type":"choice"'),
    }));
  });
  it('uses a separately configured Azure/OpenAI-compatible LLM endpoint, not realtime', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      model: 'resolved-judge-version',
      choices: [{ finish_reason: 'stop', message: { content: '{"scope":"allow","override":"allow","privacy":"allow"}' } }],
    })));
    vi.stubGlobal('fetch', fetch);
    const { createJudge } = await import('../server/judges');
    const result = await createJudge('llm')(input, new AbortController().signal);
    expect(result.model).toBe('resolved-judge-version');
    expect(fetch).toHaveBeenCalledWith('https://example.invalid/openai/v1/chat/completions', expect.objectContaining({
      headers: { Authorization: 'Bearer fixture-llm-key-not-real', 'Content-Type': 'application/json' },
      body: expect.stringContaining('"model":"separate-judge-deployment"'),
    }));
  });
  it.each([400, 401, 429, 529])('surfaces HTTP %i without retry or mock fallback', async status => {
    const fetch = vi.fn(async () => new Response('do not expose provider response body', { status }));
    vi.stubGlobal('fetch', fetch);
    const { createJudge } = await import('../server/judges');
    await expect(createJudge('jev')(input, new AbortController().signal)).rejects.toMatchObject({ code: `http-${status}` });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains only allowlisted filter diagnosis and counts unknown usage without a fake verdict or retry', async () => {
    const fetch = vi.fn(async () => Response.json({ error: {
      code: 'content_filter', message: 'PRIVATE provider echo must never leave the adapter',
      innererror: { code: 'ResponsibleAIPolicyViolation', content_filter_result: { jailbreak: { filtered: true, detected: true } } },
    } }, { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const { createJudge } = await import('../server/judges');
    const usage: unknown[] = [];
    const error = await createJudge('llm', 'live', record => usage.push(record))(input, new AbortController().signal).catch(e => e);
    expect(error.failure).toEqual({ provider: 'llm', phase: 'input', code: 'http-400', httpStatus: 400,
      providerCode: 'content_filter', innerCode: 'ResponsibleAIPolicyViolation', filter: 'jailbreak' });
    expect(error.message).toContain('No Relay policy verdict');
    expect(JSON.stringify({ error, usage })).not.toContain('PRIVATE');
    expect(usage.at(-1)).toMatchObject({ status: 'unavailable', usage: null, estimatedUsd: null });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not guess filtering or expose unknown error codes, raw text or oversized bodies', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'private-secret-code', message: 'PRIVATE' } }, { status: 400 }))
      .mockResolvedValueOnce(new Response('PRIVATE'.repeat(5000), { status: 400 })));
    const { createJudge } = await import('../server/judges');
    for (let i = 0; i < 2; i++) {
      const error = await createJudge('llm')(input, new AbortController().signal).catch(e => e);
      expect(error.failure).toEqual({ provider: 'llm', phase: 'input', code: 'http-400', httpStatus: 400 });
      expect(error.message).not.toContain('filter');
      expect(JSON.stringify(error)).not.toContain('private-secret-code');
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
    }
  });
  it('surfaces network and malformed response errors explicitly', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('do not expose transport URL')).mockResolvedValueOnce(new Response('bad json'));
    vi.stubGlobal('fetch', fetch);
    const { createJudge } = await import('../server/judges');
    const judge = createJudge('jev');
    await expect(judge(input, new AbortController().signal)).rejects.toMatchObject({ code: 'network' });
    await expect(judge(input, new AbortController().signal)).rejects.toMatchObject({ code: 'malformed' });
  });
});
