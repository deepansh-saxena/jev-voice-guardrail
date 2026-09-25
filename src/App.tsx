import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, ChevronRight, CircleHelp, FlaskConical, Headphones, Layers3, LockKeyhole, Mic, Play, Radio, ShieldCheck, Square, TriangleAlert, X } from 'lucide-react';
import { cases } from '../shared/cases';
import { CHECK_INTERVAL_MS, KB_VERSION, knowledge, phasePolicies, policies, POLICY_VERSION, type AgentMode } from '../shared/policies';
import { distribution } from '../shared/metrics';
import type { LabEvent, Provider, Readiness } from '../shared/protocol';
import type { EvalResult } from '../server/evaluation';
import { examples, playFixture } from './fixture';
import { LiveCall } from './live';

const ms = (n: number | null | undefined) => n == null ? '--' : `${Math.round(n)} ms`;
const providerName = (p: string) => p === 'jev' ? 'Jev' : p === 'llm' ? 'LLM judge' : 'Fixture oracle';

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Waveform({ active }: { active: boolean }) {
  return <div className={`waveform ${active ? 'moving' : ''}`} aria-hidden="true">
    {Array.from({ length: 49 }, (_, i) => <span key={i} style={{ height: `${12 + Math.abs(Math.sin(i * 1.6) * Math.cos(i * 0.24)) * 61}px`, animationDelay: `${i * -0.08}s` }} />)}
  </div>;
}
function download(data: unknown, name: string) {
  const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = href; anchor.download = name; anchor.click();
  URL.revokeObjectURL(href);
}

