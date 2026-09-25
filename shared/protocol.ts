import { z } from 'zod';
import { MAX_TEXT, policyIds, type Phase, type PolicyId } from './policies';

export const providerSchema = z.enum(['jev', 'llm']);
export type Provider = z.infer<typeof providerSchema>;
export const decisionSchema = z.enum(['allow', 'violate', 'uncertain']);
export type Decision = z.infer<typeof decisionSchema>;
export type Source = 'live' | 'provider-replay' | 'fixture';
export const contextSchema = z.array(z.object({
  role: z.enum(['user', 'assistant']), text: z.string().max(MAX_TEXT),
})).max(8);
export type Context = z.infer<typeof contextSchema>;
export interface JudgeInput {
  phase: Phase;
  text: string;
  recentContext: Context;
  final: boolean;
}
export interface PolicyDecision {
  policy: PolicyId;
  decision: Decision;
  probability?: number;
}
export interface Verdict {
  decision: Decision;
  policies: PolicyDecision[];
  provider: Provider | 'fixture';
  model: string;
  serviceMs: number | null;
  source: Source;
}
export function aggregate(decisions: PolicyDecision[]): Decision {
  return decisions.some(d => d.decision === 'violate') ? 'violate'
    : decisions.some(d => d.decision === 'uncertain') ? 'uncertain' : 'allow';
}
export interface LabEvent {
  id: string;
  kind: 'status' | 'transcript' | 'check-start' | 'check-end' | 'error' | 'interrupt' | 'lifecycle' | 'metric';
  atMs: number;
  clock: 'server' | 'browser' | 'fixture';
  source: Source;
  name: string;
  phase?: Phase;
  turn?: number;
  responseId?: string;
  revision?: number;
  role?: 'user' | 'assistant';
  text?: string;
  verdict?: Verdict;
  durationMs?: number;
}
export interface Readiness {
  azure: { configured: boolean; missing: string[]; transport: string; deployment: string };
  jev: { configured: boolean; missing: string[]; model: string };
  llm: { configured: boolean; missing: string[]; model: string; reasoning: string };
  config: { intervalMs: number; timeoutMs: number; minProbability: number; policyVersion: string; kbVersion: string };
  verification?: Partial<Record<'azure' | Provider, { checkedAt: string; summary: string }>>;
}
export type ServerMessage =
  | { type: 'answer'; sdp: string }
  | { type: 'heartbeat' }
  | { type: 'ready' }
  | { type: 'event'; event: LabEvent }
  | { type: 'arm'; requestId: string; turn: number; inputItemId: string }
  | { type: 'mute'; actionId: string; responseId?: string; turn: number }
  | { type: 'fatal'; message: string };

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect'), sdp: z.string().min(10).max(100000), provider: providerSchema, mode: z.enum(['normal', 'stress']) }).strict(),
  z.object({ type: z.literal('armed'), requestId: z.string().max(100) }).strict(),
  z.object({ type: z.literal('muted'), actionId: z.string().max(100), durationMs: z.number().finite().min(0).max(60000) }).strict(),
  z.object({ type: z.literal('barge-in'), itemId: z.string().max(150) }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('metric'), name: z.enum(['speech-end-to-audio-energy', 'transcription-event-delay', 'playback-start-event', 'playback-stop-event', 'local-barge-in-mute', 'transcript-vs-playback-event-offset']), atMs: z.number().finite().min(0).max(86400000), durationMs: z.number().finite().min(-600000).max(600000), responseId: z.string().max(150).optional() }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export const evalRequestSchema = z.object({
  source: z.enum(['fixture', 'provider-replay']),
  split: z.enum(['tuning', 'held-out', 'all']),
  caseIds: z.array(z.string().max(80)).min(1).max(60).optional(),
}).strict();
export const policyIdSchema = z.enum(policyIds);
