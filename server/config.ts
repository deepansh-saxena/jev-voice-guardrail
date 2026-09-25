import 'dotenv/config';
import { z } from 'zod';
import { CHECK_INTERVAL_MS, KB_VERSION, POLICY_VERSION } from '../shared/policies';
import type { Readiness } from '../shared/protocol';

const empty = (v: unknown) => v === '' ? undefined : v;
const optional = z.preprocess(empty, z.string().min(1).optional());
const number = (fallback: number, min: number, max: number) =>
  z.preprocess(empty, z.coerce.number().finite().min(min).max(max).default(fallback));
export const env = z.object({
  PORT: number(8787, 1024, 65535),
  AZURE_REALTIME_ENDPOINT: z.string().default('https://YOUR-RESOURCE.cognitiveservices.azure.com/openai/v1/realtime?model=YOUR-REALTIME-DEPLOYMENT'),
  AZURE_OPENAI_API_KEY: optional,
  AZURE_TRANSCRIPTION_DEPLOYMENT: optional,
  AZURE_VOICE: z.string().default('marin'),
  JEV_API_KEY: optional,
  JEV_MODEL: z.string().default('jev-1.13.0'),
  JEV_MIN_PROBABILITY: number(0.8, 0.5, 1),
  LLM_BASE_URL: optional,
  LLM_MODEL: optional,
  LLM_API_KEY: optional,
  LLM_AUTH: z.enum(['bearer', 'api-key']).default('bearer'),
  LLM_REASONING_EFFORT: z.preprocess(empty, z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional()),
  LLM_MAX_COMPLETION_TOKENS: number(1024, 128, 8192),
  JUDGE_TIMEOUT_MS: number(4000, 100, 30000),
  JUDGE_MAX_REQUESTS_PER_MINUTE: number(240, 1, 1200),
  LOG_LIVE_TRANSCRIPTS: z.enum(['true', 'false']).default('false'),
}).parse(process.env);

export const azureUrl = new URL(env.AZURE_REALTIME_ENDPOINT);
if (azureUrl.protocol !== 'https:' || azureUrl.pathname !== '/openai/v1/realtime'
  || !azureUrl.searchParams.get('model') || azureUrl.username || azureUrl.password
  || [...azureUrl.searchParams.keys()].some(k => k !== 'model')) {
  throw new Error('AZURE_REALTIME_ENDPOINT must be an HTTPS /openai/v1/realtime?model=DEPLOYMENT URL without credentials or other query parameters.');
}
export const azureDeployment = azureUrl.searchParams.get('model')!;
if (env.LLM_BASE_URL) {
  const url = new URL(env.LLM_BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('LLM_BASE_URL must be an HTTPS base URL without credentials or query parameters.');
}
const missing = (keys: (keyof typeof env)[]) => keys.filter(k => !env[k]);
export function readiness(): Readiness {
  const azureMissing = missing(['AZURE_OPENAI_API_KEY', 'AZURE_TRANSCRIPTION_DEPLOYMENT']);
  const jevMissing = missing(['JEV_API_KEY']);
  const llmMissing = missing(['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']);
  return {
    azure: { configured: !azureMissing.length, missing: azureMissing, transport: 'Azure GA WebRTC + server sideband', deployment: azureDeployment },
    jev: { configured: !jevMissing.length, missing: jevMissing, model: env.JEV_MODEL },
    llm: { configured: !llmMissing.length, missing: llmMissing, model: env.LLM_MODEL ?? 'Not configured', reasoning: env.LLM_REASONING_EFFORT ?? 'omitted (model default)' },
    config: { intervalMs: CHECK_INTERVAL_MS, timeoutMs: env.JUDGE_TIMEOUT_MS, minProbability: env.JEV_MIN_PROBABILITY, policyVersion: POLICY_VERSION, kbVersion: KB_VERSION },
  };
}

export function publicRunConfig() {
  return {
    ...readiness().config,
    realtime: { endpoint: env.AZURE_REALTIME_ENDPOINT, deployment: azureDeployment, transcriptionDeployment: env.AZURE_TRANSCRIPTION_DEPLOYMENT ?? null, voice: env.AZURE_VOICE, automaticResponses: false, automaticInterruption: false },
    schedulerVersion: 'single-flight-coalescing-v1',
    localRequestsPerMinute: env.JUDGE_MAX_REQUESTS_PER_MINUTE,
    jev: { endpoint: 'https://api.typesafe.ai/v1/systemone', requestedModel: env.JEV_MODEL, threshold: env.JEV_MIN_PROBABILITY },
    llm: { baseUrl: env.LLM_BASE_URL ?? null, requestedModel: env.LLM_MODEL ?? null, reasoningEffort: env.LLM_REASONING_EFFORT ?? null, maxCompletionTokens: env.LLM_MAX_COMPLETION_TOKENS, auth: env.LLM_AUTH },
  };
}
