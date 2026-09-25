import { z } from 'zod';
import { MAX_TEXT, policyIds, type Phase, type PolicyId } from './policies';
import type { AudioPartId, AudioPartSummary } from './audio';
import { defaultSessionSettings, sessionSettingsSchema, type SessionSettings } from './session-settings';
import { pricingSchema, type Pricing, type JudgeUsage } from './judge-cost';

export const outputModeSchema = z.enum(['monitor', 'gated']);
export type OutputMode = z.infer<typeof outputModeSchema>;
export const transportFor = (mode: OutputMode) => mode === 'gated' ? 'azure-websocket-pcm-relay' : 'azure-webrtc-sideband';
export const providerSchema = z.enum(['jev', 'llm']);
export type Provider = z.infer<typeof providerSchema>;
export const decisionSchema = z.enum(['allow', 'violate', 'uncertain']);
export type Decision = z.infer<typeof decisionSchema>;
export type Source = 'live' | 'provider-replay';
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
  provider: Provider;
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
  kind: 'status' | 'transcript' | 'check-start' | 'check-end' | 'error' | 'interrupt' | 'lifecycle' | 'metric' | 'usage';
  atMs: number;
  clock: 'server' | 'browser';
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
  outputMode?: OutputMode;
  transport?: ReturnType<typeof transportFor>;
  delivery?: 'held' | 'approved' | 'playing' | 'ended' | 'blocked';
  settings?: SessionSettings;
  usage?: JudgeUsage;
}
export interface Readiness {
  pricing?: Pricing;
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
  | { type: 'fatal'; message: string }
  | GatedServerMessage;
export interface AudioIdentity { responseId: string; requestId: string; turn: number }
export type GatedServerMessage =
  | { type: 'input-speech'; state: 'started' | 'stopped'; itemId: string; turn: number }
  | ({ type: 'audio-start' } & AudioIdentity)
  | { type: 'audio-chunk'; responseId: string; part: AudioPartId; data: string }
  | { type: 'audio-part-done'; responseId: string; part: AudioPartId }
  | ({ type: 'audio-complete'; revision: number; parts: AudioPartSummary[] } & AudioIdentity)
  | ({ type: 'audio-release'; revision: number } & AudioIdentity);

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connect'), pricing: pricingSchema.optional(), settings: sessionSettingsSchema.default(defaultSessionSettings), outputMode: z.literal('monitor').default('monitor'), sdp: z.string().min(10).max(100000), provider: providerSchema, mode: z.enum(['normal', 'stress']) }).strict(),
  z.object({ type: z.literal('connect-gated'), pricing: pricingSchema.optional(), settings: sessionSettingsSchema.default(defaultSessionSettings), outputMode: z.literal('gated'), provider: providerSchema, mode: z.enum(['normal', 'stress']) }).strict(),
  z.object({ type: z.literal('assistant-pause'), responseId: z.string().min(1).max(200), requestId: z.string().min(1).max(100),
    turn: z.number().int().positive(), sequence: z.number().int().positive().max(10000), sampleOffsetMs: z.number().finite().min(0).max(600000) }).strict(),
  z.object({ type: z.literal('audio-input'), data: z.string().min(4).max(6400) }).strict(),
  z.object({ type: z.literal('local-playback'), state: z.enum(['started', 'ended']), responseId: z.string().min(1).max(200), requestId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('armed'), requestId: z.string().max(100) }).strict(),
  z.object({ type: z.literal('muted'), actionId: z.string().max(100), durationMs: z.number().finite().min(0).max(60000) }).strict(),
  z.object({ type: z.literal('barge-in'), itemId: z.string().max(150) }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('metric'), name: z.enum(['speech-end-to-audio-energy', 'gated-whole-response-wait', 'transcription-event-delay', 'playback-start-event', 'playback-stop-event', 'local-barge-in-mute', 'transcript-vs-playback-event-offset']), atMs: z.number().finite().min(0).max(86400000), durationMs: z.number().finite().min(-600000).max(600000), responseId: z.string().max(150).optional() }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export const evalRequestSchema = z.object({
  source: z.literal('provider-replay'),
  pricing: pricingSchema.optional(),
  split: z.enum(['tuning', 'held-out', 'all']),
  caseIds: z.array(z.string().max(80)).min(1).max(60).optional(),
}).strict();
export const policyIdSchema = z.enum(policyIds);
