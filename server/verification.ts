import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Readiness } from '../shared/protocol';

async function readReport(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('Local verification report is unreadable.');
  }
}
export async function verificationSummary(): Promise<Readiness['verification']> {
  const [azure, jev, llm] = await Promise.all([
    readReport('results/azure-transport-verification.json'),
    readReport('results/jev-live-verification.json'),
    readReport('results/llm-live-verification.json'),
  ]);
  const result: Readiness['verification'] = {};
  if (azure) {
    const report = z.object({ checkedAt: z.string(), stages: z.array(z.object({ name: z.string(), status: z.string() })) }).parse(azure);
    result.azure = {
      checkedAt: report.checkedAt,
      summary: report.stages.some(s => s.name === 'webrtc') && !report.stages.some(s => s.name === 'failure')
        ? 'Real transport verified; speech/transcription not tested'
        : 'Transport probe failed; inspect local report',
    };
  }
  for (const [provider, value] of [['jev', jev], ['llm', llm]] as const) {
    if (!value) continue;
    const report = z.object({ checkedAt: z.string(), rows: z.array(z.object({
      expected: z.string().optional(), error: z.string().optional(), verdict: z.object({ decision: z.string() }).optional(),
    })) }).parse(value);
    const matched = report.rows.filter(r => r.verdict && r.verdict.decision === r.expected).length;
    result[provider] = {
      checkedAt: report.checkedAt,
      summary: `${report.rows.filter(r => r.verdict).length}/${report.rows.length} real probes responded; ${matched} aggregate labels matched`,
    };
  }
  return result;
}
