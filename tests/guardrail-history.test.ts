import { describe, expect, it } from 'vitest';
import { appendHistory, emptyHistory, incidentCounts, incidentDetail, incidentLabel, inputCheckFor, inputTextFor, outputPauseFor, outputPauseLabel, policyNames, timelineLabel } from '../src/guardrail-history';
import { phasePolicies, type Phase, type PolicyId } from '../shared/policies';
import type { LabEvent } from '../shared/protocol';

let serial = 0;
function event(fields: Partial<LabEvent> = {}): LabEvent {
  return { id: `e${++serial}`, atMs: serial * 10, clock: 'server', source: 'live', kind: 'lifecycle', name: '', turn: 1, ...fields };
}
function check(phase: Phase, ids: PolicyId[], fields: Partial<LabEvent> = {}): LabEvent {
  return event({ kind: 'check-end', phase, verdict: {
    provider: 'llm', model: 'test-judge', source: 'live', serviceMs: 1117, decision: ids.length ? 'violate' : 'allow',
    policies: phasePolicies(phase).map(p => ({ policy: p.id, decision: ids.includes(p.id) ? 'violate' : 'allow' })),
  }, ...fields });
}
const historyOf = (events: LabEvent[]) => events.reduce(appendHistory, emptyHistory());
const playing = () => event({ name: 'Provider playback started (not phrase alignment)', responseId: 'r1' });
const violation = () => check('output', ['roadmap'], { responseId: 'r1' });
const interrupt = () => event({ kind: 'interrupt', responseId: 'r1', name: 'Output violation: roadmap' });
const muted = () => event({ kind: 'metric', responseId: 'r1', name: 'Browser command-receipt to mute (not network transit)' });
const stopped = () => event({ responseId: 'r1', name: 'Provider playback stopped' });

