import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { azureDeployment, azureUrl, env } from './config';
import { sessionConfig } from './azure';
import { bounded, GuardrailError } from './async';

// Explicit opt-in, no microphone or response.create. This probes transport only;
// it does not bypass any lab input gate or substitute a fixture for a live judge.
const report = {
  source: 'azure-live-transport-probe',
  checkedAt: new Date().toISOString(),
  endpoint: env.AZURE_REALTIME_ENDPOINT,
  deployment: azureDeployment,
  transcriptionConfigured: !!env.AZURE_TRANSCRIPTION_DEPLOYMENT,
  microphoneUsed: false,
  inferenceRequested: false,
  audioVerified: false,
  judgingVerified: false,
  stages: [] as { name: string; status: string }[],
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let sideband: WebSocket | undefined;
const stage = (name: string, status: string) => {
  report.stages.push({ name, status });
  console.log(`${name}: ${status}`);
};
async function requireOk(response: Response, operation: string) {
  if (response.ok) return;
  const error = z.object({ error: z.object({ code: z.union([z.string(), z.number()]).optional() }).optional() })
    .safeParse(await response.json().catch(() => null));
  throw new GuardrailError(operation, `${operation}: HTTP ${response.status}; code ${error.success ? error.data.error?.code ?? 'unspecified' : 'unavailable'}`);
}
try {
  if (!env.AZURE_OPENAI_API_KEY) throw new GuardrailError('config', 'AZURE_OPENAI_API_KEY is required in local .env.');
  const base = `${azureUrl.origin}/openai/v1/realtime`;
  const configured = sessionConfig('normal');
  const { transcription: _transcription, ...inputWithoutTranscription } = configured.audio.input;
  const session = {
    ...configured,
    audio: { ...configured.audio, input: env.AZURE_TRANSCRIPTION_DEPLOYMENT ? configured.audio.input : inputWithoutTranscription },
  };
  if (!env.AZURE_TRANSCRIPTION_DEPLOYMENT)
    stage('scope', 'Transport-only probe; transcription omitted, not guessed. No microphone or inference.');
  const tokenResponse = await fetch(`${base}/client_secrets`, {
    method: 'POST', headers: { 'api-key': env.AZURE_OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }), signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  await requireOk(tokenResponse, 'client_secrets');
  const token = z.object({ value: z.string().min(1) }).parse(await tokenResponse.json());
  stage('client_secrets', `HTTP ${tokenResponse.status}; ephemeral token validated, not logged`);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const sdp = await page.evaluate(async () => {
    const peer = new RTCPeerConnection();
    Reflect.set(window, 'relayProbePeer', peer);
    peer.addTransceiver('audio', { direction: 'sendrecv' });
    peer.createDataChannel('relay-transport-probe');
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    return offer.sdp!;
  });
  const calls = await fetch(`${base}/calls`, {
    method: 'POST', headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
    body: sdp, signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  await requireOk(calls, 'calls');
  const answer = await calls.text();
  const id = calls.headers.get('location')?.split('/').filter(Boolean).pop();
  if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id) || !answer.startsWith('v=0'))
    throw new GuardrailError('calls-shape', 'Azure did not supply a valid SDP answer and Location call ID.');
  stage('calls', `HTTP ${calls.status}; SDP answer and Location validated, not logged`);
  const observer = new URL(base); observer.protocol = 'wss:'; observer.searchParams.set('call_id', id);
  sideband = new WebSocket(observer, { headers: { 'api-key': env.AZURE_OPENAI_API_KEY } });
  const ws = sideband;
  await bounded(() => new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      const { model: _model, ...update } = session;
      ws.send(JSON.stringify({ type: 'session.update', session: update }));
    });
    ws.on('message', bytes => {
      const envelope = z.object({ type: z.string() }).safeParse(JSON.parse(bytes.toString()));
      if (!envelope.success) { reject(new GuardrailError('sideband-event', 'Invalid sideband event.')); return; }
      if (envelope.data.type === 'error') {
        reject(new GuardrailError('sideband-error', 'Azure sideband rejected the no-response configuration.'));
      } else if (envelope.data.type === 'session.updated') {
        const confirmed = z.object({ session: z.object({ audio: z.object({ input: z.object({
          turn_detection: z.object({ create_response: z.literal(false), interrupt_response: z.literal(false) }),
        }) }) }) }).safeParse(JSON.parse(bytes.toString()));
        if (!confirmed.success) reject(new GuardrailError('gates', 'Azure did not confirm disabled automatic responses.'));
        else resolve();
      } else if (envelope.data.type === 'response.created') {
        reject(new GuardrailError('unexpected-response', 'Unexpected response during transport-only probe.'));
      }
    });
    ws.on('error', () => reject(new GuardrailError('sideband-connection', 'Azure sideband connection failed.')));
    ws.on('close', () => reject(new GuardrailError('sideband-closed', 'Azure sideband closed before configuration confirmation.')));
  }), 12000);
  stage('sideband', 'Authenticated and session.updated confirmed with both automatic-response flags false');
  await page.evaluate(async sdp => {
    const peer = Reflect.get(window, 'relayProbePeer') as RTCPeerConnection;
    await peer.setRemoteDescription({ type: 'answer', sdp });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebRTC connection timed out')), 15000);
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') { clearTimeout(timeout); resolve(); }
        else if (peer.connectionState === 'failed') { clearTimeout(timeout); reject(new Error('WebRTC failed')); }
      };
      if (peer.connectionState === 'connected') { clearTimeout(timeout); resolve(); }
    });
    peer.close();
  }, answer);
  stage('webrtc', 'Peer connected and closed; no audio track, microphone, or response generation');
} catch (error) {
  stage('failure', error instanceof GuardrailError ? error.message : 'Transport probe failed (details withheld to avoid logging credentials/tokens).');
  process.exitCode = 1;
} finally {
  if (sideband?.readyState === WebSocket.OPEN) sideband.close();
  else if (sideband && sideband.readyState !== WebSocket.CLOSED) sideband.terminate();
  await browser?.close();
  await mkdir('results', { recursive: true, mode: 0o700 });
  await writeFile('results/azure-transport-verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log('Sanitized report: results/azure-transport-verification.json');
}
