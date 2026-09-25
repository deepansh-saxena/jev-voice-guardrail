import WebSocket from 'ws';
import { z } from 'zod';
import { agentInstructions, type AgentMode } from '../shared/policies';
import { parseRealtime, type RealtimeEvent } from '../shared/realtime';
import { azureDeployment, azureUrl, env, readiness } from './config';
import { bounded, GuardrailError } from './async';
import { defaultSessionSettings, sessionSettingsSchema, type SessionSettings } from '../shared/session-settings';

export function sessionConfig(mode: AgentMode, settings: SessionSettings = defaultSessionSettings) {
  const { inputSilenceMs } = sessionSettingsSchema.parse(settings);
  return {
    type: 'realtime', model: azureDeployment,
    instructions: agentInstructions(mode),
    output_modalities: ['audio'],
    max_output_tokens: 400,
    tools: [],
    audio: {
      input: {
        transcription: { model: env.AZURE_TRANSCRIPTION_DEPLOYMENT, language: 'en' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: inputSilenceMs, create_response: false, interrupt_response: false },
      },
      output: { voice: env.AZURE_VOICE },
    },
  };
}

export interface AzureConnection {
  answer: string;
  send: (event: Record<string, unknown>) => void;
  close: () => void;
}
export async function connectAzure(
  sdp: string, mode: AgentMode, signal: AbortSignal,
  onEvent: (event: RealtimeEvent) => void, onFailure: (message: string) => void,
  settings: SessionSettings = defaultSessionSettings,
): Promise<AzureConnection> {
  if (!readiness().azure.configured)
    throw new GuardrailError('config', `Missing configuration: ${readiness().azure.missing.join(', ')}.`);
  const base = `${azureUrl.origin}/openai/v1/realtime`;
  const configuration = sessionConfig(mode, settings);
  const answer = await bounded(async innerSignal => {
    const tokenResponse = await fetch(`${base}/client_secrets`, {
      method: 'POST', headers: { 'api-key': env.AZURE_OPENAI_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: configuration }), signal: innerSignal, redirect: 'error',
    });
    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel();
      throw new GuardrailError('azure-token', `Azure client_secrets returned HTTP ${tokenResponse.status}. Verify resource, realtime and transcription deployments.`);
    }
    const token = z.object({ value: z.string().min(1) }).parse(await tokenResponse.json());
    const result = await fetch(`${base}/calls`, {
      method: 'POST', headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
      body: sdp, signal: innerSignal, redirect: 'error',
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw new GuardrailError('azure-sdp', `Azure calls returned HTTP ${result.status}. Native WebRTC was not established.`);
    }
    const location = result.headers.get('location');
    const callId = location?.split('/').filter(Boolean).pop();
    if (!callId || !/^[a-zA-Z0-9_-]{1,200}$/.test(callId)) {
      await result.body?.cancel();
      throw new GuardrailError('azure-sideband', 'Azure calls did not return a usable Location call ID. No unmonitored fallback.');
    }
    const text = await result.text();
    if (!text.startsWith('v=0') || text.length > 100000) throw new GuardrailError('azure-sdp', 'Azure returned an invalid SDP answer.');
    return { sdp: text, callId };
  }, 25000, signal);

  const wsUrl = new URL(base);
  wsUrl.protocol = 'wss:';
  wsUrl.searchParams.set('call_id', answer.callId);
  const ws = new WebSocket(wsUrl, { headers: { 'api-key': env.AZURE_OPENAI_API_KEY! }, maxPayload: 2 * 1024 * 1024 });
  let closed = false;
  let configured = false;
  const close = () => {
    closed = true;
    signal.removeEventListener('abort', close);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    await bounded(() => new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // model is immutable after creation, so it is intentionally omitted.
        const { model: _model, ...session } = configuration;
        ws.send(JSON.stringify({ type: 'session.update', session }));
      });
      ws.on('message', bytes => {
        try {
          const event = parseRealtime(JSON.parse(bytes.toString()));
          if (!event) return;
          if (event.type === 'error' && !configured) {
            reject(new GuardrailError('azure-session', `Azure session configuration rejected (${event.error.code ?? 'unspecified'}).`));
            return;
          }
          if (event.type === 'session.updated') {
            const input = event.session.audio.input;
            if (input.turn_detection.create_response || input.turn_detection.interrupt_response
              || input.turn_detection.silence_duration_ms !== settings.inputSilenceMs
              || input.transcription.model !== env.AZURE_TRANSCRIPTION_DEPLOYMENT) {
              throw new GuardrailError('azure-gates', 'Azure did not confirm the required input gates and transcription configuration.');
            }
            configured = true;
            resolve();
          }
          if (configured && !closed) onEvent(event);
        } catch {
          const message = 'Azure sideband event or session configuration failed validation. Native call stopped.';
          if (!configured) reject(new GuardrailError('azure-protocol', message));
          else onFailure(message);
        }
      });
      ws.on('error', () => {
        if (!configured) reject(new GuardrailError('azure-sideband', 'Azure sideband connection failed. Verify Azure credentials and call_id support on this resource.'));
        else if (!closed) onFailure('Azure sideband connection failed. Guardrail unavailable.');
      });
      ws.on('close', () => {
        if (!configured) reject(new GuardrailError('azure-sideband', 'Azure sideband closed before input-gate confirmation.'));
        else if (!closed) onFailure('Azure sideband disconnected. Guardrail unavailable.');
      });
    }), 12000, signal);
  } catch (error) { close(); throw error; }
  if (signal.aborted) { close(); throw new GuardrailError('aborted', 'Call setup canceled.'); }
  return {
    answer: answer.sdp, close,
    send: event => {
      if (closed || ws.readyState !== WebSocket.OPEN) { onFailure('Azure sideband is not connected.'); return; }
      ws.send(JSON.stringify(event));
    },
  };
}
