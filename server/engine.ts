import { randomUUID } from 'node:crypto';
import { CHECK_INTERVAL_MS, MAX_TEXT, recovery, type PolicyId } from '../shared/policies';
import { transportFor, type Context, type JudgeInput, type LabEvent, type OutputMode, type ServerMessage, type Verdict } from '../shared/protocol';
import { audioPartKey, decodePcm, MAX_OUTPUT_SECONDS, PcmResponseBuffer, type AudioPartId } from '../shared/audio';
import type { RealtimeEvent } from '../shared/realtime';
import { bounded, CoalescingScheduler, errorMessage } from './async';
import type { Judge } from './judges';

interface Turn { id: string; number: number; transcript?: string; stoppedAt?: number }
interface Request {
  id: string; turn: number; inputId: string; recoveryText?: string;
  stage: 'armed' | 'creating'; stale: boolean;
}
interface Part { output: number; content: number; text: string; final: boolean }
interface Active {
  id: string; turn: number; recovery: boolean; parts: Map<string, Part>; items: Set<string>;
  deleted: Set<string>; revision: number; checked: number; offered: string;
  done: boolean; playbackStopped: boolean; interrupted: boolean; cleared: boolean;
  muted: boolean; playbackStarted: boolean; clearRequested: boolean; actionId?: string; cancelId?: string; recoveryText?: string;
  requestId: string; audio: PcmResponseBuffer; audioSealed: boolean; finalChecked: boolean; releaseSent: boolean; localStarted: boolean;
}
interface Snapshot extends JudgeInput { responseId: string; revision: number; turn: number }
interface EngineHooks {
  provider: (event: Record<string, unknown>) => void;
  browser: (message: ServerMessage) => void;
  event?: (event: LabEvent) => void;
  now?: () => number;
}

export class GuardrailEngine {
  private turn?: Turn;
  private turnNumber = 0;
  private seenSpeech = new Set<string>();
  private inputAbort?: AbortController;
  private pending?: Request;
  private deferred?: { turn: number; recoveryText?: string };
  private active?: Active;
  private context: Context = [];
  private approvedRefs: string[] = [];
  private disposed = false;
  private epoch = 0;
  private tick: ReturnType<typeof setInterval>;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private now: () => number;
  private startedAt: number;
  private scheduler: CoalescingScheduler<Snapshot, Verdict>;

  constructor(private judge: Judge, private hooks: EngineHooks, private timeoutMs: number, private outputMode: OutputMode = 'monitor') {
    this.now = hooks.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.scheduler = new CoalescingScheduler(
      async (snapshot, signal) => {
        this.emit({ kind: 'check-start', name: 'Output check started', phase: 'output', responseId: snapshot.responseId, revision: snapshot.revision });
        return this.judge(snapshot, signal);
      },
      (snapshot, verdict) => this.outputVerdict(snapshot, verdict),
      (_snapshot, error) => this.fault(errorMessage(error)),
      CHECK_INTERVAL_MS, timeoutMs, this.now,
    );
    this.tick = setInterval(() => this.snapshot(false), CHECK_INTERVAL_MS);
  }

  private emit(event: Omit<LabEvent, 'id' | 'atMs' | 'clock' | 'source'>) {
    const full: LabEvent = { id: randomUUID(), atMs: this.now() - this.startedAt, clock: 'server', source: 'live', turn: this.turn?.number,
      outputMode: this.outputMode, transport: transportFor(this.outputMode), ...event };
    this.hooks.browser({ type: 'event', event: full });
    this.hooks.event?.(full);
  }
  private send(event: Record<string, unknown>) { if (!this.disposed) this.hooks.provider(event); }
  private deadline(key: string, ms: number, message: string) {
    this.clearDeadline(key);
    this.timers.set(key, setTimeout(() => this.fault(message), ms));
  }
  private clearDeadline(key: string) { clearTimeout(this.timers.get(key)); this.timers.delete(key); }