describe('current-session guardrail evidence', () => {
  it('links output uncertainty to its own paused response without counting it as a violation or muting recovery', () => {
    const uncertain = check('output', [], { responseId: 'uncertain-response' });
    uncertain.verdict!.decision = 'uncertain';
    uncertain.verdict!.policies[0].decision = 'uncertain';
    const history = historyOf([uncertain, event({ kind: 'interrupt', name: 'Output uncertain; speech paused', responseId: 'uncertain-response' }),
      check('output', [], { responseId: 'safe-recovery' })]);
    expect(outputPauseFor(history, uncertain)).toBe(uncertain);
    expect(outputPauseLabel(uncertain)).toBe('Audio paused: Unreleased roadmap uncertain (not a violation)');
    expect(outputPauseFor(history, event({ responseId: 'safe-recovery' }))).toBeUndefined();
    expect(incidentCounts(history).outputViolations).toBe(0);
    expect(outputPauseFor(emptyHistory(), uncertain)).toBeUndefined();
  });
  it('distinguishes technical audio pauses from semantic violations', () => {
    const failure = event({ kind: 'interrupt', responseId: 'failed', name: 'Guardrail unavailable; not a policy detection' });
    const history = historyOf([failure]);
    expect(outputPauseLabel(outputPauseFor(history, failure)!)).toBe('Audio paused: Guardrail unavailable; not a policy detection');
    expect(incidentCounts(history).outputViolations).toBe(0);
  });
  it('retains two blocked turns and actual policies through safe output checks and timeline rollover', () => {
    const first = check('input', ['privacy'], { atMs: 44910 });
    let history = historyOf([first, check('output', [], { responseId: 'safe1' }),
      check('input', ['override'], { turn: 2, atMs: 53330 }), check('output', [], { turn: 2, responseId: 'safe2' })]);
    for (let i = 0; i < 650; i++) history = appendHistory(history, check('output', [], { responseId: 'safe2' }));
    expect(incidentCounts(history)).toEqual({ inputBlocks: 2, outputViolations: 0, gatedOutputBlocks: 0, outputInterruptions: 0 });
    expect(history.incidents[0].first).toBe(first);
    expect(policyNames(history.incidents[0].policies)).toBe('Customer privacy');
    expect(incidentLabel(history.incidents[0])).toBe('INPUT BLOCKED');
    expect(incidentDetail(history.incidents[0])).toContain('Original answer blocked before generation');
    expect(timelineLabel(first, history)).toBe('Input blocked before answer: Customer privacy');
  });
  it('counts one turn with multiple violating policies only once', () => {
    const history = historyOf([check('input', ['privacy', 'override']), check('input', ['privacy'])]);
    expect(incidentCounts(history).inputBlocks).toBe(1);
    expect(policyNames(history.incidents[0].policies)).toBe('Instruction integrity, Customer privacy');
  });
  it('binds a late input verdict to its own turn, never the most recent user message', () => {
    const oldInput = event({ kind: 'transcript', role: 'user', text: 'Old request', turn: 1 });
    const newInput = event({ kind: 'transcript', role: 'user', text: 'New request', turn: 2 });
    const blocked = check('input', ['privacy'], { turn: 1 });
    const history = historyOf([oldInput, newInput, blocked]);
    expect(inputCheckFor(history, oldInput)).toBe(blocked);
    expect(inputCheckFor(history, newInput)).toBeUndefined();
    expect(inputTextFor(history, blocked)).toBe('Old request');
  });
  it('deduplicates streamed output verdicts and retains the original time after monitored recovery', () => {
    const first = violation();
    const history = historyOf([playing(), first, interrupt(), muted(), violation(),
      check('output', [], { responseId: 'recovery' }), check('input', [], { turn: 2 })]);
    expect(incidentCounts(history)).toEqual({ inputBlocks: 0, outputViolations: 1, gatedOutputBlocks: 0, outputInterruptions: 1 });
    expect(history.incidents[0].first).toBe(first);
    expect(incidentLabel(history.incidents[0])).toBe('OUTPUT INTERRUPTED');
    expect(incidentDetail(history.incidents[0])).toContain('Hardware silence');
  });
  it('keeps violation, interruption request and browser mute evidence distinct', () => {
    let history = historyOf([playing(), violation()]);
    expect(incidentCounts(history).outputViolations).toBe(1);
    expect(incidentCounts(history).outputInterruptions).toBe(0);
    history = appendHistory(history, interrupt());
    expect(incidentDetail(history.incidents[0])).toContain('awaiting browser mute');
    expect(incidentCounts(history).outputInterruptions).toBe(0);
    history = appendHistory(history, muted());
    expect(incidentCounts(history).outputInterruptions).toBe(1);
  });
  it.each(['before-verdict', 'before-mute', 'unknown'] as const)('does not claim stopped speech when playback is %s', timing => {
    const events = timing === 'unknown' ? [violation(), interrupt(), muted()]
      : timing === 'before-verdict' ? [playing(), stopped(), violation(), interrupt(), muted()]
        : [playing(), violation(), interrupt(), stopped(), muted()];
    const history = historyOf(events);
    expect(incidentCounts(history).outputViolations).toBe(1);
    expect(incidentCounts(history).outputInterruptions).toBe(0);
    expect(incidentLabel(history.incidents[0])).toBe('OUTPUT VIOLATION');
  });
  it('does not turn a user barge-in, uncertainty or outage into a policy violation', () => {
    const uncertain = check('input', []);
    uncertain.verdict!.decision = 'uncertain';
    uncertain.verdict!.policies[0].decision = 'uncertain';
    const history = historyOf([playing(), uncertain,
      event({ kind: 'interrupt', name: 'User interruption', responseId: 'r1' }),
      event({ kind: 'error', name: 'Guardrail unavailable' }), muted()]);
    expect(history.incidents).toEqual([]);
    expect(timelineLabel(uncertain, history)).toContain('Input needs clarification: Product scope');
    expect(timelineLabel(event({ name: 'Constrained recovery authorized' }), history)).toContain('Clarification authorized for uncertain input');
    const violated = historyOf([playing(), violation(), event({ kind: 'interrupt', name: 'User interruption', responseId: 'r1' }), muted()]);
    expect(incidentCounts(violated).outputInterruptions).toBe(0);
  });
  it('names the actual block on the timeline and describes only a safe redirect', () => {
    const input = check('input', ['privacy']);
    const history = historyOf([input]);
    expect(timelineLabel(event({ name: 'Constrained recovery authorized' }), history)).toBe('Safe redirect authorized after input block (output-monitored)');
    expect(timelineLabel(input, history)).toContain('Customer privacy');
    expect(timelineLabel(input, history)).not.toContain('Product scope');
  });

  it('counts gated violations as unheard blocks, never streaming interruptions', () => {
    const history = historyOf([check('output', ['roadmap', 'discount'], { responseId: 'g1', outputMode: 'gated' }),
      event({ kind: 'interrupt', name: 'Output violation: roadmap', responseId: 'g1', outputMode: 'gated' }),
      check('output', [], { responseId: 'safe', outputMode: 'gated' })]);
    expect(incidentCounts(history)).toMatchObject({ gatedOutputBlocks: 1, outputViolations: 1, outputInterruptions: 0 });
    expect(incidentLabel(history.incidents[0])).toBe('OUTPUT BLOCKED BEFORE PLAYBACK');
  });
});
