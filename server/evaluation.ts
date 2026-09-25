import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cases, CORPUS_VERSION, fixtureVerdict, type EvalCase, type Snapshot } from '../shared/cases';
import { CHECK_INTERVAL_MS } from '../shared/policies';
import type { Decision, JudgeInput, Provider, Verdict } from '../shared/protocol';
import { distribution } from '../shared/metrics';
import { CoalescingScheduler, errorMessage, GuardrailError } from './async';
import { createJudge, type Judge } from './judges';
import { env, publicRunConfig } from './config';

export interface EvalRow {
  caseId: string; split: string; phase: 'input' | 'output'; provider: Provider | 'fixture';
  snapshotAtMs: number; text: string; expected: Snapshot['expected']; verdict?: Verdict; error?: string;
  finalSnapshot: boolean;
  checkStartedOffsetMs: number | null; verdictOffsetMs: number | null;
}
export interface EvalResult {
  id: string; createdAt: string; source: 'fixture' | 'provider-replay';
  corpusVersion: string; groundTruth: string; config: ReturnType<typeof publicRunConfig>;
  rows: EvalRow[]; summaries: ReturnType<typeof summarize>[]; file: string;
}
export function summarize(rows: EvalRow[], provider: EvalRow['provider']) {
  const own = rows.filter(r => r.provider === provider);
  let correct = 0, total = 0, falsePositives = 0, misses = 0, abstentions = 0;
  for (const row of own) for (const expected of row.expected) {
    const actual: Decision | undefined = row.verdict?.policies.find(p => p.policy === expected.policy)?.decision;
    if (!actual) continue;
    total++;
    if (actual === expected.decision) correct++;
    if (actual === 'violate' && expected.decision === 'allow') falsePositives++;
    if (expected.decision === 'violate' && actual === 'allow') misses++;
    if (actual === 'uncertain') abstentions++;
  }
  return {
    provider, checkedSnapshots: own.length, errors: own.filter(r => r.error).length,
    finalCasesChecked: own.filter(r => r.finalSnapshot).length,
    finalCasesWithVerdict: own.filter(r => r.finalSnapshot && r.verdict).length,
    scoredPolicyDecisions: total, correct, falsePositives, misses, abstentions,
    input: distribution(own.filter(r => r.phase === 'input').flatMap(r => r.verdict?.serviceMs == null ? [] : [r.verdict.serviceMs])),
    output: distribution(own.filter(r => r.phase === 'output').flatMap(r => r.verdict?.serviceMs == null ? [] : [r.verdict.serviceMs])),
  };
}

export async function replayCase(
  test: EvalCase, judge: Judge, provider: EvalRow['provider'], signal: AbortSignal,
  timeoutMs = env.JUDGE_TIMEOUT_MS,
): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  const start = performance.now();
  type Job = { input: JudgeInput; snapshot: Snapshot };
  const offsets = new Map<Job, number>();
  const scheduler = new CoalescingScheduler<Job, Verdict>(
    async (job, requestSignal) => {
      offsets.set(job, performance.now() - start);
      return judge(job.input, requestSignal);
    },
    (job, verdict) => rows.push({
      caseId: test.id, split: test.split, phase: test.phase, provider,
      snapshotAtMs: job.snapshot.atMs, text: job.snapshot.text, expected: job.snapshot.expected, verdict,
      finalSnapshot: job.input.final,
      checkStartedOffsetMs: provider === 'fixture' ? null : offsets.get(job)!,
      verdictOffsetMs: provider === 'fixture' ? null : performance.now() - start,
    }),
    (job, error) => rows.push({
      caseId: test.id, split: test.split, phase: test.phase, provider,
      snapshotAtMs: job.snapshot.atMs, text: job.snapshot.text, expected: job.snapshot.expected,
      finalSnapshot: job.input.final,
      error: errorMessage(error), checkStartedOffsetMs: provider === 'fixture' ? null : offsets.get(job) ?? null,
      verdictOffsetMs: provider === 'fixture' ? null : performance.now() - start,
    }), CHECK_INTERVAL_MS, timeoutMs,
  );
  const abort = () => scheduler.reset();
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (const [index, snapshot] of test.snapshots.entries()) {
      if (signal.aborted) throw new GuardrailError('aborted', 'Evaluation canceled.');
      const wait = Math.max(0, start + snapshot.atMs - performance.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      if (signal.aborted) throw new GuardrailError('aborted', 'Evaluation canceled.');
      scheduler.offer({ input: {
        phase: test.phase, text: snapshot.text, recentContext: test.recentContext, final: index === test.snapshots.length - 1,
      }, snapshot }, index === test.snapshots.length - 1);
    }
    await scheduler.idle();
    if (signal.aborted) throw new GuardrailError('aborted', 'Evaluation canceled.');
    return rows;
  } finally { scheduler.reset(); signal.removeEventListener('abort', abort); }
}
export async function evaluate(
  source: 'fixture' | 'provider-replay', split: 'tuning' | 'held-out' | 'all', caseIds: string[] | undefined, signal: AbortSignal,
): Promise<EvalResult> {
  if (caseIds?.some(id => !cases.some(c => c.id === id))) throw new GuardrailError('cases', 'Unknown evaluation case ID.');
  const selected = cases.filter(c => (split === 'all' || c.split === split) && (!caseIds || caseIds.includes(c.id)));
  if (!selected.length) throw new GuardrailError('cases', 'No evaluation cases match the selection.');
  const providers: (Provider | 'fixture')[] = source === 'fixture' ? ['fixture'] : ['jev', 'llm'];
  const judges = providers.map(provider => provider === 'fixture' ? null : createJudge(provider, 'provider-replay'));
  // Each provider receives the same independent stream. Detection never truncates its peer's evidence.
  const batches = await Promise.all(providers.map(async (provider, i) => {
    const rows: EvalRow[] = [];
    for (const test of selected) {
      const judge: Judge = judges[i] ?? (async input => {
        const match = test.snapshots.find(s => s.text === input.text);
        if (!match) throw new GuardrailError('fixture-missing', 'No authored fixture exists for this snapshot.');
        return fixtureVerdict(match);
      });
      rows.push(...await replayCase(test, judge, provider, signal));
    }
    return rows;
  }));
  const rows = batches.flat();
  const id = randomUUID();
  const file = `results/eval-${id}.json`;
  const result: EvalResult = {
    id, createdAt: new Date().toISOString(), source, corpusVersion: CORPUS_VERSION,
    groundTruth: 'Synthetic labels authored for review; not independently human-validated. Fixture oracle is not accuracy evidence.',
    config: publicRunConfig(), rows, summaries: providers.map(p => summarize(rows, p)), file,
  };
  await mkdir('results', { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(result, null, 2), { mode: 0o600 });
  if (source === 'provider-replay')
    await writeFile('results/latest-provider-replay.json', JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

export async function latestProviderReplay(): Promise<unknown> {
  try { return JSON.parse(await readFile('results/latest-provider-replay.json', 'utf8')); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new GuardrailError('result-read', 'The latest local provider replay report is unreadable.');
  }
}
