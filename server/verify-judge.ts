import { mkdir, writeFile } from 'node:fs/promises';
import { cases } from '../shared/cases';
import { aggregate, providerSchema } from '../shared/protocol';
import { createJudge } from './judges';
import { bounded, errorMessage } from './async';
import { env, publicRunConfig } from './config';

const provider = providerSchema.parse(process.argv[2] ?? 'jev');
const judge = createJudge(provider, 'provider-replay');
const rows = [];
for (const id of ['input-02', 'input-21', 'output-32', 'output-31']) {
  const test = cases.find(c => c.id === id)!;
  const snapshot = test.snapshots.at(-1)!;
  try {
    const verdict = await bounded(signal => judge({
      phase: test.phase, text: snapshot.text, recentContext: test.recentContext, final: true,
    }, signal), env.JUDGE_TIMEOUT_MS);
    const row = { caseId: id, expected: aggregate(snapshot.expected), verdict };
    rows.push(row);
    console.log(JSON.stringify(row));
  } catch (error) {
    const row = { caseId: id, error: errorMessage(error) };
    rows.push(row);
    console.log(JSON.stringify(row));
    process.exitCode = 1;
  }
}
await mkdir('results', { recursive: true, mode: 0o700 });
await writeFile(`results/${provider}-live-verification.json`, JSON.stringify({
  checkedAt: new Date().toISOString(), config: publicRunConfig(), source: 'provider-replay',
  scope: 'Four real HTTP semantic probes; not a benchmark or independently validated accuracy claim.', rows,
}, null, 2), { mode: 0o600 });
console.log(`Sanitized report: results/${provider}-live-verification.json`);
