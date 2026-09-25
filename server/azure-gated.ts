import WebSocket from 'ws';
import { z } from 'zod';
import { azureUrl, env, readiness } from './config';
import { sessionConfig, type AzureConnection } from './azure';
import { bounded, GuardrailError } from './async';
import { parseRealtime, type RealtimeEvent } from '../shared/realtime';
import type { AgentMode } from '../shared/policies';
import { PCM_SAMPLE_RATE } from '../shared/audio';

export type GatedAzureConnection = Omit<AzureConnection, 'answer'>;
export async function connectGatedAzure(
  mode: AgentMode, signal: AbortSignal,
  onEvent: (event: RealtimeEvent) => void, onFailure: (message: string) => void,
): Promise<GatedAzureConnection> {
  if (!readiness().azure.configured) throw new GuardrailError('config', 'Native voice and same-resource transcription configuration are required.');
  const url = new URL(azureUrl);
  url.protocol = 'wss:';
  const ws = new WebSocket(url, { headers: { 'api-key': env.AZURE_OPENAI_API_KEY! }, maxPayload: 2 * 1024 * 1024 });
  let closed = false;
  let configured = false;
  const close = () => {
    closed = true;
    signal.removeEventListener('abort', close);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  };
  signal.addEventListener('abort', close, { once: true });
  const { model: _model, ...session } = sessionConfig(mode);
  const format = { type: 'audio/pcm', rate: PCM_SAMPLE_RATE };
  try {
    await bounded(() => new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: {
        ...session, audio: {
          input: { ...session.audio.input, format },
          output: { ...session.audio.output, format },
        },
      } })));
      ws.on('message', bytes => {
        try {
          const value: unknown = JSON.parse(bytes.toString());
          const event = parseRealtime(value);
          if (!event || closed) return;
          if (event.type === 'error' && !configured) {
            reject(new GuardrailError('azure-gated-session', `Native PCM session rejected (${event.error.code ?? 'unspecified'}).`));
            return;
          }
          if (event.type === 'session.updated') {
            const pcm = z.object({ type: z.literal('audio/pcm'), rate: z.literal(PCM_SAMPLE_RATE) });
            z.object({ session: z.object({ audio: z.object({ input: z.object({ format: pcm }), output: z.object({ format: pcm }) }) }) }).parse(value);
            const input = event.session.audio.input;
            if (input.turn_detection.create_response || input.turn_detection.interrupt_response
              || input.transcription.model !== env.AZURE_TRANSCRIPTION_DEPLOYMENT)
              throw new Error('Native PCM gates not confirmed.');
            configured = true;
            resolve();
          }
          if (configured) onEvent(event);
        } catch {
          if (!configured) reject(new GuardrailError('azure-gated-protocol', 'Native PCM configuration was not confirmed; no audio fallback.'));
          else onFailure('Native PCM event validation failed. Buffered speech discarded.');
        }
      });
      ws.on('error', () => {
        if (!configured) reject(new GuardrailError('azure-gated-connection', 'Cannot connect to the configured native Azure WebSocket endpoint.'));
        else if (!closed) onFailure('Native PCM connection failed. Buffered speech discarded.');
      });
      ws.on('close', () => {
        if (!configured) reject(new GuardrailError('azure-gated-closed', 'Native PCM connection closed before configuration.'));
        else if (!closed) onFailure('Native PCM connection closed. Buffered speech discarded.');
      });
    }), 20000, signal);
  } catch (error) { close(); throw error; }
  if (signal.aborted) { close(); throw new GuardrailError('aborted', 'Native PCM connection canceled.'); }
  return {
    close,
    send: event => {
      if (closed || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256000) {
        onFailure('Native PCM connection unavailable or overloaded. Call stopped.');
        return;
      }
      ws.send(JSON.stringify(event));
    },
  };
}
