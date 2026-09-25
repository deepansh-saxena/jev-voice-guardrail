import { describe, expect, it } from 'vitest';
import { cases, type Snapshot } from '../shared/cases';
import { aggregate, type Verdict } from '../shared/protocol';
import { replayCase, summarize } from '../server/evaluation';
const mockVerdict = (snapshot: Snapshot): Verdict => ({
  decision: aggregate(snapshot.expected), policies: snapshot.expected, provider: 'jev',
  model: 'test-only', source: 'provider-replay', serviceMs: null,
});

describe('independent replay and measurement honesty', () => {
  it('keeps feeding later evidence to both providers after a violation', async () => {
    const sample = cases.find(c => c.id === 'output-31')!;
    const seen: string[][] = [[], []];
    const streams = await Promise.all(([0, 1] as const).map(i => replayCase(sample, async input => {
      seen[i].push(input.text);
      return { ...      mockVerdict(sample.snapshots.find(s => s.text === input.text)!), provider: i === 0 ? 'jev' : 'llm', source: 'provider-replay', serviceMs: 1 };
    }, i === 0 ? 'jev' : 'llm', new AbortController().signal)));
    expect(seen[0]).toEqual(sample.snapshots.map(s => s.text));
    expect(seen[1]).toEqual(seen[0]);
    expect(streams[0].at(-1)?.verdict?.decision).toBe('violate');
    expect(streams[1].at(-1)?.verdict?.decision).toBe('violate');
  });
  it('does not substitute wall time when service duration is unavailable', async () => {
    const test = cases[0];
    const rows = await replayCase(test, async () => mockVerdict(test.snapshots[0]), 'jev', new AbortController().signal);
    expect(rows[0].checkStartedOffsetMs).toBeGreaterThanOrEqual(0);
    expect(rows[0].verdictOffsetMs).toBeGreaterThanOrEqual(0);
    expect(summarize(rows, 'jev').input.count).toBe(0);
  });
  it('records timeouts as unavailable, separate from detection or accuracy', async () => {
    const rows = await replayCase(cases[0], () => new Promise(() => {}), 'jev', new AbortController().signal, 20);
    const summary = summarize(rows, 'jev');
    expect(summary.errors).toBe(1);
    expect(summary.misses).toBe(0);
    expect(summary.scoredPolicyDecisions).toBe(0);
  });
});