  speechStarted(itemId: string) {
    if (this.disposed || this.seenSpeech.has(itemId)) return;
    if (this.seenSpeech.size >= 40) { this.fault('Local call turn limit reached. Start a new call.'); return; }
    this.seenSpeech.add(itemId);
    this.turn = { id: itemId, number: ++this.turnNumber };
    if (this.outputMode === 'gated') this.hooks.browser({ type: 'input-speech', state: 'started', itemId, turn: this.turn.number });
    this.epoch++;
    this.inputAbort?.abort();
    this.clearDeadline('transcription');
    this.deferred = undefined;
    if (this.pending?.stage === 'armed') { this.pending = undefined; this.clearDeadline('response'); }
    else if (this.pending) this.pending.stale = true;
    if (this.active) this.interrupt('User interruption');
    this.emit({ kind: 'lifecycle', name: 'Speech started; previous approvals invalidated' });
    this.deadline('speech', 60000, 'Speech turn exceeded 60 seconds. Start a new call.');
  }

  receive(event: RealtimeEvent) {
    if (this.disposed) return;
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.speechStarted(event.item_id); break;
      case 'input_audio_buffer.speech_stopped':
        if (this.turn?.id !== event.item_id) break;
        this.clearDeadline('speech');
        this.turn.stoppedAt = this.now();
        if (this.outputMode === 'gated') this.hooks.browser({ type: 'input-speech', state: 'stopped', itemId: event.item_id, turn: this.turn.number });
        this.emit({ kind: 'lifecycle', name: 'Speech ended; awaiting transcription' });
        if (!this.turn.transcript) this.deadline('transcription', 12000, 'Input transcription unavailable after 12 seconds. No response was authorized.');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        void this.inputTranscript(event.item_id, event.transcript); break;
      case 'conversation.item.input_audio_transcription.failed':
        if (this.turn?.id === event.item_id) this.fault('Input transcription failed. No response was authorized.');
        break;
      case 'response.created':
        this.responseCreated(event.response.id, event.response.metadata?.relay_request); break;
      case 'response.output_item.added':
        if (this.active?.id === event.response_id) {
          this.active.items.add(event.item.id);
          if (this.active.interrupted && this.active.done) this.deleteItem(event.item.id);
        }
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_audio_transcript.done':
        if (this.active?.id !== event.response_id || this.active.interrupted) break;
        this.active.items.add(event.item_id);
        this.updatePart(event.item_id, event.output_index, event.content_index,
          event.type === 'response.output_audio_transcript.done' ? event.transcript : event.delta,
          event.type === 'response.output_audio_transcript.done');
        break;
      case 'response.done':
        this.responseDone(event); break;
      case 'response.output_audio.delta':
      case 'response.output_audio.done':
        this.audioEvent(event); break;
      case 'output_audio_buffer.started':
        if (this.active?.id !== event.response_id) break;
        this.active.playbackStopped = false;
        this.active.playbackStarted = true;
        this.emit({ kind: 'lifecycle', name: 'Provider playback started (not phrase alignment)', responseId: event.response_id });
        if (!this.text()) this.deadline('output-transcript', 1500, 'Output transcript unavailable while audio is playing.');
        else if ([...this.active.parts.values()].some(p => !p.final))
          this.deadline('output-transcript', 2500, 'Output transcription stalled while audio was playing.');
        break;
      case 'output_audio_buffer.stopped':
        if (this.active?.id !== event.response_id) break;
        this.active.playbackStopped = true;
        this.emit({ kind: 'lifecycle', name: 'Provider playback stopped', responseId: event.response_id });
        this.finishResponse();
        break;
      case 'output_audio_buffer.cleared':
        if (this.active?.id !== event.response_id || !this.active.clearRequested) break;
        this.active.cleared = true;
        this.active.playbackStopped = true;
        this.emit({ kind: 'lifecycle', name: 'Provider output buffer clear confirmed', responseId: event.response_id });
        this.finishResponse();
        break;
      case 'conversation.item.deleted':
        if (!this.active?.items.has(event.item_id)) break;
        this.active.deleted.add(event.item_id);
        this.emit({ kind: 'lifecycle', name: 'Interrupted context deletion confirmed', responseId: this.active.id });
        this.finishResponse();
        break;
      case 'error':
        if (event.error.code === 'response_cancel_not_active' && event.error.event_id === this.active?.cancelId) {
          this.emit({ kind: 'lifecycle', name: 'Cancellation raced completed generation; awaiting cleanup confirmations' });
        } else this.fault(`Azure Realtime error (${event.error.code ?? 'unspecified'}). Call stopped.`);
        break;
      case 'session.updated':
        if (event.session.audio.input.turn_detection.create_response || event.session.audio.input.turn_detection.interrupt_response)
          this.fault('Azure session configuration changed: automatic response controls must stay disabled.');
        break;
    }
  }

  private async inputTranscript(itemId: string, transcript: string) {
    if (!this.turn && !this.disposed) { this.fault('Input transcript arrived without a speech-start event. No response was authorized.'); return; }
    if (this.turn?.id !== itemId || this.turn.transcript !== undefined || this.disposed) return;
    this.clearDeadline('transcription');
    this.turn.transcript = transcript;
    if (!transcript.trim()) { this.requestResponse(recovery.uncertain); return; }
    const epoch = this.epoch;
    const turn = this.turn;
    const context = [...this.context];
    this.emit({ kind: 'transcript', name: 'Input transcript ready', role: 'user', phase: 'input', text: transcript });
    if (turn.stoppedAt !== undefined) this.emit({ kind: 'metric', name: 'Transcription event delay (server)', durationMs: this.now() - turn.stoppedAt });
    this.emit({ kind: 'check-start', name: 'Input check started', phase: 'input' });
    this.inputAbort?.abort();
    this.inputAbort = new AbortController();
    try {
      const verdict = await bounded(signal => this.judge({ phase: 'input', text: transcript, recentContext: context, final: true }, signal),
        this.timeoutMs, this.inputAbort.signal);
      if (this.disposed || epoch !== this.epoch) return;
      this.emit({ kind: 'check-end', name: `Input ${verdict.decision}`, phase: 'input', verdict });
      if (verdict.decision === 'allow') {
        this.context.push({ role: 'user', text: transcript });
        this.context = this.context.slice(-8);
        this.approvedRefs.push(itemId);
        this.approvedRefs = this.approvedRefs.slice(-8);
        this.requestResponse();
      } else {
        const policy = verdict.policies.find(p => p.decision === 'violate')?.policy;
        this.requestResponse(recovery[policy ?? 'uncertain']);
      }
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) this.fault(errorMessage(error));
    }
  }

  private requestResponse(recoveryText?: string) {
    if (this.disposed || !this.turn) return;
    if (this.active || this.pending) { this.deferred = { turn: this.turn.number, recoveryText }; return; }
    const request: Request = {
      id: randomUUID(), turn: this.turn.number, inputId: this.turn.id, recoveryText, stage: 'armed', stale: false,
    };
    this.pending = request;
    this.hooks.browser({ type: 'arm', requestId: request.id, turn: request.turn, inputItemId: request.inputId });
    this.deadline('response', 8000, 'Browser authorization or Azure response creation was not confirmed.');
  }

  armed(requestId: string) {
    const request = this.pending;
    if (this.disposed || !request || request.id !== requestId || request.stage !== 'armed' || request.turn !== this.turn?.number) return;
    request.stage = 'creating';
    this.emit({ kind: 'lifecycle', name: request.recoveryText ? 'Constrained recovery authorized' : 'Input allowed; response explicitly authorized' });
    this.send({ type: 'response.create', response: {
      metadata: { relay_request: request.id, relay_turn: String(request.turn) },
      output_modalities: ['audio'],
      tools: [],
      ...(request.recoveryText ? {
        input: [],
        instructions: `Speak exactly this fixed support redirect, with no additions: ${JSON.stringify(request.recoveryText)}. Do not answer prior user requests.`,
      } : { input: this.approvedRefs.map(id => ({ type: 'item_reference', id })) }),
    } });
  }

  private responseCreated(id: string, requestId?: string) {
    const pending = this.pending;
    if (!pending || pending.id !== requestId || pending.stage !== 'creating' || this.active) {
      this.send({ type: 'response.cancel', response_id: id });
      if (this.outputMode === 'monitor') this.send({ type: 'output_audio_buffer.clear' });
      this.fault('Unexpected or automatic response. Call stopped before any further authorization.');
      return;
    }
    this.clearDeadline('response');
    this.pending = undefined;
    this.active = {
      id, turn: pending.turn, recovery: !!pending.recoveryText, parts: new Map(), items: new Set(), deleted: new Set(),
      revision: 0, checked: -1, offered: '', done: false, playbackStopped: false, playbackStarted: false, interrupted: false, cleared: false, muted: false, clearRequested: false,
      requestId: pending.id, audio: new PcmResponseBuffer(), audioSealed: false, finalChecked: false, releaseSent: false, localStarted: false,
    };
    this.deadline('generation', 45000, 'Response generation/playback lifecycle exceeded 45 seconds.');
    this.emit({ kind: 'lifecycle', name: 'Response started', responseId: id });
    if (this.outputMode === 'gated') {
      this.hooks.browser({ type: 'audio-start', responseId: id, requestId: pending.id, turn: pending.turn });
      this.emit({ kind: 'lifecycle', name: 'Output held; collecting native audio and checking text', delivery: 'held', responseId: id });
    }
    if (pending.stale || pending.turn !== this.turn?.number) this.interrupt('Superseded response creation');
  }

  private audioEvent(event: Extract<RealtimeEvent, { type: 'response.output_audio.delta' | 'response.output_audio.done' }>) {
    const active = this.active;
    if (this.outputMode !== 'gated' || !active || active.id !== event.response_id || active.interrupted) return;
    const part: AudioPartId = { itemId: event.item_id, outputIndex: event.output_index, contentIndex: event.content_index };
    try {
      if (active.done) throw new Error('Audio arrived after generation completion.');
      active.items.add(part.itemId);
      if (event.type === 'response.output_audio.delta') {
        active.audio.append(part, decodePcm(event.delta));
        this.hooks.browser({ type: 'audio-chunk', responseId: active.id, part, data: event.delta });
      } else {
        active.audio.finishPart(part);
        this.hooks.browser({ type: 'audio-part-done', responseId: active.id, part });
      }
    } catch { this.fault('Native output audio was malformed, incomplete or exceeded the 30-second buffer. Nothing was released.'); }
  }

  private updatePart(itemId: string, output: number, content: number, text: string, final: boolean) {
    const active = this.active;
    if (!active) return;
    const key = `${itemId}:${content}`;
    const prior = active.parts.get(key);
    if (prior?.final && (!final || prior.text === text)) return;
    const nextText = final ? text : (prior?.text ?? '') + text;
    active.parts.set(key, { output, content, text: nextText, final });
    if (nextText !== prior?.text) active.revision++;
    const full = this.text();
    if (full.length > MAX_TEXT) { this.fault('Output transcript exceeds the local guardrail size limit.'); return; }
    if (full.trim()) {
      this.clearDeadline('output-transcript');
      if (active.playbackStarted && !active.playbackStopped && [...active.parts.values()].some(p => !p.final))
        this.deadline('output-transcript', 2500, 'Output transcription stalled while audio was playing.');
    }
    this.emit({ kind: 'transcript', name: 'Assistant generated transcript (not aligned to heard audio)', role: 'assistant', phase: 'output', responseId: active.id, revision: active.revision, text: full });
    if (final) this.snapshot(true);
  }

  private text() {
    return [...(this.active?.parts.values() ?? [])].sort((a, b) => a.output - b.output || a.content - b.content).map(p => p.text).join('\n');
  }
  private snapshot(final: boolean) {
    const active = this.active;
    if (!active || active.interrupted || this.disposed || !this.text().trim()) return;
    const isFinal = this.outputMode === 'gated' ? active.done : final || active.done;
    const key = `${active.revision}:${isFinal}`;
    if (active.offered === key || (!final && active.offered.startsWith(`${active.revision}:`))) return;
    active.offered = key;
    this.scheduler.offer({
      phase: 'output', text: this.text(), final: isFinal, recentContext: [...this.context],
      responseId: active.id, revision: active.revision, turn: active.turn,
    }, isFinal);
  }
  private outputVerdict(snapshot: Snapshot, verdict: Verdict) {
    const active = this.active;
    if (this.disposed || !active || active.id !== snapshot.responseId || active.turn !== snapshot.turn || active.interrupted) return;
    this.emit({ kind: 'check-end', name: `Output ${verdict.decision}${verdict.decision === 'allow' ? ' so far' : ''}`,
      phase: 'output', responseId: active.id, revision: snapshot.revision, verdict });
    if (verdict.decision !== 'allow') {
      const policy: PolicyId | undefined = verdict.policies.find(p => p.decision === 'violate')?.policy;
      if (active.recovery) { this.fault('Constrained recovery did not pass output monitoring. Speech stopped; no recovery loop.'); return; }
      this.interrupt(verdict.decision === 'violate' ? `Output violation: ${policy ?? 'policy'}` : 'Output uncertain; speech paused',
        recovery[policy ?? 'output']);
      return;
    }
    active.checked = Math.max(active.checked, snapshot.revision);
    if (snapshot.final && active.done && snapshot.revision === active.revision) active.finalChecked = true;
    this.finishResponse();
  }

  private responseDone(event: Extract<RealtimeEvent, { type: 'response.done' }>) {
    const active = this.active;
    if (!active || active.id !== event.response.id) return;
    for (const [index, item] of (event.response.output ?? []).entries()) {
      active.items.add(item.id);
      if (!active.interrupted) for (const [contentIndex, part] of (item.content ?? []).entries()) {
        if (part.transcript !== undefined) this.updatePart(item.id, index, contentIndex, part.transcript, true);
      }
    }
    active.done = true;
    if (!active.interrupted && event.response.status !== 'completed') {
      this.fault(`Azure generation ended with status ${event.response.status}; not a guardrail detection.`); return;
    }
    this.emit({ kind: 'lifecycle', name: 'Generation ended; final checks/playback may still be pending', responseId: active.id });
    if (!active.interrupted && !this.text().trim()) { this.fault('Response ended without an output transcript.'); return; }
    if (this.outputMode === 'gated' && !active.interrupted && !active.audioSealed) {
      try {
        const summaries = active.audio.summaries();
        const expected = (event.response.output ?? []).flatMap((item, outputIndex) =>
          (item.content ?? []).flatMap((part, contentIndex) => ['audio', 'output_audio'].includes(part.type)
            ? [{ itemId: item.id, outputIndex, contentIndex }] : []));
        if (!expected.length || expected.length !== summaries.length || expected.some(id => {
          const transcript = active.parts.get(`${id.itemId}:${id.contentIndex}`);
          return !summaries.some(part => audioPartKey(part) === audioPartKey(id))
            || !transcript?.final || !transcript.text.trim() || transcript.output !== id.outputIndex;
        })) throw new Error('Audio parts do not match complete final transcripts.');
        active.audio.seal(summaries);
        active.audioSealed = true;
        active.audio.discard();
        this.hooks.browser({ type: 'audio-complete', responseId: active.id, requestId: active.requestId,
          turn: active.turn, revision: active.revision, parts: summaries });
        this.emit({ kind: 'lifecycle', name: 'Native audio fully delivered; final transcript ready; awaiting final gate', responseId: active.id, delivery: 'held' });
      } catch { this.fault('Native response ended without complete matching audio. Buffered output discarded.'); return; }
    }
    if (active.interrupted) this.clearInterruptedOutput();
    else this.snapshot(true);
    this.finishResponse();
  }

  private interrupt(reason: string, recoveryText?: string) {
    const active = this.active;
    if (!active || active.interrupted) return;
    active.interrupted = true;
    active.audio.discard();
    active.recoveryText = recoveryText;
    active.actionId = randomUUID();
    this.scheduler.reset();
    this.clearDeadline('output-transcript');
    this.hooks.browser({ type: 'mute', actionId: active.actionId, responseId: active.id, turn: active.turn });
    this.emit({ kind: 'interrupt', name: reason, responseId: active.id, ...(this.outputMode === 'gated' ? { delivery: 'blocked' as const } : {}) });
    if (!active.done) {
      active.cancelId = randomUUID();
      this.send({ type: 'response.cancel', response_id: active.id, event_id: active.cancelId });
    }
    this.clearInterruptedOutput();
    this.deadline('cleanup', 6000, 'Interruption cleanup was not confirmed. Audio stays stopped; restart the call.');
  }
  private clearInterruptedOutput() {
    const active = this.active;
    if (!active?.interrupted || !active.done || active.clearRequested) return;
    // Clearing before generation ends can let in-flight audio refill the buffer.
    active.clearRequested = true;
    if (this.outputMode === 'monitor') this.send({ type: 'output_audio_buffer.clear' });
    active.items.forEach(id => this.deleteItem(id));
  }
  private deleteItem(id: string) {
    const active = this.active;
    if (!active || active.deleted.has(id) || this.timers.has(`delete:${id}`)) return;
    this.approvedRefs = this.approvedRefs.filter(ref => ref !== id);
    this.deadline(`delete:${id}`, 6000, 'Interrupted assistant context deletion was not confirmed.');
    this.send({ type: 'conversation.item.delete', item_id: id });
  }
  muted(actionId: string, durationMs: number) {
    if (this.active?.actionId !== actionId) return;
    this.active.muted = true;
    this.emit({ kind: 'metric', name: 'Browser command-receipt to mute (not network transit)', durationMs, responseId: this.active.id });
    this.finishResponse();
  }
  localPlayback(responseId: string, requestId: string, state: 'started' | 'ended') {
    const active = this.active;
    if (this.disposed || this.outputMode !== 'gated' || !active || active.id !== responseId
      || active.requestId !== requestId || active.interrupted || active.turn !== this.turn?.number) return;
    if (!active.releaseSent || (state === 'ended' && !active.localStarted)) {
      this.fault('Unapproved local playback acknowledgment. Buffered speech stopped.'); return;
    }
    if (state === 'started') {
      if (active.localStarted) return;
      active.localStarted = true;
      this.clearDeadline('local-playback-start');
      this.deadline('local-playback', (MAX_OUTPUT_SECONDS + 5) * 1000, 'Local audio playback did not finish; call stopped.');
      this.emit({ kind: 'lifecycle', name: 'Approved local playback started', responseId, delivery: 'playing' });
    } else {
      active.playbackStopped = true;
      this.clearDeadline('local-playback');
      this.emit({ kind: 'lifecycle', name: 'Approved local playback ended', responseId, delivery: 'ended' });
      this.finishResponse();
    }
  }
  private finishResponse() {
    const active = this.active;
    if (!active || !active.done) return;
    if (active.interrupted) {
      if ((this.outputMode === 'monitor' && !active.cleared) || !active.muted || [...active.items].some(id => !active.deleted.has(id))) return;
      active.items.forEach(id => this.clearDeadline(`delete:${id}`));
      this.clearDeadline('cleanup');
    } else {
      if (this.outputMode === 'gated') {
        if (!active.audioSealed || !active.finalChecked) return;
        if (!active.releaseSent) {
          active.releaseSent = true;
          this.clearDeadline('generation');
          this.deadline('local-playback-start', 5000, 'Approved local audio did not start; call stopped.');
          this.emit({ kind: 'lifecycle', name: 'Final output allowed; releasing complete native audio', responseId: active.id, revision: active.revision, delivery: 'approved' });
          this.hooks.browser({ type: 'audio-release', responseId: active.id, requestId: active.requestId, turn: active.turn, revision: active.revision });
          return;
        }
      }
      if (!active.playbackStopped || active.checked !== active.revision) return;
      this.context.push({ role: 'assistant', text: this.text() });
      this.context = this.context.slice(-8);
      this.approvedRefs.push(...active.items);
      this.approvedRefs = this.approvedRefs.slice(-8);
    }
    this.clearDeadline('generation');
    this.clearDeadline('local-playback-start');
    this.clearDeadline('local-playback');
    this.clearDeadline('output-transcript');
    this.scheduler.reset();
    this.active = undefined;
    this.emit({ kind: 'status', name: active.interrupted ? 'Interrupted context reconciled' : 'Listening' });
    const deferred = this.deferred;
    this.deferred = undefined;
    if (deferred && deferred.turn === this.turn?.number) this.requestResponse(deferred.recoveryText);
    else if (active.recoveryText && active.turn === this.turn?.number) this.requestResponse(active.recoveryText);
  }
  fault(message: string) {
    if (this.disposed) return;
    this.emit({ kind: 'error', name: message });
    if (this.active && !this.active.interrupted) this.interrupt('Guardrail unavailable; not a policy detection');
    this.hooks.browser({ type: 'fatal', message });
    this.close();
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.audio.discard();
    this.epoch++;
    this.inputAbort?.abort();
    this.scheduler.reset();
    clearInterval(this.tick);
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.pending = undefined;
    this.deferred = undefined;
  }
}