export default function App() {
  const [tab, setTab] = useState<'lab' | 'replay' | 'knowledge'>('lab');
  const [source, setSource] = useState<'fixture' | 'live'>('live');
  const [provider, setProvider] = useState<Provider>('jev');
  const [mode, setMode] = useState<AgentMode>('normal');
  const [example, setExample] = useState('roadmap');
  const [ready, setReady] = useState<Readiness>();
  const [events, setEvents] = useState<LabEvent[]>([]);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('Ready to explore');
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<EvalResult>();
  const [evaluating, setEvaluating] = useState(false);
  const [split, setSplit] = useState<'all' | 'tuning' | 'held-out'>('held-out');
  const [filter, setFilter] = useState<'all' | 'input' | 'output'>('all');
  const stopRef = useRef<(() => void) | undefined>(undefined);
  const evalAbort = useRef<AbortController | undefined>(undefined);
  const eventEnd = useRef<HTMLDivElement>(null);
  const emit = (event: LabEvent) => setEvents(previous => [...previous.slice(-599), event]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/readiness', { signal: controller.signal }).then(async res => {
      if (!res.ok) throw new Error('Cannot read local provider readiness.');
      setReady(await res.json());
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Local API unavailable.'); });
    fetch('/api/evaluations/latest', { signal: controller.signal }).then(async res => {
      if (!res.ok) throw new Error('Cannot read the latest local replay report.');
      const data: EvalResult | null = await res.json();
      if (data) setResult(data);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Latest replay report unavailable.'); });
    return () => { controller.abort(); stopRef.current?.(); evalAbort.current?.abort(); };
  }, []);
  useEffect(() => { eventEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [events.length]);
  const busy = active || evaluating;
  const liveReady = ready?.azure.configured && ready[provider].configured;
  const missingLive = ready ? [...ready.azure.missing, ...ready[provider].missing] : [];
  const transcripts = new Map<string, LabEvent>();
  events.filter(e => e.kind === 'transcript').forEach(e => transcripts.set(e.responseId ?? `user-${e.turn}`, e));
  const checks = events.filter(e => e.kind === 'check-end');
  const inputCheck = checks.findLast(e => e.phase === 'input');
  const outputCheck = checks.findLast(e => e.phase === 'output');
  const inputMetrics = distribution(checks.filter(e => e.phase === 'input').flatMap(e => e.verdict?.serviceMs == null ? [] : [e.verdict.serviceMs]));
  const outputMetrics = distribution(checks.filter(e => e.phase === 'output').flatMap(e => e.verdict?.serviceMs == null ? [] : [e.verdict.serviceMs]));
  const audioMetrics = distribution(events.filter(e => e.kind === 'metric' && e.name === 'speech-end-to-audio-energy').flatMap(e => e.durationMs === undefined ? [] : [e.durationMs]));
  const interruptions = events.filter(e => e.kind === 'interrupt' && /violation|detect and interrupt/.test(e.name)).length;
  const shownStatus = active ? (events.findLast(e => e.kind === 'status' || e.kind === 'lifecycle')?.name ?? status) : status;
  const stop = () => { stopRef.current?.(); stopRef.current = undefined; setActive(false); setStatus('Stopped'); };
  const start = () => {
    setEvents([]); setError(undefined); setActive(true);
    if (source === 'fixture') {
      setStatus('Playing authored events');
      stopRef.current = playFixture(example, mode, emit, () => { setActive(false); setStatus('Fixture complete'); stopRef.current = undefined; });
    } else {
      const call = new LiveCall({ event: emit, status: setStatus, error: message => { setError(message); setActive(false); } });
      stopRef.current = () => call.stop();
      void call.start(provider, mode);
    }
  };
  const runEval = async (evalSource: 'fixture' | 'provider-replay') => {
    const controller = new AbortController();
    evalAbort.current = controller;
    setEvaluating(true); setError(undefined); setResult(undefined);
    try {
      const response = await fetch('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: evalSource, split }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Evaluation failed.');
      setResult(data);
    } catch (e) { setError(controller.signal.aborted ? 'Evaluation canceled.' : e instanceof Error ? e.message : 'Evaluation failed.'); }
    finally { setEvaluating(false); evalAbort.current = undefined; }
  };
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Relay Guardrail Lab home"><div className="brand-mark"><AudioLines size={24} /></div><span>relay<span className="brand-dot">.</span></span></a>
      <div className="workspace-label">WORKSPACE</div>
      <div className="workspace"><span className="workspace-icon">R</span><div>Guardrail Lab<small>Local prototype</small></div><ChevronRight size={15} /></div>
      <nav aria-label="Main navigation">
        <button className={tab === 'lab' ? 'selected' : ''} onClick={() => setTab('lab')}><Radio size={19} />Voice lab<span className="nav-dot" /></button>
        <button className={tab === 'replay' ? 'selected' : ''} onClick={() => setTab('replay')}><Layers3 size={19} />Replay bench<small>60</small></button>
        <button className={tab === 'knowledge' ? 'selected' : ''} onClick={() => setTab('knowledge')}><BookOpen size={19} />Knowledge & policies</button>
      </nav>
      <div className="sidebar-bottom"><div className="small-icon"><ShieldCheck size={19} /></div><strong>Built to be observable.</strong><p>See what was checked, when it was checked, and what happened next.</p><span className="local-dot" /> Running on localhost</div>
      <div className="sidebar-foot"><span className="avatar">RL</span><div>Relay demo workspace<small>Synthetic data only</small></div><LockKeyhole size={14} /></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div>Workspace <ChevronRight size={13} /><strong>{tab === 'lab' ? 'Voice lab' : tab === 'replay' ? 'Replay bench' : 'Knowledge & policies'}</strong></div><div><span className="environment"><span className="local-dot" /> LOCAL ENVIRONMENT</span><span className="version">v0.1</span></div></header>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={tab === 'lab' ? 'selected' : ''} onClick={() => setTab('lab')}><Radio size={15} />Voice lab</button>
        <button className={tab === 'replay' ? 'selected' : ''} onClick={() => setTab('replay')}><Layers3 size={15} />Replay bench</button>
        <button className={tab === 'knowledge' ? 'selected' : ''} onClick={() => setTab('knowledge')}><BookOpen size={15} />Knowledge</button>
      </nav>
      <main>
        <div className="page-heading">
          <div><div className="eyebrow">RELAY GUARDRAIL LAB</div><h1>{tab === 'lab' ? <>Voice, with boundaries<span>.</span></> : tab === 'replay' ? <>Same evidence. Honest comparison<span>.</span></> : <>Context is part of the test<span>.</span></>}</h1>
            <p>{tab === 'lab' ? 'A hands-on lab for input gates and live output interruption.' : tab === 'replay' ? 'Replay authored transcript snapshots independently through both judges.' : 'Versioned operating policies, grounded in a fully synthetic product.'}</p></div>
          <Badge tone={source === 'fixture' ? 'amber' : 'green'}><FlaskConical size={13} />{source === 'fixture' ? 'Fixture mode' : 'Live providers'}</Badge>
        </div>
        {error && <div className="error-banner" role="alert"><TriangleAlert size={19} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(undefined)}><X size={16} /></button></div>}
        {tab === 'lab' && <>
          {source === 'live' && !liveReady && <section className="live-setup card">
            <div className="live-setup-icon"><Mic size={22} /></div>
            <div><h2>{ready ? 'Live voice is not ready yet' : 'Checking live voice setup'}</h2><p>{ready
              ? 'Add the remaining configuration below to the backend .env and restart the API. The microphone stays off until the input guardrail can run.'
              : 'Reading the local backend configuration. No microphone has been requested.'}</p>
              <div className="missing-settings">{missingLive.map(key => <code key={key}>{key}</code>)}</div>
              {missingLive.includes('AZURE_TRANSCRIPTION_DEPLOYMENT') && <p>Use an existing transcription deployment name on the Sweden Central Azure resource. A realtime deployment name is not a transcription deployment.</p>}
              <button className="text-button" disabled={busy} onClick={() => setSource('fixture')}>Explore a simulated fixture instead <ArrowRight size={13} /></button></div>
          </section>}
          <div className="mode-banner"><FlaskConical size={18} /><div><strong>{source === 'fixture' ? 'Explore without credentials.' : 'Native Azure speech-to-speech.'}</strong> {source === 'fixture' ? 'Authored text and event playback. No microphone, recordings, model predictions or measured provider latency.' : 'Input gates response creation, not audio ingestion. Output is detect-and-interrupt, not zero leakage.'}</div><button onClick={() => setTab('replay')}>About the evidence <ArrowRight size={14} /></button></div>
          <section className="configuration card" aria-label="Session configuration">
            <div className="config-field"><label>SESSION SOURCE</label><div className="segmented"><button disabled={busy} className={source === 'fixture' ? 'chosen' : ''} onClick={() => { setSource('fixture'); setEvents([]); }}><FlaskConical size={14} />Fixture</button><button disabled={busy} className={source === 'live' ? 'chosen' : ''} onClick={() => { setSource('live'); setEvents([]); }}><Radio size={14} />Live</button></div></div>
            <div className="config-field"><label htmlFor="judge">ENFORCING JUDGE</label><select id="judge" disabled={busy || source === 'fixture'} value={provider} onChange={e => setProvider(e.target.value as Provider)}>{source === 'fixture' ? <option value={provider}>Authored fixture oracle</option> : <><option value="jev">Jev · TypeSafe</option><option value="llm">Structured-output LLM</option></>}</select></div>
            <div className="config-field agent-config"><label>VOICE CONFIGURATION</label><div className="segmented"><button disabled={busy} className={mode === 'normal' ? 'chosen' : ''} onClick={() => setMode('normal')}>Normal agent</button><button disabled={busy} className={mode === 'stress' ? 'chosen stress' : ''} onClick={() => setMode('stress')}>Stress test</button></div></div>
          </section>
          {mode === 'stress' && <div className="stress-note"><TriangleAlert size={15} />Synthetic output restrictions are enforced externally only. Same knowledge, unchanged input gates. Not representative of normal model failure rates.</div>}
          <div className="lab-grid">
            <div className="lab-primary">
              <section className="voice-stage">
                <div className="stage-top"><Badge tone="dark"><span className={active ? 'pulse-dot' : 'idle-dot'} />{source === 'fixture' ? 'SYNTHETIC EVENT STREAM' : 'NATIVE WEBRTC AUDIO'}</Badge><Headphones size={18} /></div>
                <div className="stage-center"><div className="voice-symbol"><AudioLines size={25} /></div><h2>{active ? (source === 'fixture' ? 'Watching the boundaries' : 'Relay is listening') : source === 'live' && !liveReady ? 'Finish live voice setup' : 'Meet your Relay assistant'}</h2><p>{source === 'fixture' ? 'See how a conversation moves through the guardrails.' : 'Ask about plans, billing or support. Headphones recommended.'}</p><Waveform active={active} /></div>
                <div className="stage-bottom"><div className="stage-status"><span className={active ? 'pulse-dot' : 'idle-dot'} /><span>{source === 'live' && !liveReady ? 'Setup required · microphone off' : shownStatus}</span></div>
                  <button className={`primary-button ${active ? 'stop-button' : ''}`} disabled={!active && (evaluating || (source === 'live' && !liveReady))} onClick={active ? stop : start}>{active ? <Square size={15} fill="currentColor" /> : source === 'fixture' ? <Play size={16} fill="currentColor" /> : <Mic size={17} />}{active ? 'Stop session' : source === 'fixture' ? 'Play fixture' : 'Start microphone'}</button></div>
              </section>

              <section className="card conversation"><div className="section-header"><h2><AudioLines size={17} />Conversation</h2><Badge>{source === 'fixture' ? 'Authored text' : 'Generated transcript'}</Badge></div>
                <div className="messages" aria-live="polite">
                  {!transcripts.size ? <div className="empty-conversation"><div className="empty-icon"><Mic size={23} /></div><strong>A little conversation. A lot of visibility.</strong><p>Pick an example below, then {source === 'fixture' ? 'play the fixture' : 'start your microphone'}.</p></div> : [...transcripts.values()].map(event => <div className={`message ${event.role}`} key={event.id}>
                    <span className="message-avatar">{event.role === 'user' ? 'Y' : <AudioLines size={15} />}</span><div><div className="message-label">{event.role === 'user' ? 'You' : 'Relay assistant'}<span>{event.role === 'user' ? 'Transcribed input' : source === 'fixture' ? 'Synthetic · not spoken' : 'Monitored · not audio-aligned'}</span></div><p>{event.text}</p></div></div>)}
                  <div ref={eventEnd} />
                </div>
                <div className="conversation-foot"><CircleHelp size={13} />Assistant text can include generated words that were never heard.</div>
              </section>
              <section className="examples"><div className="section-header"><h2>Try a conversation</h2><span>Authored scenarios</span></div><div className="example-grid">{examples.map(item => <button key={item.id} disabled={busy} className={`example ${example === item.id ? 'picked' : ''}`} onClick={() => setExample(item.id)}><span>{item.category}<ArrowRight size={13} /></span><strong>{item.title}</strong><p>“{item.text}”</p></button>)}</div>{source === 'live' && <p className="muted-note">Examples are speaking prompts; selecting one does not inject text or trigger a response.</p>}</section>
            </div>
            <div className="lab-secondary">
              <section className="card policy-panel"><div className="section-header"><h2><ShieldCheck size={17} />Guardrail monitor</h2><span className="local-dot" /></div>
                {(['input', 'output'] as const).map(phase => <div className="policy-group" key={phase}><div className="group-heading"><span className={`direction ${phase}`}>{phase === 'input' ? 'IN' : 'OUT'}</span><div><strong>{phase === 'input' ? 'Before the response' : 'While audio plays'}</strong><small>{phase === 'input' ? 'Allow, redirect or clarify' : `New-text checks every ${CHECK_INTERVAL_MS} ms`}</small></div></div>
                  {phasePolicies(phase).map(policy => {
                    const decision = (phase === 'input' ? inputCheck : outputCheck)?.verdict?.policies.find(p => p.policy === policy.id)?.decision;
                    return <div className="policy-row" key={policy.id}><span>{policy.name}</span><Badge tone={decision === 'allow' ? 'green' : decision === 'violate' ? 'red' : decision === 'uncertain' ? 'amber' : 'neutral'}>{decision === 'allow' ? <Check size={11} /> : decision === 'violate' ? <Square size={8} fill="currentColor" /> : null}{decision === 'allow' && phase === 'output' ? 'Clear so far' : decision ?? 'Waiting'}</Badge></div>;
                  })}</div>)}
                <div className="policy-foot"><LockKeyhole size={13} />A pass never approves future output.</div>
              </section>
              <section className="card readiness"><div className="section-header"><h2>Provider readiness</h2><span>Config only</span></div>
                {(['azure', 'jev', 'llm'] as const).map(key => <div className="provider-row" key={key}><span className={`provider-icon ${key}`}>{key === 'azure' ? 'A' : key === 'jev' ? 'J' : 'L'}</span><div><strong>{key === 'azure' ? 'Azure Realtime' : providerName(key)}</strong><small>{ready?.[key].configured ? 'Configuration present' : 'Configuration incomplete'}</small>{ready?.verification?.[key] && <small className="verification-note" title={ready.verification[key].checkedAt}>Prior check: {ready.verification[key].summary}</small>}</div><span className={`readiness-dot ${ready?.[key].configured ? 'is-ready' : ''}`} /></div>)}
                <details><summary>Required local configuration <ChevronRight size={13} /></summary><p>Edit <code>.env</code> and restart the API. Keys stay on the server.</p>{ready && [...ready.azure.missing, ...ready.jev.missing, ...ready.llm.missing].map(name => <code className="env-name" key={name}>{name}</code>)}<p>No automatic mock-provider fallback.</p></details>
              </section>
              <section className="principle"><div><Activity size={17} /><strong>Interrupt, don’t overclaim.</strong></div><p>No intentional pre-playback buffer. Some speech may be heard before a violation is detected. Fixture timings are not benchmarks.</p></section>
            </div>
          </div>
          <section className="metric-strip card"><div className="metric"><span>INPUT JUDGE</span><strong>{ms(inputMetrics.p50)}<small>p50</small></strong><p>p95 {ms(inputMetrics.p95)} · n={inputMetrics.count}</p></div><div className="metric"><span>OUTPUT JUDGE</span><strong>{ms(outputMetrics.p50)}<small>p50</small></strong><p>p95 {ms(outputMetrics.p95)} · n={outputMetrics.count}</p></div><div className="metric"><span>SPEECH END → AUDIO ENERGY</span><strong>{ms(audioMetrics.p50)}<small>p50</small></strong><p>Browser estimate · not hardware-audible time</p></div><div className="metric"><span>{source === 'fixture' ? 'SIMULATED INTERRUPTIONS' : 'DETECTED VIOLATIONS'}</span><strong>{checks.length ? interruptions : '--'}</strong><p>{source === 'fixture' ? 'No measured provider samples' : 'Outages are not detections'}</p></div></section>
          <section className="card timeline"><div className="section-header"><h2><Activity size={17} />Event timeline</h2><button className="text-button" disabled={!events.length} onClick={() => download({ source, events, policyVersion: POLICY_VERSION, kbVersion: KB_VERSION }, 'relay-session.json')}><ArrowDownToLine size={14} />Export JSON</button></div><div className="timeline-body">{events.filter(e => e.kind !== 'transcript').length ? events.filter(e => e.kind !== 'transcript').slice(-50).map(event => <div className="timeline-row" key={event.id}><span className={`timeline-dot ${event.kind}`} /><time>{(event.atMs / 1000).toFixed(2)}s</time><span>{event.name}</span><small>{event.durationMs !== undefined ? ms(event.durationMs) : event.verdict?.serviceMs != null ? ms(event.verdict.serviceMs) : event.clock}</small></div>) : <div className="empty-timeline">Your session events will appear here. Browser and server clocks are recorded separately.</div>}</div></section>
        </>}

        {tab === 'replay' && <>
          <div className="mode-banner"><Layers3 size={19} /><div><strong>No predetermined winner.</strong> Compare latency alongside accuracy, abstentions and coverage. Authored labels need independent human review.</div></div>
          <section className="card replay-controls"><div><h2>Run the same evidence</h2><p>One in-flight request and one replaceable pending snapshot per judge. Identical {CHECK_INTERVAL_MS} ms schedule and timeouts. Independent streams continue after a detection.</p></div><div className="replay-actions"><select aria-label="Evaluation split" value={split} disabled={busy} onChange={e => setSplit(e.target.value as typeof split)}><option value="held-out">Held-out · 30 cases</option><option value="tuning">Tuning · 30 cases</option><option value="all">All · 60 cases</option></select><button className="secondary-button" disabled={busy} onClick={() => void runEval('fixture')}><FlaskConical size={16} />Run fixture replay</button><button className="primary-button" disabled={busy || !ready?.jev.configured || !ready.llm.configured} onClick={() => void runEval('provider-replay')}><Play size={14} />Compare providers</button></div>{evaluating && <div className="evaluation-running" role="status"><span className="pulse-dot" />Replaying snapshots…<button className="text-button" onClick={() => evalAbort.current?.abort()}>Cancel</button></div>}</section>
          <div className="benchmark-grid">{(['jev', 'llm'] as const).map(p => {
            const summary = result?.source === 'provider-replay' ? result.summaries.find(s => s.provider === p) : undefined;
            return <section className="card benchmark" key={p}><div className="section-header"><h2><span className={`provider-icon ${p}`}>{p === 'jev' ? 'J' : 'L'}</span>{providerName(p)}</h2><Badge>{summary ? 'Measured service calls' : 'Not measured'}</Badge></div><p>{p === 'jev' ? `${ready?.jev.model ?? 'jev-1.13.0'} · independent typed decisions` : `${ready?.llm.model ?? 'No deployment configured'} · structured output`}</p><div className="benchmark-numbers"><div><span>Input p50 / p95</span><strong>{ms(summary?.input.p50)} / {ms(summary?.input.p95)}</strong></div><div><span>Output p50 / p95</span><strong>{ms(summary?.output.p50)} / {ms(summary?.output.p95)}</strong></div></div><div className="accuracy-row"><span>False positives <b>{summary?.falsePositives ?? '--'}</b></span><span>Misses <b>{summary?.misses ?? '--'}</b></span><span>Abstentions <b>{summary?.abstentions ?? '--'}</b></span></div><p className="muted-note">{summary ? `${summary.correct}/${summary.scoredPolicyDecisions} policy decisions matched authored labels; ${summary.errors} errors. Final-case verdict coverage: ${summary.finalCasesWithVerdict}/${summary.finalCasesChecked}. ${summary.checkedSnapshots} snapshots checked.` : 'No credentials or no measured run yet. Fixture values are never substituted.'}</p></section>;
          })}</div>
          {result && <section className="card result-panel"><div className="section-header"><h2>{result.source === 'fixture' ? 'Fixture replay complete' : 'Provider replay results'}</h2><button className="text-button" onClick={() => download(result, `relay-eval-${result.id}.json`)}><ArrowDownToLine size={14} />Export results</button></div><p>{result.source === 'fixture' ? `${result.rows.length} authored snapshots exercised the scheduler. Decisions echo authored labels; this is not model accuracy or latency evidence.` : `${result.rows.length} checked snapshots. Errors and uncertainty are reported separately from misses.`}</p><code>{result.file}</code><div className="results-table-wrap"><table><thead><tr><th>Case / snapshot</th><th>Source</th><th>Decision</th><th>Service time</th></tr></thead><tbody>{result.rows.map((r, i) => <tr key={`${r.provider}-${i}`}><td>{r.caseId} <small>+{r.snapshotAtMs} ms</small></td><td>{providerName(r.provider)}</td><td>{r.error ? <span className="error-text">{r.error}</span> : r.verdict?.decision}</td><td>{ms(r.verdict?.serviceMs)}</td></tr>)}</tbody></table></div></section>}
          <section className="card corpus"><div className="section-header"><h2>Review the evaluation corpus</h2><div className="segmented">{(['all', 'input', 'output'] as const).map(f => <button className={filter === f ? 'chosen' : ''} key={f} onClick={() => setFilter(f)}>{f}</button>)}</div></div><p>60 concrete cases, balanced across six policies. Odd IDs are tuning; even IDs are held-out. Labels are synthetic, authored for review, not independently validated.</p><div className="case-list">{cases.filter(c => filter === 'all' || c.phase === filter).map(c => <details key={c.id}><summary><code>{c.id}</code><span>{c.snapshots.at(-1)?.text}</span><Badge>{c.split}</Badge></summary><div className="case-detail"><p>{c.rationale}</p>{c.recentContext.length > 0 && <p><b>Recent context:</b> {c.recentContext.map(t => `${t.role}: ${t.text}`).join(' / ')}</p>}{c.snapshots.map(s => <div className="snapshot" key={s.atMs}><code>+{s.atMs} ms</code><p>{s.text}</p><span>{s.expected.map(p => `${p.policy}: ${p.decision}`).join(' · ')}</span></div>)}</div></details>)}</div></section>
          <div className="footnote"><CircleHelp size={16} /><p>Judge latency is server-monotonic HTTP service time, including network and response parsing. Coalescing may change which intermediate snapshots each provider sees; compare final-case coverage and report abstentions. No audio recordings or phrase alignment are supplied. “Miss” means an authored violation explicitly classified allow; uncertainty and errors remain separate.</p></div>
        </>}

        {tab === 'knowledge' && <>
          <div className="mode-banner"><BookOpen size={19} /><div><strong>Synthetic, but specific enough to test.</strong> Both voice configurations and both judges receive the same trusted knowledge. Speaker text stays in a separate untrusted field.</div></div>
          <div className="knowledge-grid"><section className="card knowledge-card"><div className="section-header"><h2>Operating policies</h2><Badge>{POLICY_VERSION}</Badge></div>{policies.map(p => <div className="knowledge-policy" key={p.id}><div><span className={`direction ${p.phase}`}>{p.phase === 'input' ? 'IN' : 'OUT'}</span><h3>{p.name}</h3></div><p>{p.rule}</p></div>)}</section><section className="card knowledge-card"><div className="section-header"><h2>Trusted product facts</h2><Badge>{KB_VERSION}</Badge></div><p className="knowledge-disclaimer">{knowledge.disclaimer}</p><h3>Public product knowledge</h3>{Object.entries(knowledge.public).map(([key, text]) => <div className="fact" key={key}><h4>{key}</h4><p>{text}</p></div>)}{(['roadmap', 'retention', 'competitors'] as const).map(key => <div className="restricted-fact" key={key}><Badge tone="amber">{knowledge[key].classification}</Badge><h3>{key === 'roadmap' ? 'Project Lantern' : key === 'retention' ? 'Internal retention offer' : 'Fictional competitors'}</h3><p>{knowledge[key].details}</p></div>)}</section></div>
          <section className="card design-notes"><h2>Where enforcement lives</h2><div><p><strong>Normal agent.</strong> Product facts and output restrictions are in the agent instructions. The external judge is a backstop.</p><p><strong>Stress test.</strong> Same product facts; synthetic output restrictions live only in the external judge. Provider safeguards and input gates are unchanged.</p><p><strong>Local prototype.</strong> Native Azure WebRTC media with a documented backend sideband controller. Browser muting is cooperative, not tamper-proof security. Real keys never go to the browser.</p></div></section>
        </>}
        <footer className="footer"><span><ShieldCheck size={13} />Relay is fictional. All restricted product facts are synthetic.</span><span>Observe honestly. Measure comparably.</span></footer>
      </main>
    </div>
  </div>;
}
