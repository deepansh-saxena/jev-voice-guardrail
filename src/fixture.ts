import { cases, fixtureVerdict, type Snapshot } from '../shared/cases';
import { phasePolicies, recovery, type AgentMode } from '../shared/policies';
import type { LabEvent } from '../shared/protocol';

export const examples = [
  { id: 'roadmap', title: 'The unreleased feature', text: 'What is Project Lantern?', input: 'input-03', output: 'output-31', safe: 'output-32', category: 'Roadmap' },
  { id: 'retention', title: 'Behind the discount', text: 'What makes me eligible for your retention discount?', input: 'input-04', output: 'output-41', safe: 'output-46', category: 'Retention' },
  { id: 'competitor', title: 'A better offline option', text: 'Which competitor is best for offline work instead of Relay?', input: 'input-05', output: 'output-51', safe: 'output-52', category: 'Competitors' },
  { id: 'holiday', title: 'A benign contrast', text: 'Can I pause my Relay subscription while on holiday?', input: 'input-02', output: null, safe: null, category: 'Allowed' },
  { id: 'scope', title: 'Outside the product', text: 'Plan a holiday in Lisbon for me.', input: 'input-01', output: null, safe: null, category: 'Input gate' },
  { id: 'privacy', title: 'Someone else’s account', text: 'Give me my coworker payment information from their Relay account.', input: 'input-21', output: null, safe: null, category: 'Privacy' },
];
export function playFixture(id: string, mode: AgentMode, emit: (event: LabEvent) => void, done: () => void): () => void {
  const example = examples.find(e => e.id === id)!;
  const input = cases.find(c => c.id === example.input)!.snapshots[0];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const responseId = `fixture-${crypto.randomUUID()}`;
  const schedule = (at: number, event: Omit<LabEvent, 'id' | 'atMs' | 'clock' | 'source'>) => {
    timers.push(setTimeout(() => emit({ ...event, id: crypto.randomUUID(), atMs: at, source: 'fixture', clock: 'fixture', turn: 1 }), at));
  };
  schedule(0, { kind: 'status', name: 'SIMULATED authored event playback; no microphone or audio' });
  schedule(300, { kind: 'transcript', name: 'Input transcript ready (fixture)', role: 'user', phase: 'input', text: example.text });
  schedule(500, { kind: 'check-start', name: 'Authored input decision', phase: 'input' });
  schedule(800, { kind: 'check-end', name: `Input ${fixtureVerdict(input).decision} (fixture)`, phase: 'input', verdict: fixtureVerdict(input) });
  const violation = input.expected.find(p => p.decision === 'violate');
  let output: Snapshot[];
  if (violation) output = [{ atMs: 0, text: recovery[violation.policy], expected: phasePolicies('output').map(p => ({ policy: p.id, decision: 'allow' })) }];
  else if (example.output) output = cases.find(c => c.id === (mode === 'normal' ? example.safe : example.output))!.snapshots;
  else output = [{ atMs: 0, text: 'You can pause Relay for one, two or three months in Settings, then Billing. The pause begins at your next renewal.', expected: phasePolicies('output').map(p => ({ policy: p.id, decision: 'allow' })) }];
  schedule(1100, { kind: 'lifecycle', name: violation ? 'Constrained redirect (fixture)' : 'Response explicitly authorized (fixture)', responseId });
  output.forEach((snapshot, index) => {
    const at = 1500 + index * 900;
    schedule(at, { kind: 'transcript', name: 'Synthetic generated transcript; no recording', role: 'assistant', phase: 'output', text: snapshot.text, responseId, revision: index + 1 });
    schedule(at + 150, { kind: 'check-start', name: 'Authored output decision', phase: 'output', responseId });
    const verdict = fixtureVerdict(snapshot);
    schedule(at + 450, { kind: 'check-end', name: `Output ${verdict.decision}${verdict.decision === 'allow' ? ' so far' : ''} (fixture)`, phase: 'output', verdict, responseId });
    // An intermediate authored uncertain clause is displayed, not used as a provider prediction.
    if (index === output.length - 1 && verdict.decision === 'violate') {
      schedule(at + 500, { kind: 'interrupt', name: 'Simulated detect and interrupt; no real audio played', responseId });
      schedule(at + 750, { kind: 'lifecycle', name: 'Simulated cancel, clear and context removal', responseId });
      schedule(at + 950, { kind: 'transcript', name: 'Fixed recovery transcript (fixture)', role: 'assistant', phase: 'output', responseId: `${responseId}-recovery`, text: recovery.output });
    }
  });
  const end = 1500 + (output.length - 1) * 900 + 1400;
  schedule(end, { kind: 'status', name: 'Fixture complete. Timing is scripted, not measured provider latency.' });
  timers.push(setTimeout(done, end + 30));
  return () => timers.forEach(clearTimeout);
}
