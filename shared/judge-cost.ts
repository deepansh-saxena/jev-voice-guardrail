import { z } from 'zod';
import type { Phase } from './policies';
import type { Provider } from './protocol';

const rate = z.number().finite().min(0).max(10000).nullable();
export const rateSchema = z.object({
  input: rate, cachedInput: rate, output: rate,
  model: z.string().max(200),
  source: z.enum(['TypeSafe published', 'OpenAI reference', 'Custom']),
  asOf: z.string().max(40),
}).strict();
export const pricingSchema = z.object({ jev: rateSchema.nullable(), llm: rateSchema.nullable() }).strict();
export type Rates = z.infer<typeof rateSchema>;
export type Pricing = z.infer<typeof pricingSchema>;
export interface TokenUsage { input: number; cachedInput: number | null; output: number }
export interface JudgeUsage {
  callId: string; provider: Provider; phase: Phase; model: string;
  status: 'pending' | 'reported' | 'unavailable';
  usage: TokenUsage | null; rates: Rates | null; estimatedUsd: number | null;
  warning?: string;
}
export function referencePricing(jevModel: string, llmModel: string): Pricing {
  return {
    jev: jevModel === 'jev-1.13.0' ? { input: 0.042, cachedInput: 0.042, output: 0, model: jevModel, source: 'TypeSafe published', asOf: '2026-09-25' } : null,
    llm: /^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(llmModel)
      ? { input: 0.75, cachedInput: 0.075, output: 4.5, model: llmModel, source: 'OpenAI reference', asOf: '2026-09-25' } : null,
  };
}
const tokens = z.number().finite().int().min(0).max(1_000_000_000);
export function reportedUsage(provider: Provider, value: unknown): TokenUsage | null {
  if (provider === 'jev') {
    const result = z.object({ usage: z.object({ input_tokens: tokens, output_tokens: tokens }) }).safeParse(value);
    return result.success ? { input: result.data.usage.input_tokens, cachedInput: 0, output: result.data.usage.output_tokens } : null;
  }
  const result = z.object({ usage: z.object({
    prompt_tokens: tokens, completion_tokens: tokens,
    prompt_tokens_details: z.object({ cached_tokens: tokens.optional() }).nullish(),
  }) }).safeParse(value);
  if (!result.success) return null;
  const usage = result.data.usage;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? null;
  if (cached !== null && cached > usage.prompt_tokens) return null;
  return { input: usage.prompt_tokens, cachedInput: cached, output: usage.completion_tokens };
}
export function estimateUsd(usage: TokenUsage | null, rates: Rates | null): number | null {
  if (!usage || !rates) return null;
  const cached = usage.cachedInput;
  if (cached === null && usage.input > 0 && rates.cachedInput !== rates.input) return null;
  const quantities = [usage.input - (cached ?? 0), cached ?? 0, usage.output];
  const prices = [rates.input, rates.cachedInput, rates.output];
  if (quantities.some((n, i) => n > 0 && prices[i] === null)) return null;
  return quantities.reduce((sum, n, i) => sum + n * (prices[i] ?? 0), 0) / 1_000_000;
}
export function retainUsage(records: Record<string, JudgeUsage>, next: JudgeUsage) {
  if (records[next.callId]?.status !== undefined && records[next.callId].status !== 'pending' && next.status === 'pending') return records;
  return { ...records, [next.callId]: next };
}
export function costSummary(records: JudgeUsage[]) {
  const unique = Object.values(records.reduce(retainUsage, {}));
  return {
    calls: unique.length, reported: unique.filter(r => r.usage !== null).length,
    unavailable: unique.filter(r => r.status === 'unavailable').length,
    pending: unique.filter(r => r.status === 'pending').length,
    priced: unique.filter(r => r.estimatedUsd !== null).length,
    subtotal: unique.reduce((sum, r) => sum + (r.estimatedUsd ?? 0), 0),
    input: unique.reduce((sum, r) => sum + (r.usage?.input ?? 0), 0),
    cached: unique.reduce((sum, r) => sum + (r.usage?.cachedInput ?? 0), 0),
    output: unique.reduce((sum, r) => sum + (r.usage?.output ?? 0), 0),
  };
}
export const usd = (value: number) => value > 0 && value < 0.000001 ? `$${value.toPrecision(4)}` : `$${value.toFixed(6)}`;
