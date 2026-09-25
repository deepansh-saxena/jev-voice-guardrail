import { z } from 'zod';
import { judgeInstructions, knowledge, MAX_TEXT, phasePolicies } from '../shared/policies';
import { aggregate, contextSchema, decisionSchema, type JudgeInput, type Provider, type PolicyDecision, type Verdict, type Source } from '../shared/protocol';
import { env, readiness } from './config';
import { GuardrailError } from './async';

export type Judge = (input: JudgeInput, signal: AbortSignal) => Promise<Verdict>;
const probability = z.number().finite().min(0).max(1);
const probabilitiesSchema = z.object({ allow: probability, violate: probability, uncertain: probability }).strict();
const choiceSchema = z.object({
  type: z.literal('choice'), choice: decisionSchema, confidence: probability,
  probabilities: probabilitiesSchema,
}).superRefine((answer, ctx) => {
  const values = Object.values(answer.probabilities);
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.02
    || answer.probabilities[answer.choice] < Math.max(...values) - 0.00001) {
    ctx.addIssue({ code: 'custom', message: 'Invalid probability distribution or winning choice.' });
  }
});

export function judgePayload(input: JudgeInput) {
  if (!input.text.trim() || input.text.length > MAX_TEXT) throw new GuardrailError('input-size', 'Empty or oversized guardrail transcript.');
  contextSchema.parse(input.recentContext);
  return {
    phase: input.phase, isFinalSnapshot: input.final,
    untrusted: { textToEvaluate: input.text, recentContext: input.recentContext },
  };
}
export function jevBody(input: JudgeInput, model: string) {
  return {
    model, state: judgePayload(input),
    questions: Object.fromEntries(phasePolicies(input.phase).map(policy => [policy.id, {
      type: 'choice',
      instructions: { evaluatorInstructions: judgeInstructions, policy: policy.rule, trustedKnowledge: knowledge },
      criteria: {
        allow: 'No semantic violation of THIS policy is evidenced so far.',
        violate: 'A semantic violation of THIS policy is evidenced.',
        uncertain: 'Insufficient evidence or genuinely ambiguous meaning to decide THIS policy.',
      },
    }])),
  };
}
export function parseJev(value: unknown, input: JudgeInput, threshold: number): { model: string; policies: PolicyDecision[] } {
  const answerSchema = z.object(Object.fromEntries(phasePolicies(input.phase).map(p => [p.id, choiceSchema]))).strict();
  const parsed = z.object({ model: z.string().min(1), answers: answerSchema }).parse(value);
  return { model: parsed.model, policies: phasePolicies(input.phase).map(p => {
    const answer = parsed.answers[p.id];
    const winning = answer.probabilities[answer.choice];
    return { policy: p.id, decision: winning >= threshold ? answer.choice : 'uncertain', probability: winning };
  }) };
}

export function llmBody(input: JudgeInput, model: string, reasoning?: string, maxTokens = 1024) {
  const rules = phasePolicies(input.phase);
  return {
    model,
    messages: [
      { role: 'system', content: JSON.stringify({ instructions: judgeInstructions, policies: rules, trustedKnowledge: knowledge }) },
      { role: 'user', content: JSON.stringify(judgePayload(input)) },
    ],
    response_format: { type: 'json_schema', json_schema: {
      name: 'policy_decisions', strict: true,
      schema: { type: 'object', additionalProperties: false, required: rules.map(p => p.id),
        properties: Object.fromEntries(rules.map(p => [p.id, { type: 'string', enum: ['allow', 'violate', 'uncertain'] }])) },
    } },
    max_completion_tokens: maxTokens,
    ...(reasoning ? { reasoning_effort: reasoning } : {}),
  };
}
export function parseLlm(value: unknown, input: JudgeInput): { model: string; policies: PolicyDecision[] } {
  const parsed = z.object({
    model: z.string().min(1),
    choices: z.array(z.object({
      finish_reason: z.literal('stop'),
      message: z.object({ content: z.string().max(8000), refusal: z.null().optional() }),
    })).length(1),
  }).parse(value);
  const decisions = z.object(Object.fromEntries(phasePolicies(input.phase).map(p => [p.id, decisionSchema]))).strict()
    .parse(JSON.parse(parsed.choices[0].message.content));
  return { model: parsed.model, policies: phasePolicies(input.phase).map(p => ({ policy: p.id, decision: decisions[p.id] })) };
}

const active: Record<Provider, number> = { jev: 0, llm: 0 };
const starts: Record<Provider, number[]> = { jev: [], llm: [] };
async function jsonRequest(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' }); }
  catch { throw new GuardrailError('network', 'Guardrail unavailable: provider connection failed or was aborted.'); }
  if (!res.ok) {
    await res.body?.cancel();
    throw new GuardrailError(`http-${res.status}`, `Guardrail unavailable: provider HTTP ${res.status}. No automatic retry.`);
  }
  if (!res.body) throw new GuardrailError('empty', 'Guardrail unavailable: empty provider response.');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128000) { await reader.cancel(); throw new GuardrailError('oversize', 'Guardrail unavailable: oversized provider response.'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createJudge(provider: Provider, source: Source = 'live'): Judge {
  const state = readiness()[provider];
  if (!state.configured) throw new GuardrailError('config', `Missing configuration: ${state.missing.join(', ')}.`);
  return async (input, signal) => {
    const start = performance.now();
    starts[provider] = starts[provider].filter(t => t > start - 60000);
    if (active[provider] >= 2 || starts[provider].length >= env.JUDGE_MAX_REQUESTS_PER_MINUTE)
      throw new GuardrailError('capacity', 'Guardrail unavailable: local concurrency or per-minute limit reached.');
    starts[provider].push(start);
    active[provider]++;
    try {
      let normalized: ReturnType<typeof parseLlm>;
      if (provider === 'jev') {
        const data = await jsonRequest('https://api.typesafe.ai/v1/systemone',
          { Authorization: `Bearer ${env.JEV_API_KEY!}`, 'Content-Type': 'application/json' }, jevBody(input, env.JEV_MODEL), signal);
        normalized = parseJev(data, input, env.JEV_MIN_PROBABILITY);
      } else {
        const auth: Record<string, string> = env.LLM_AUTH === 'api-key' ? { 'api-key': env.LLM_API_KEY! } : { Authorization: `Bearer ${env.LLM_API_KEY!}` };
        const data = await jsonRequest(`${env.LLM_BASE_URL!.replace(/\/$/, '')}/chat/completions`,
          { ...auth, 'Content-Type': 'application/json' }, llmBody(input, env.LLM_MODEL!, env.LLM_REASONING_EFFORT, env.LLM_MAX_COMPLETION_TOKENS), signal);
        normalized = parseLlm(data, input);
      }
      return { ...normalized, decision: aggregate(normalized.policies), provider, source, serviceMs: performance.now() - start };
    } catch (error) {
      if (error instanceof GuardrailError) throw error;
      throw new GuardrailError('malformed', 'Guardrail unavailable: malformed, refused, incomplete or unreadable provider result.');
    } finally { active[provider]--; }
  };
}
