import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Keep UI tests deterministic and never exercise paid providers when .env has real keys.
  await page.route('**/api/evaluations/latest', route => route.fulfill({ json: null }));
  await page.route('**/api/readiness', route => route.fulfill({ json: {
    azure: { configured: false, missing: ['AZURE_OPENAI_API_KEY', 'AZURE_TRANSCRIPTION_DEPLOYMENT'], transport: 'Azure GA WebRTC + server sideband', deployment: 'gpt-realtime-mini' },
    jev: { configured: false, missing: ['JEV_API_KEY'], model: 'jev-1.13.0' },
    llm: { configured: false, missing: ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'], model: 'Not configured', reasoning: 'omitted' },
    config: { intervalMs: 200, timeoutMs: 4000, minProbability: 0.8, policyVersion: 'relay-policy-1.0.0', kbVersion: 'relay-kb-1.0.0' },
  } }));
  await page.routeWebSocket('**/ws', ws => ws.onMessage(() => ws.send(JSON.stringify({ type: 'fatal', message: 'Test control transport unavailable.' }))));
});

test('fixture mode shows an honest normal flow and never requests a microphone', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('Fixture must not request media'); };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Voice, with boundaries.' })).toBeVisible();
  await page.getByRole('button', { name: 'Fixture', exact: true }).click();
  await expect(page.getByLabel('ENFORCING JUDGE')).toHaveText('Authored fixture oracle');
  await page.clock.install();
  await page.getByRole('button', { name: 'Play fixture' }).click();
  await expect(page.getByRole('button', { name: 'Stress test', exact: true })).toBeDisabled();
  await page.clock.runFor(3200);
  await expect(page.getByText('I can discuss current features, but not unreleased plans.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play fixture' })).toBeEnabled({ timeout: 8000 });
  await expect(page.getByText('No measured provider samples')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('stress fixture exposes synthetic facts and depicts interruption and recovery', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Stress test', exact: true }).click();
  await page.clock.install();
  await page.getByRole('button', { name: 'Play fixture' }).click();
  await page.clock.runFor(4200);
  await expect(page.getByText('I can explain Relay features. Project Lantern will bring offline editing on November 15.', { exact: true })).toBeVisible();
  await expect(page.getByText('Simulated detect and interrupt; no real audio played', { exact: true })).toBeVisible();
  await expect(page.getByText('Let me keep this to public Relay information. I can help with current features, plans or billing.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play fixture' })).toBeEnabled();
});

test('stopping a fixture removes pending events and unlocks configuration', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Fixture', exact: true }).click();
  await page.clock.install();
  await page.getByRole('button', { name: 'Play fixture' }).click();
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.clock.runFor(4200);
  await expect(page.getByRole('button', { name: 'Stress test', exact: true })).toBeEnabled();
  await expect(page.locator('.message')).toHaveCount(0);
});

test('runs replay through the API and keeps fixture results out of provider latency panels', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: /Replay bench/ }).click();
  await page.getByRole('button', { name: 'Run fixture replay' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture replay complete' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Not measured', { exact: true })).toHaveCount(2);
  await expect(page.locator('.results-table-wrap tbody tr')).toHaveCount(30);
  await expect(page.getByRole('button', { name: 'Compare providers' })).toBeDisabled();
});

test('live mode correctly surfaces missing credentials without requesting a microphone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start microphone' })).toBeDisabled();
  await page.getByText('Required local configuration').click();
  for (const key of ['AZURE_OPENAI_API_KEY', 'AZURE_TRANSCRIPTION_DEPLOYMENT', 'JEV_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'])
    await expect(page.locator('.readiness').getByText(key, { exact: true })).toBeVisible();
});

test('all sections remain navigable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(nav).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live voice is not ready yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Fixture', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play fixture' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await nav.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trusted product facts' })).toBeVisible();
  await nav.getByRole('button', { name: 'Replay bench', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run the same evidence' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('synthetic microphone tracks stop after a control transport failure', async ({ page }) => {
  await page.addInitScript(() => {
    const tracks: MediaStreamTrack[] = [];
    Object.defineProperty(window, 'relayTestTracks', { value: tracks });
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      Object.defineProperty(window, 'relayTestAudioContext', { value: context });
      const stream = context.createMediaStreamDestination().stream;
      tracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.route('**/api/readiness', async route => {
    await route.fulfill({ json: {
      azure: { configured: true, missing: [], deployment: 'test-realtime' },
      jev: { configured: true, missing: [], model: 'test-jev' },
      llm: { configured: false, missing: ['LLM_API_KEY'], model: 'not configured' },
      config: { intervalMs: 200, timeoutMs: 4000 },
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect(page.getByRole('alert')).toContainText('Test control transport unavailable.');
  expect(await page.evaluate(() => {
    const tracks = Reflect.get(window, 'relayTestTracks') as MediaStreamTrack[];
    return tracks.length > 0 && tracks.every(track => track.readyState === 'ended' && !track.enabled);
  })).toBe(true);
  await page.evaluate(() => (Reflect.get(window, 'relayTestAudioContext') as AudioContext).close());
});

test('late microphone permission resolution cannot leak a track after Stop', async ({ page }) => {
  await page.addInitScript(() => {
    const context = new AudioContext();
    const stream = context.createMediaStreamDestination().stream;
    Object.defineProperty(window, 'relayTestTracks', { value: stream.getTracks() });
    Object.defineProperty(window, 'relayTestAudioContext', { value: context });
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      Object.defineProperty(window, 'relayGrantMedia', { value: () => resolve(stream) });
    });
  });
  await page.route('**/api/readiness', async route => {
    await route.fulfill({ json: {
      azure: { configured: true, missing: [], deployment: 'test-realtime' },
      jev: { configured: true, missing: [], model: 'test-jev' },
      llm: { configured: false, missing: ['LLM_API_KEY'], model: 'not configured' },
      config: { intervalMs: 200, timeoutMs: 4000 },
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'relayGrantMedia'))).toBe('function');
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.evaluate(() => (Reflect.get(window, 'relayGrantMedia') as () => void)());
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, 'relayTestTracks') as MediaStreamTrack[]).every(t => t.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => (Reflect.get(window, 'relayTestAudioContext') as AudioContext).close());
  await expect(page.getByRole('alert')).toHaveCount(0);
});
