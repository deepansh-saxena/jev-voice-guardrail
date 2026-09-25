import { policies, type PolicyId } from '../shared/policies';
import type { LabEvent } from '../shared/protocol';

type Playback = 'playing' | 'stopped' | 'unknown';
export interface GuardrailIncident {
  key: string;
  first: LabEvent;
  policies: PolicyId[];
  action: 'detected' | 'requested' | 'muted';
  playbackAtVerdict: Playback;
  playbackAtMute?: Playback;
}
export interface GuardrailHistory {
  incidents: GuardrailIncident[];
  inputChecks: Record<string, LabEvent>;
  inputTranscripts: Record<string, LabEvent>;
  playback: Record<string, Playback>;
  outputPauses: Record<string, LabEvent>;
  latestError?: LabEvent;
}
export const emptyHistory = (): GuardrailHistory => ({ incidents: [], inputChecks: {}, inputTranscripts: {}, playback: {}, outputPauses: {} });
const turnKey = (event: LabEvent) => `${event.source}:${event.turn ?? event.id}`;
const responseKey = (event: LabEvent) => `${event.source}:${event.responseId ?? event.id}`;
export const inputCheckFor = (history: GuardrailHistory, event: LabEvent) => history.inputChecks[turnKey(event)];
export const inputTextFor = (history: GuardrailHistory, event: LabEvent) => history.inputTranscripts[turnKey(event)]?.text;
export const outputPauseFor = (history: GuardrailHistory, event: LabEvent) => history.outputPauses[responseKey(event)];
const violatedPolicies = (event: LabEvent) => policies.filter(p => p.phase === event.phase
  && event.verdict?.policies.some(v => v.policy === p.id && v.decision === 'violate')).map(p => p.id);
export const policyNames = (ids: PolicyId[]) => ids.map(id => policies.find(p => p.id === id)!.name).join(', ');

function policyInterruption(event: LabEvent, incident: GuardrailIncident) {
  return event.kind === 'interrupt' && event.source === incident.first.source
    && event.responseId !== undefined && event.responseId === incident.first.responseId
    && (event.source === 'fixture' || incident.policies.some(id => event.name === `Output violation: ${id}`));
}

export function appendHistory(history: GuardrailHistory, event: LabEvent): GuardrailHistory {
  let next = history;
  if (event.responseId && !history.outputPauses[responseKey(event)]
    && ((event.kind === 'check-end' && event.phase === 'output' && event.verdict?.decision !== undefined && event.verdict.decision !== 'allow')
      || event.kind === 'interrupt'))
    next = { ...next, outputPauses: { ...next.outputPauses, [responseKey(event)]: event } };
  if (event.kind === 'error') return { ...next, latestError: event };
  if (event.kind === 'transcript' && event.role === 'user')
    return { ...next, inputTranscripts: { ...next.inputTranscripts, [turnKey(event)]: event } };
  // Existing control acknowledgments have names; incident identity comes from verdicts and turn/response IDs.
  if (event.kind === 'lifecycle' && event.responseId) {
    const playback = event.name === 'Provider playback started (not phrase alignment)' ? 'playing'
      : ['Provider playback stopped', 'Provider output buffer clear confirmed'].includes(event.name) ? 'stopped' : undefined;
    if (playback) next = { ...next, playback: { ...next.playback, [responseKey(event)]: playback } };
  }
  if (event.kind === 'check-end' && event.phase === 'input')
    next = { ...next, inputChecks: { ...next.inputChecks, [turnKey(event)]: event } };
  if (event.kind === 'check-end' && event.verdict?.decision === 'violate' && event.phase) {
    const ids = violatedPolicies(event);
    if (!ids.length) return next;
    const key = `${event.phase}:${event.phase === 'input' ? turnKey(event) : responseKey(event)}`;
    const prior = next.incidents.find(i => i.key === key);
    if (prior) return { ...next, incidents: next.incidents.map(i => i.key === key
      ? { ...i, policies: [...new Set([...i.policies, ...ids])] } : i) };
    return { ...next, incidents: [...next.incidents, {
      key, first: event, policies: ids, action: 'detected',
      playbackAtVerdict: next.playback[responseKey(event)] ?? 'unknown',
    }] };
  }
  if (event.kind !== 'interrupt' && event.kind !== 'metric') return next;
  let changed = false;
  const incidents = next.incidents.map(incident => {
    if (incident.first.phase !== 'output') return incident;
    if (incident.action === 'detected' && policyInterruption(event, incident)) {
      changed = true;
      return { ...incident, action: 'requested' as const };
    }
    if (incident.action === 'requested' && event.kind === 'metric'
      && event.name === 'Browser command-receipt to mute (not network transit)'
      && event.source === incident.first.source && event.responseId === incident.first.responseId) {
      changed = true;
      return { ...incident, action: 'muted' as const, playbackAtMute: next.playback[responseKey(event)] ?? 'unknown' };
    }
    return incident;
  });
  return changed ? { ...next, incidents } : next;
}

