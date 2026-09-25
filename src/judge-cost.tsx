import { costSummary, usd, type JudgeUsage, type Pricing, type Rates } from '../shared/judge-cost';
import type { Provider } from '../shared/protocol';

export function JudgeCost({ records, label }: { records?: JudgeUsage[]; label: string }) {
  const summary = costSummary(records ?? []);
  return <section className="card cost-panel" aria-label={`${label} judge cost`}>
    <div className="section-header"><h2>Estimated judge cost (USD)</h2><span>{label}</span></div>
    <strong>{records === undefined || !summary.calls ? 'Not measured' : summary.priced ? usd(summary.subtotal) : 'Usage/pricing unavailable'}</strong>
    <p>{summary.calls ? `${summary.priced === summary.calls ? 'Estimate' : 'Known-usage subtotal / partial estimate'} · ${summary.reported}/${summary.calls} calls with reported usage · ${summary.unavailable} unavailable · ${summary.pending} pending or canceled without a final usage update.` : 'No reported judge calls for this session/run.'}</p>
    <details><summary>Token usage and breakdown</summary>
      <p>{summary.input} reported input tokens (including {summary.cached} reported cached tokens) · {summary.output} output tokens. Reasoning tokens are already included in output totals.</p>
      {(['jev', 'llm'] as const).map(provider => <div key={provider}><strong>{provider === 'jev' ? 'Jev' : 'LLM judge'}</strong>{(['input', 'output'] as const).map(phase => {
        const own = costSummary((records ?? []).filter(r => r.provider === provider && r.phase === phase));
        return <p key={phase}>{phase} checks: {own.priced ? usd(own.subtotal) : '--'} · {own.calls} calls · {own.priced} priced</p>;
      })}</div>)}
      {(records ?? []).filter(r => r.warning).slice(-3).map(r => <p key={r.callId}>{r.provider}: {r.warning}</p>)}
    </details>
    <p className="muted-note">Judge calls only, including recovery and superseded checks. Excludes voice/transcription and is not an invoice. Missing usage or prices never count as free calls. Rates are captured per request; changing the form does not reprice history.</p>
  </section>;
}
export function PricingSettings({ value, change, disabled, models }: {
  value: Pricing; change: (pricing: Pricing) => void; disabled: boolean; models: Record<Provider, string>;
}) {
  const edit = (provider: Provider, key: 'input' | 'cachedInput' | 'output', number: number) => {
    const previous: Rates = value[provider] ?? { input: null, cachedInput: null, output: null, model: models[provider], source: 'Custom', asOf: 'User configured' };
    const next = Number.isFinite(number) && number >= 0 && number <= 10000 ? number : null;
    change({ ...value, [provider]: { ...previous, [key]: next, ...(provider === 'jev' ? { cachedInput: next, output: 0 } : {}), source: 'Custom', asOf: 'User configured' } });
  };
  return <details className="card price-settings"><summary>Judge token prices · USD per 1 million tokens</summary>
    <p>Reference prices as of September 25, 2026. Actual deployment charges may differ. Unknown models require user prices. Blank/invalid rates make costs unavailable, not voice unavailable. Valid range: 0–10000.</p>
    {(['jev', 'llm'] as const).map(provider => <div key={provider}>
      <strong>{provider === 'jev' ? 'Jev' : 'LLM judge'} · {value[provider]?.model || models[provider]} · {value[provider]?.source ?? 'No model price available'}</strong>
      <div className="price-fields">{(['input', 'cachedInput', 'output'] as const).filter(k => provider === 'llm' || k === 'input').map(key =>
        <label key={key}>{provider} {key === 'cachedInput' ? 'cached input' : key} USD/M<input type="number" min={0} max={10000} step="any" disabled={disabled} value={value[provider]?.[key] ?? ''} onChange={e => edit(provider, key, e.currentTarget.valueAsNumber)} /></label>)}</div>
      {provider === 'jev' && <p>TypeSafe publishes input-only pricing; output is free. No separate cache discount is documented.</p>}
    </div>)}
    <p><a href="https://docs.typesafe.ai/models" target="_blank" rel="noreferrer">TypeSafe prices</a> · <a href="https://docs.typesafe.ai/api" target="_blank" rel="noreferrer">TypeSafe usage</a> · <a href="https://developers.openai.com/api/docs/models/gpt-5.4-mini" target="_blank" rel="noreferrer">OpenAI reference prices</a></p>
  </details>;
}
