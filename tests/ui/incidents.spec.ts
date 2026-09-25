import { test, expect, type Page } from '@playwright/test';
import { phasePolicies, type Phase, type PolicyId } from '../../shared/policies';
import type { LabEvent } from '../../shared/protocol';
import { referencePricing, type JudgeUsage } from '../../shared/judge-cost';

let serial = 0;
function event(fields: Partial<LabEvent>): LabEvent {
  return { id: `ui-${++serial}`, atMs: serial * 10, clock: 'server', source: 'live', kind: 'lifecycle', name: '', turn: 1, ...fields };
}
function verdict(phase: Phase, ids: PolicyId[], fields: Partial<LabEvent> = {}) {
  return event({ kind: 'check-end', phase, verdict: {
    decision: ids.length ? 'violate' : 'allow', provider: 'llm', model: 'test-only', serviceMs: 1117, source: 'live',
    policies: phasePolicies(phase).map(p => ({ policy: p.id, decision: ids.includes(p.id) ? 'violate' : 'allow' })),
  }, ...fields });
}
async function deliver(page: Page, events: LabEvent[]) {
  await page.evaluate(batch => {
    const emit = Reflect.get(window, 'relayUiEvents') as (events: LabEvent[]) => void;
    emit(batch);
  }, events);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/evaluations/latest', route => route.fulfill({ json: null }));
  await page.route('**/api/readiness', route => route.fulfill({ json: {
    azure: { configured: true, missing: [], deployment: 'test-realtime' },
    jev: { configured: true, missing: [], model: 'test-jev' },
    llm: { configured: true, missing: [], model: 'test-llm', reasoning: 'none' },
    config: { intervalMs: 200, timeoutMs: 4000 },
  } }));
  // Test-only transport replacement: no microphone, server WebSocket or paid provider calls.
  await page.route('**/src/live.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export class LiveCall {
      constructor(callbacks) { this.callbacks = callbacks; }
      start(provider, mode, settings, pricing) { window.relayUiStart = { provider, mode, settings, pricing }; window.relayUiEvents = events => events.forEach(this.callbacks.event); this.callbacks.status('Listening'); }
      stop() { this.callbacks.status('Stopped'); }
    }`,
  }));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('These UI tests must never capture media.'); };
  });
  await page.goto('/');
});

  test('real-only UI records settings and retains deduplicated money totals across timeline rollover', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Fixture', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Play fixture', exact: true })).toHaveCount(0);
    await page.getByLabel('USER INPUT SILENCE (MS)').fill('99');
    await expect(page.getByRole('button', { name: 'Start microphone' })).toBeDisabled();
    await page.getByLabel('USER INPUT SILENCE (MS)').fill('750');
    await page.getByLabel('OUTPUT CHECK TIMING').selectOption('complete');
    await expect(page.getByText('Checks wait for generation to finish. You may hear the entire answer before a verdict.')).toBeVisible();
    await page.getByRole('button', { name: 'Start microphone' }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'relayUiStart'))).toMatchObject({ settings: { inputSilenceMs: 750, outputCadence: 'complete' } });
    await expect(page.getByLabel('OUTPUT CHECK TIMING')).toBeDisabled();
    await page.getByText('Judge token prices · USD per 1 million tokens', { exact: true }).click();
    await expect(page.getByLabel('jev input USD/M')).toBeDisabled();
    const rates = referencePricing('jev-1.13.0', 'gpt-5.4-mini');
    const usage: JudgeUsage = { callId: 'cost-one', phase: 'input', provider: 'jev', model: 'jev-1.13.0',
      status: 'reported', usage: { input: 1000, cachedInput: 0, output: 5 }, rates: rates.jev, estimatedUsd: 0.000042 };
    await deliver(page, [event({ kind: 'usage', usage }), event({ kind: 'usage', usage }),
      ...Array.from({ length: 610 }, () => verdict('output', [], { responseId: 'safe' }))]);
    const cost = page.getByRole('region', { name: 'Current live session judge cost' });
    await expect(cost).toContainText('$0.000042');
    await expect(cost).toContainText('1/1 calls with reported usage');
    await deliver(page, [event({ kind: 'usage', usage: { ...usage, callId: 'recovery', phase: 'output' } }),
      event({ kind: 'usage', usage: { ...usage, callId: 'unknown', status: 'unavailable', usage: null, estimatedUsd: null } })]);
    await expect(cost).toContainText('$0.000084');
    await expect(cost).toContainText('partial estimate');
    await page.getByRole('button', { name: 'Stop session' }).click();
    await page.getByLabel('jev input USD/M').fill('2');
    await expect(cost).toContainText('$0.000084');
  });

  test('real replay uses only configured providers; legacy simulation requests are rejected', async ({ page }) => {
    await page.route('**/api/evaluate', async route => {
      expect(route.request().postDataJSON()).toMatchObject({ source: 'provider-replay' });
      await route.fulfill({ json: { id: 'test-replay', createdAt: '', source: 'provider-replay', rows: [], summaries: [], usage: [], status: 'completed', file: 'test-only' } });
    });
    await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: /Replay bench/ }).click();
    await expect(page.getByRole('button', { name: 'Run fixture replay' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Compare providers' }).click();
    await expect(page.getByRole('heading', { name: 'Provider replay results' })).toBeVisible();
    const rejected = await page.request.post('/api/evaluate', { data: { source: 'fixture', split: 'all' } });
    expect(rejected.status()).toBe(400);
  });

test('two input blocks stay prominent with actual message associations and counts after safe redirects', async ({ page }) => {
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await deliver(page, [
    event({ kind: 'transcript', role: 'user', phase: 'input', turn: 1, text: 'Synthetic private account request' }),
    event({ kind: 'transcript', role: 'user', phase: 'input', turn: 2, text: 'Synthetic operating-rule override' }),
    verdict('input', ['privacy'], { turn: 1, atMs: 44910 }),
    event({ name: 'Constrained recovery authorized', turn: 1 }),
    verdict('output', [], { turn: 1, responseId: 'redirect1' }),
    verdict('input', ['override', 'scope'], { turn: 2, atMs: 53330 }),
    verdict('input', ['override', 'scope'], { turn: 2, atMs: 53330 }),
    event({ name: 'Constrained recovery authorized', turn: 2 }),
    verdict('output', [], { turn: 2, responseId: 'redirect2' }),
  ]);
  const history = page.getByRole('region', { name: 'Guardrail incident history' });
  await expect(history.locator('.guardrail-incident')).toHaveCount(2);
  await expect(history.getByText('INPUT BLOCKED', { exact: true })).toHaveCount(2);
  await expect(history).toContainText('Customer privacy');
  await expect(history).toContainText('Instruction integrity');
  await expect(history).toContainText('44.91s server clock');
  await expect(history).toContainText('LLM judge');
  await expect(history).toContainText('1117 ms judge decision');
  await expect(page.locator('[aria-label="Input blocked turns"] strong')).toHaveText('2');
  await expect(page.locator('[aria-label="Output interruptions"] strong')).toHaveText('0');
  const firstMessage = page.locator('.message.user').filter({ hasText: 'Synthetic private account request' });
  await expect(firstMessage).toContainText('INPUT BLOCKED: Customer privacy');
  await expect(firstMessage).not.toContainText('Instruction integrity');
  await expect(page.locator('.policy-panel').getByText('Clear so far', { exact: true })).toHaveCount(3);
  await expect(page.locator('.timeline')).toContainText('Input blocked before answer: Customer privacy');
  await expect(page.locator('.timeline')).toContainText('Safe redirect authorized after input block');
  await deliver(page, Array.from({ length: 610 }, () => verdict('output', [], { turn: 2, responseId: 'redirect2' })));
  await expect(history.locator('.guardrail-incident')).toHaveCount(2);
  await expect(history).toContainText('Synthetic private account request');
  await page.getByRole('button', { name: 'Stop session' }).click();
  await expect(history.locator('.guardrail-incident')).toHaveCount(2);
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect(history.locator('.guardrail-incident')).toHaveCount(0);
  await expect(page.locator('[aria-label="Input blocked turns"] strong')).toHaveText('0');
});

test('output detection is distinct from confirmed interruption and survives recovery', async ({ page }) => {
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await deliver(page, [
    event({ name: 'Provider playback started (not phrase alignment)', responseId: 'r1' }),
    verdict('output', ['roadmap'], { responseId: 'r1' }),
    event({ kind: 'interrupt', name: 'Output violation: roadmap', responseId: 'r1' }),
  ]);
  const history = page.getByRole('region', { name: 'Guardrail incident history' });
  await expect(history.getByText('OUTPUT VIOLATION', { exact: true })).toBeVisible();
  await expect(history).toContainText('awaiting browser mute confirmation');
  await expect(page.locator('[aria-label="Output interruptions"] strong')).toHaveText('0');
  await deliver(page, [
    event({ kind: 'metric', name: 'Browser command-receipt to mute (not network transit)', responseId: 'r1' }),
    verdict('output', ['roadmap'], { responseId: 'r1', revision: 4 }),
    event({ name: 'Constrained recovery authorized' }),
    verdict('output', [], { responseId: 'safe-recovery' }),
    event({ kind: 'interrupt', name: 'User interruption', responseId: 'safe-recovery' }),
  ]);
  await expect(history.locator('.guardrail-incident')).toHaveCount(1);
  await expect(history.getByText('OUTPUT INTERRUPTED', { exact: true })).toBeVisible();
  await expect(history).toContainText('Unreleased roadmap');
  await expect(page.locator('[aria-label="Output interruptions"] strong')).toHaveText('1');
  await expect(page.locator('[aria-label="Input blocked turns"] strong')).toHaveText('0');
  await expect(page.locator('.timeline')).toContainText('User barge-in (not a policy violation)');
});

test('uncertain input and technical errors are separate, with late output detections not counted as stopped speech', async ({ page }) => {
  await page.getByRole('button', { name: 'Start microphone' }).click();
  const uncertain = verdict('input', []);
  uncertain.verdict!.decision = 'uncertain';
  uncertain.verdict!.policies[0].decision = 'uncertain';
  await deliver(page, [
    event({ kind: 'transcript', role: 'user', phase: 'input', text: 'Unclear synthetic utterance' }), uncertain,
    event({ name: 'Constrained recovery authorized' }),
    event({ kind: 'interrupt', name: 'User interruption', responseId: 'r0' }),
    event({ kind: 'error', name: 'Synthetic provider unavailable' }),
  ]);
  const history = page.getByRole('region', { name: 'Guardrail incident history' });
  await expect(history.getByText('NEEDS CLARIFICATION', { exact: true })).toBeVisible();
  await expect(page.locator('.message.user .badge.amber')).toContainText('NEEDS CLARIFICATION: Product scope');
  await expect(history.getByText('GUARDRAIL UNAVAILABLE', { exact: true })).toBeVisible();
  await expect(history.locator('.guardrail-incident')).toHaveCount(0);
  await expect(page.locator('[aria-label="Input blocked turns"] strong')).toHaveText('0');
  await deliver(page, [
    event({ name: 'Provider playback stopped', responseId: 'late' }),
    verdict('output', ['discount'], { responseId: 'late' }),
    event({ kind: 'interrupt', name: 'Output violation: discount', responseId: 'late' }),
    event({ kind: 'metric', name: 'Browser command-receipt to mute (not network transit)', responseId: 'late' }),
  ]);
  await expect(history.getByText('OUTPUT VIOLATION', { exact: true })).toBeVisible();
  await expect(history).toContainText('after provider playback ended');
  await expect(page.locator('[aria-label="Output interruptions"] strong')).toHaveText('0');
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.getByRole('button', { name: 'Start microphone', exact: true }).click();
  await expect(history.locator('.guardrail-incident')).toHaveCount(0);
  await expect(history.locator('.clarification-notice')).toHaveCount(0);
  await expect(history.locator('.unavailable-notice')).toHaveCount(0);
});