export function outputPauseLabel(event: LabEvent) {
  const prefix = event.outputMode === 'gated' ? 'Audio withheld' : 'Audio paused';
  if (event.verdict) {
    const ids = event.verdict.policies.filter(p => p.decision === event.verdict!.decision).map(p => p.policy);
    return `${prefix}: ${policyNames(ids)} ${event.verdict.decision === 'uncertain' ? 'uncertain (not a violation)' : 'violation'}`;
  }
  return `${prefix}: ${event.name === 'User interruption' ? 'user barge-in (not a policy violation)' : event.name}`;
}

export function confirmedInterruption(incident: GuardrailIncident) {
  return incident.first.phase === 'output' && incident.first.outputMode !== 'gated' && (incident.first.source === 'fixture'
    ? incident.action === 'requested'
    : incident.action === 'muted' && incident.playbackAtVerdict === 'playing' && incident.playbackAtMute === 'playing');
}
export function incidentCounts(history: GuardrailHistory) {
  return {
    inputBlocks: history.incidents.filter(i => i.first.phase === 'input').length,
    outputViolations: history.incidents.filter(i => i.first.phase === 'output').length,
    gatedOutputBlocks: history.incidents.filter(i => i.first.phase === 'output' && i.first.outputMode === 'gated').length,
    outputInterruptions: history.incidents.filter(confirmedInterruption).length,
  };
}
export function incidentLabel(incident: GuardrailIncident) {
  const label = incident.first.phase === 'input' ? 'INPUT BLOCKED'
    : incident.first.outputMode === 'gated' ? 'OUTPUT BLOCKED BEFORE PLAYBACK'
    : confirmedInterruption(incident) ? 'OUTPUT INTERRUPTED' : 'OUTPUT VIOLATION';
  return `${incident.first.source === 'fixture' ? 'SIMULATED ' : ''}${label}`;
}
export function incidentDetail(incident: GuardrailIncident) {
  if (incident.first.phase === 'input') return incident.first.source === 'fixture'
    ? 'Authored input block; no real answer or audio was generated.'
    : 'Original answer blocked before generation. Only a monitored redirect may follow.';
  if (incident.first.outputMode === 'gated') return incident.first.source === 'fixture'
    ? 'Simulated held output rejected; no real audio played.'
    : 'Held native audio rejected before playback. A separate recovery must pass its own final output gate.';
  if (incident.first.source === 'fixture') return incident.action === 'detected'
    ? 'Authored violation; simulated interruption not yet shown.'
    : 'Scripted interruption only; no real audio played.';
  if (incident.playbackAtVerdict === 'stopped')
    return 'Violation detected after provider playback ended; not counted as stopped speech.';
  if (incident.action === 'detected') return 'Violation detected; no interruption request observed yet.';
  if (incident.action === 'requested') return 'Interruption requested; awaiting browser mute confirmation.';
  if (incident.playbackAtMute === 'stopped')
    return 'Playback ended before mute confirmation; not counted as stopped speech.';
  return confirmedInterruption(incident)
    ? 'Browser mute confirmed during provider playback. Hardware silence and exposed words are not measured.'
    : 'Browser mute confirmed; playback timing unconfirmed. Not counted as a confirmed playback interruption.';
}

export function timelineLabel(event: LabEvent, history: GuardrailHistory) {
  const simulated = event.source === 'fixture' ? ' (simulated)' : '';
  if (event.kind === 'check-end' && event.phase && event.verdict) {
    if (event.verdict.decision === 'violate') return `${event.phase === 'input'
      ? 'Input blocked before answer' : event.outputMode === 'gated' ? 'Output blocked before playback' : 'Output violation detected'}: ${policyNames(violatedPolicies(event))}${simulated}`;
    if (event.verdict.decision === 'uncertain') {
      const ids = event.verdict.policies.filter(p => p.decision === 'uncertain').map(p => p.policy);
      return `${event.phase === 'input' ? 'Input needs clarification' : 'Output uncertain'}: ${policyNames(ids)} (not a confirmed violation)${simulated}`;
    }
    return `${event.phase === 'input' ? 'Input allowed' : 'Output clear so far'}${simulated}`;
  }
  if (event.kind === 'lifecycle' && ['Constrained recovery authorized', 'Constrained redirect (fixture)'].includes(event.name)) {
    const input = history.inputChecks[turnKey(event)];
    const output = history.incidents.find(i => i.first.phase === 'output' && i.first.source === event.source
      && i.first.turn === event.turn && i.first.clock === event.clock && i.first.atMs < event.atMs);
    const reason = input?.verdict?.decision === 'violate' ? 'after input block'
      : input?.verdict?.decision === 'uncertain' ? 'for uncertain input'
        : output ? 'after output violation' : undefined;
    return `${reason === 'for uncertain input' ? 'Clarification' : reason ? 'Safe redirect' : 'Safe redirect or clarification'} authorized${reason ? ` ${reason}` : ''} (output-monitored)${simulated}`;
  }
  if (event.kind === 'interrupt' && event.name === 'User interruption') return 'User barge-in (not a policy violation)';
  const incident = history.incidents.find(i => policyInterruption(event, i));
  if (incident && event.source !== 'fixture')
    return `Output interruption requested: ${policyNames(incident.policies)} (not yet a mute confirmation)`;
  return event.name;
}
