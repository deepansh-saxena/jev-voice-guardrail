import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { clientMessageSchema, evalRequestSchema, transportFor, type LabEvent, type OutputMode, type ServerMessage } from '../shared/protocol';
import { decodePcm } from '../shared/audio';
import { GuardrailEngine } from './engine';
import { connectAzure, type AzureConnection } from './azure';
import { connectGatedAzure, type GatedAzureConnection } from './azure-gated';
import { createJudge } from './judges';
import { env, publicRunConfig, readiness } from './config';
import { evaluate, latestProviderReplay } from './evaluation';
import { errorMessage, GuardrailError } from './async';
import { verificationSummary } from './verification';

const app = express();
app.disable('x-powered-by');
const origins = new Set([`http://localhost:${env.PORT}`, `http://127.0.0.1:${env.PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.headers.origin && !origins.has(req.headers.origin)) { res.status(403).json({ error: 'Local origin required.' }); return; }
  next();
});
app.use(express.json({ limit: '128kb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: 'Relay Guardrail Lab', verificationDetails: '/api/readiness' }));
app.get('/api/readiness', async (_req, res) => res.json({ ...readiness(), verification: await verificationSummary() }));
app.get('/api/evaluations/latest', async (_req, res) => res.json(await latestProviderReplay()));
let liveBusy = false;
let evaluating = false;
app.post('/api/evaluate', async (req, res) => {
  const parsed = evalRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid evaluation request.' }); return; }
  if (evaluating || liveBusy) { res.status(409).json({ error: 'Finish the current call or evaluation first.' }); return; }
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  evaluating = true;
  try {
    const result = await evaluate(parsed.data.source, parsed.data.split, parsed.data.caseIds, controller.signal);
    res.json(result);
  } catch (error) {
    console.error('Evaluation failed:', error instanceof GuardrailError ? error.code : 'internal');
    if (!res.destroyed) res.status(503).json({ error: errorMessage(error) });
  } finally { evaluating = false; }
});
app.use(express.static(resolve('dist')));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('HTTP request failed:', error instanceof SyntaxError ? 'invalid-json' : 'internal');
  res.status(400).json({ error: 'Invalid request.' });
});
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 128000 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !req.headers.origin || !origins.has(req.headers.origin) || wss.clients.size >= 4) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  let engine: GuardrailEngine | undefined;
  let azure: AzureConnection | GatedAzureConnection | undefined;
  let outputMode: OutputMode = 'monitor';
  let audioWindow = performance.now();
  let audioBytes = 0;
  let ownsCall = false;
  let closed = false;
  let starting = false;
  let windowStart = performance.now();
  let messages = 0;
  const controller = new AbortController();
  const sessionId = randomUUID();
  const began = performance.now();
  let logQueue = Promise.resolve();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
    engine?.close();
    azure?.close();
    if (ownsCall) { liveBusy = false; ownsCall = false; }
  };
  const send = (message: ServerMessage) => {
    if (message.type === 'audio-chunk' && ws.bufferedAmount > 4 * 1024 * 1024) {
      send({ type: 'fatal', message: 'Local native audio relay is overloaded. Buffered speech discarded.' }); return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    if (message.type === 'fatal') { cleanup(); ws.close(); }
  };
  const log = (event: LabEvent) => {
    const { text, ...metadata } = event;
    const logged = env.LOG_LIVE_TRANSCRIPTS === 'true' ? event : { ...metadata, ...(text ? { transcriptChars: text.length } : {}) };
    logQueue = logQueue.then(async () => {
      await mkdir('results', { recursive: true, mode: 0o700 });
      await appendFile(`results/live-${sessionId}.jsonl`, JSON.stringify({ sessionId, config: { ...publicRunConfig(), outputMode, transport: transportFor(outputMode) }, ...logged }) + '\n', { mode: 0o600 });
    }).catch(() => send({ type: 'fatal', message: 'Local result log could not be written. Call stopped to avoid unrecorded measurements.' }));
  };
  const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 2000);
  ws.on('message', async raw => {
    const now = performance.now();
    if (now - windowStart > 60000) { messages = 0; windowStart = now; }
    let value: unknown;
    try { value = JSON.parse(raw.toString()); }
    catch { send({ type: 'fatal', message: 'Invalid browser message JSON.' }); return; }
    const parsed = clientMessageSchema.safeParse(value);
    if (!parsed.success) { send({ type: 'fatal', message: 'Invalid browser message schema.' }); return; }
    const message = parsed.data;
    if (closed) return;
    if (message.type === 'audio-input') {
      if (outputMode !== 'gated' || !azure || !engine) { send({ type: 'fatal', message: 'Native audio arrived before gated session readiness.' }); return; }
      try {
        const bytes = decodePcm(message.data);
        if (now - audioWindow >= 1000) { audioWindow = now; audioBytes = 0; }
        audioBytes += bytes.byteLength;
        if (bytes.byteLength > 4800 || audioBytes > 72000) throw new Error('Audio input rate limit.');
        azure.send({ type: 'input_audio_buffer.append', audio: message.data });
      } catch { send({ type: 'fatal', message: 'Invalid or excessive native PCM input. Call stopped.' }); }
      return;
    }
    if (++messages > 240) { send({ type: 'fatal', message: 'Local message rate limit exceeded.' }); return; }
    if (message.type === 'connect' || message.type === 'connect-gated') {
      if (starting || engine || liveBusy || evaluating) { send({ type: 'fatal', message: 'Only one local call or evaluation can run at a time.' }); return; }
      starting = true; liveBusy = true; ownsCall = true;
      outputMode = message.outputMode;
      try {
        const judge = createJudge(message.provider);
        engine = new GuardrailEngine(judge, {
          browser: send, event: log,
          provider: event => {
            if (azure) azure.send(event);
            else send({ type: 'fatal', message: 'Azure sideband not ready; response was not sent.' });
          },
        }, env.JUDGE_TIMEOUT_MS, outputMode);
        const onEvent = (event: Parameters<GuardrailEngine['receive']>[0]) => engine?.receive(event);
        const onFailure = (message: string) => engine?.fault(message);
        azure = message.type === 'connect-gated'
          ? await connectGatedAzure(message.mode, controller.signal, onEvent, onFailure)
          : await connectAzure(message.sdp, message.mode, controller.signal, onEvent, onFailure);
        if (closed) { azure.close(); return; }
        if ('answer' in azure && typeof azure.answer === 'string') send({ type: 'answer', sdp: azure.answer });
        send({ type: 'ready' });
        log({ id: randomUUID(), kind: 'status', name: `Native call configured: ${message.mode}; judge ${message.provider}; output ${outputMode}`,
          outputMode, transport: transportFor(outputMode), source: 'live', clock: 'server', atMs: performance.now() - began });
      } catch (error) {
        console.error('Native connection failed:', error instanceof GuardrailError ? error.code : 'configuration-or-transport');
        send({ type: 'fatal', message: errorMessage(error) });
      }
    } else if (message.type === 'stop') { cleanup(); ws.close(); }
    else if (message.type === 'armed') engine?.armed(message.requestId);
    else if (message.type === 'barge-in') engine?.speechStarted(message.itemId);
    else if (message.type === 'muted') engine?.muted(message.actionId, message.durationMs);
    else if (message.type === 'local-playback') engine?.localPlayback(message.responseId, message.requestId, message.state);
    else if (message.type === 'metric') log({
      id: randomUUID(), kind: 'metric', name: message.name, source: 'live', clock: 'browser',
      atMs: message.atMs, durationMs: message.durationMs, responseId: message.responseId,
      outputMode, transport: transportFor(outputMode),
    });
  });
  ws.on('close', cleanup);
  ws.on('error', () => { console.error('Browser WebSocket transport error.'); cleanup(); });
});
server.listen(env.PORT, '127.0.0.1', () => console.log(`Relay Guardrail Lab API: http://127.0.0.1:${env.PORT} (localhost only; provider readiness is configuration, not verification)`));
const shutdown = () => {
  for (const ws of wss.clients) ws.close(1001, 'Server stopping');
  wss.close();
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
