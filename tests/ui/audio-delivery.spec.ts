import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';

interface SinkProbe {
  contexts: AudioContext[];
  analysers: AnalyserNode[];
  tracks: MediaStreamTrack[];
  starts: { samples: number; first: number[]; offset: number }[];
  peak: number;
  timer: number;
  renderers: HTMLMediaElement[];
  gains: GainNode[];
}
const identity = { responseId: 'response1', requestId: 'request1', turn: 1 };
const part = { itemId: 'assistant1', outputIndex: 0, contentIndex: 0 };
const count = 7200;
const pcm = Buffer.alloc(count * 2);
for (let i = 0; i < count; i++) pcm.writeInt16LE(Math.round(10000 * Math.cos(i * 0.13)), i * 2);

async function resetPeak(page: Page) {
  await page.evaluate(() => { (Reflect.get(window, 'sinkProbe') as SinkProbe).peak = 0; });
}
async function peak(page: Page) {
  return page.evaluate(() => (Reflect.get(window, 'sinkProbe') as SinkProbe).peak);
}
function audio(ws: WebSocketRoute, id = identity, audioPart = part) {
  const send = (message: ServerMessage) => ws.send(JSON.stringify(message));
  send({ type: 'audio-start', ...id });
  send({ type: 'audio-chunk', responseId: id.responseId, part: audioPart, data: pcm.toString('base64') });
  send({ type: 'audio-part-done', responseId: id.responseId, part: audioPart });
  send({ type: 'audio-complete', ...id, revision: 4, parts: [{ ...audioPart, samples: count }] });
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/evaluations/latest', route => route.fulfill({ json: null }));
  await page.route('**/api/readiness', route => route.fulfill({ json: {
    azure: { configured: true, missing: [], deployment: 'test' },
    jev: { configured: true, missing: [], model: 'test' },
    llm: { configured: true, missing: [], model: 'test' },
    config: { intervalMs: 200, timeoutMs: 4000 },
  } }));
  await page.addInitScript(() => {
    const state: SinkProbe = { contexts: [], analysers: [], tracks: [], starts: [], peak: 0, timer: 0, renderers: [], gains: [] };
    Reflect.set(window, 'sinkProbe', state);
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) { super(options); state.contexts.push(this); }
    };
    const connect = AudioNode.prototype.connect;
    Object.defineProperty(AudioNode.prototype, 'connect', { value: function (this: AudioNode, destination: AudioNode | AudioParam, ...ports: number[]) {
      if (this instanceof GainNode && destination instanceof AnalyserNode) state.gains.push(this);
      if (destination instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 256;
        Reflect.apply(connect, this, [analyser]);
        state.analysers.push(analyser);
      }
      return Reflect.apply(connect, this, [destination, ...ports]);
    } });
    const start = AudioBufferSourceNode.prototype.start;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      state.renderers.push(this);
      return Reflect.apply(play, this, []);
    };
    Object.defineProperty(AudioBufferSourceNode.prototype, 'start', { value: function (this: AudioBufferSourceNode, ...args: number[]) {
      if (this.buffer) state.starts.push({ samples: this.buffer.length, first: [...this.buffer.getChannelData(0).slice(0, 8)], offset: args[1] ?? 0 });
      return Reflect.apply(start, this, args);
    } });
    state.timer = window.setInterval(() => {
      for (const analyser of state.analysers) {
        if (analyser.context.state !== 'running') continue;
        const values = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(values);
        state.peak = Math.max(state.peak, Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length));
      }
    }, 5);
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      await context.resume();
      const destination = context.createMediaStreamDestination();
      const silence = context.createConstantSource();
      silence.offset.value = 0;
      silence.connect(destination);
      silence.start();
      state.tracks.push(...destination.stream.getTracks());
      return destination.stream;
    };
  });
});
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const state = Reflect.get(window, 'sinkProbe') as SinkProbe | undefined;
    if (!state) return;
    clearInterval(state.timer);
    (Reflect.get(window, 'testRemotePeer') as RTCPeerConnection | undefined)?.close();
    state.tracks.forEach(t => t.stop());
    await Promise.all(state.contexts.filter(c => c.state !== 'closed').map(c => c.close()));
  });
});
async function gatedSession(page: Page) {
  let socket!: WebSocketRoute;
  const received: { type: string; state?: string; requestId?: string }[] = [];
  await page.routeWebSocket('**/ws', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'audio-input') received.push(message);
      if (message.type === 'connect-gated') ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await page.goto('/');
  await page.getByLabel('OUTPUT DELIVERY', { exact: true }).selectOption('gated');
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect.poll(() => received.some(e => e.type === 'connect-gated')).toBe(true);
  const send = (message: ServerMessage) => socket.send(JSON.stringify(message));
  send({ type: 'input-speech', state: 'started', itemId: 'user1', turn: 1 });
  send({ type: 'input-speech', state: 'stopped', itemId: 'user1', turn: 1 });
  send({ type: 'arm', requestId: identity.requestId, inputItemId: 'user1', turn: 1 });
  await expect.poll(() => received.some(e => e.type === 'armed')).toBe(true);
  return { socket, received, send };
}

test('gated output sink stays zero before approval and replays every native sample from the beginning', async ({ page }) => {
  const h = await gatedSession(page);
  await expect(page.getByLabel('OUTPUT DELIVERY', { exact: true })).toBeDisabled();
  audio(h.socket);
  await page.waitForTimeout(250);
  expect(await peak(page)).toBe(0);
  expect(await page.evaluate(() => (Reflect.get(window, 'sinkProbe') as SinkProbe).starts)).toHaveLength(0);
  h.send({ type: 'audio-release', ...identity, revision: 3 });
  await page.waitForTimeout(100);
  expect(await peak(page)).toBe(0);
  h.send({ type: 'audio-release', ...identity, revision: 4 });
  await expect.poll(() => peak(page)).toBeGreaterThan(0.05);
  await expect.poll(() => h.received.some(e => e.type === 'local-playback' && e.state === 'ended')).toBe(true);
  const starts = await page.evaluate(() => (Reflect.get(window, 'sinkProbe') as SinkProbe).starts);
  expect(starts).toHaveLength(1);
  expect(starts[0].samples).toBe(count);
  expect(starts[0].offset).toBe(0);
  expect(starts[0].first).toEqual(Array.from({ length: 8 }, (_, i) => pcm.readInt16LE(i * 2) / 32768));
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.waitForTimeout(100);
  await resetPeak(page);
  await page.waitForTimeout(100);
  expect(await peak(page)).toBe(0);
});

test('rejected gated audio and stale approvals stay silent; recovery requires its own complete approval', async ({ page }) => {
  const h = await gatedSession(page);
  audio(h.socket);
  h.send({ type: 'mute', actionId: 'drop1', responseId: identity.responseId, turn: 1 });
  h.send({ type: 'audio-release', ...identity, revision: 4 });
  await page.waitForTimeout(150);
  expect(await peak(page)).toBe(0);
  const next = { responseId: 'response2', requestId: 'request2', turn: 1 };
  h.send({ type: 'arm', requestId: next.requestId, inputItemId: 'user1', turn: 1 });
  await expect.poll(() => h.received.some(e => e.type === 'armed' && e.requestId === next.requestId)).toBe(true);
  audio(h.socket, next, { ...part, itemId: 'assistant2' });
  await page.waitForTimeout(150);
  expect(await peak(page)).toBe(0);
  h.send({ type: 'audio-release', ...next, revision: 4 });
  await expect.poll(() => peak(page)).toBeGreaterThan(0.05);
  h.send({ type: 'input-speech', state: 'started', itemId: 'user2', turn: 2 });
  await page.waitForTimeout(100);
  await resetPeak(page);
  h.send({ type: 'audio-release', ...next, revision: 4 });
  await page.waitForTimeout(150);
  expect(await peak(page)).toBe(0);
  expect(await page.evaluate(() => (Reflect.get(window, 'sinkProbe') as SinkProbe).starts)).toHaveLength(1);
  await page.getByRole('button', { name: 'Stop session' }).click();
});

test('Stop during worklet setup closes capture and cannot start a late relay', async ({ page }) => {
  let connections = 0;
  await page.routeWebSocket('**/ws', () => { connections++; });
  await page.addInitScript(() => {
    AudioWorklet.prototype.addModule = () => new Promise<void>(resolve => {
      Reflect.set(window, 'completeWorklet', resolve);
    });
  });
  await page.goto('/');
  await page.getByLabel('OUTPUT DELIVERY', { exact: true }).selectOption('gated');
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, 'completeWorklet'))).toBe('function');
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.evaluate(() => (Reflect.get(window, 'completeWorklet') as () => void)());
  await expect.poll(() => page.evaluate(() => {
    const s = Reflect.get(window, 'sinkProbe') as SinkProbe;
    return s.tracks.length > 0 && s.tracks.every(t => t.readyState === 'ended' && !t.enabled) && s.contexts[0].state === 'closed';
  })).toBe(true);
  expect(connections).toBe(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

async function monitorTransport(page: Page) {
  let socket!: WebSocketRoute;
  const received: ClientMessage[] = [];
  await page.addInitScript(() => {
    const NativePeer = RTCPeerConnection;
    Reflect.set(window, 'testNativePeer', NativePeer);
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) { super(configuration); Reflect.set(window, 'testClientPeer', this); }
    };
  });
  await page.routeWebSocket('**/ws', ws => {
    socket = ws;
    ws.onMessage(async raw => {
      const message: ClientMessage = JSON.parse(String(raw));
      if (message.type !== 'audio-input') received.push(message);
      if (message.type === 'connect-gated') ws.send(JSON.stringify({ type: 'ready' }));
      if (message.type !== 'connect') return;
      const answer = await page.evaluate(async offer => {
        const NativePeer = Reflect.get(window, 'testNativePeer') as typeof RTCPeerConnection;
        const client = Reflect.get(window, 'testClientPeer') as RTCPeerConnection;
        const peer = new NativePeer();
        Reflect.set(window, 'testRemotePeer', peer);
        const pendingClient: RTCIceCandidate[] = [];
        const pendingPeer: RTCIceCandidate[] = [];
        const add = (target: RTCPeerConnection, candidate: RTCIceCandidate) => {
          void target.addIceCandidate(candidate).catch(() => Reflect.set(window, 'testIceFailed', true));
        };
        client.onicecandidate = e => {
          if (e.candidate) { if (peer.remoteDescription) add(peer, e.candidate); else pendingPeer.push(e.candidate); }
        };
        peer.onicecandidate = e => {
          if (e.candidate) { if (client.remoteDescription) add(client, e.candidate); else pendingClient.push(e.candidate); }
        };
        client.addEventListener('signalingstatechange', () => {
          if (client.remoteDescription) pendingClient.splice(0).forEach(candidate => add(client, candidate));
        });
        const context = new AudioContext();
        await context.resume();
        const destination = context.createMediaStreamDestination();
        const oscillator = context.createOscillator();
        const remoteGain = context.createGain();
        oscillator.connect(remoteGain); remoteGain.connect(destination); oscillator.start();
        Reflect.set(window, 'remoteSyntheticGain', remoteGain);
        destination.stream.getTracks().forEach(t => peer.addTrack(t, destination.stream));
        peer.ondatachannel = e => Reflect.set(window, 'testRemoteChannel', e.channel);
        await peer.setRemoteDescription(client.localDescription ?? { type: 'offer', sdp: offer });
        pendingPeer.splice(0).forEach(candidate => add(peer, candidate));
        await peer.setLocalDescription(await peer.createAnswer());
        return peer.localDescription!.sdp;
      }, message.sdp);
      ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
      ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  return { get socket() { return socket; }, received, send: (message: ServerMessage) => socket.send(JSON.stringify(message)) };
}
async function monitorTurn(page: Page, h: Awaited<ReturnType<typeof monitorTransport>>, turn: number) {
  await page.waitForFunction(() => (Reflect.get(window, 'testRemoteChannel') as RTCDataChannel | undefined)?.readyState === 'open');
  await page.evaluate(number => {
    const dc = Reflect.get(window, 'testRemoteChannel') as RTCDataChannel;
    dc.send(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: `user${number}` }));
    dc.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: `user${number}` }));
  }, turn);
  await expect.poll(() => h.received.filter(e => e.type === 'barge-in').length).toBe(turn);
  h.send({ type: 'arm', requestId: `req${turn}`, turn, inputItemId: `user${turn}` });
  await expect.poll(() => h.received.some(e => e.type === 'armed' && e.requestId === `req${turn}`)).toBe(true);
  await page.evaluate(number => {
    const dc = Reflect.get(window, 'testRemoteChannel') as RTCDataChannel;
    dc.send(JSON.stringify({ type: 'response.created', response: { id: `response${number}`, status: 'in_progress', metadata: { relay_request: `req${number}` } } }));
    dc.send(JSON.stringify({ type: 'output_audio_buffer.started', response_id: `response${number}` }));
  }, turn);
}

test('real WebRTC streaming reaches the sink before final checks and resumes after uncertainty and a new turn', async ({ page }) => {
  const h = await monitorTransport(page);
  await page.goto('/');
  await expect(page.getByLabel('OUTPUT DELIVERY', { exact: true })).toHaveValue('monitor');
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect.poll(() => h.received.some(e => e.type === 'connect')).toBe(true);
  await page.waitForTimeout(250);
  expect(await peak(page)).toBe(0);
  await monitorTurn(page, h, 1);
  await expect.poll(() => peak(page)).toBeGreaterThan(0.05);
  h.send({ type: 'event', event: { id: 'text1', kind: 'transcript', phase: 'output', role: 'assistant',
    name: 'Assistant generated transcript', text: 'Generated text need not be heard.', responseId: 'response1', source: 'live', clock: 'server', atMs: 100 } });
  h.send({ type: 'event', event: { id: 'uncertain1', kind: 'check-end', phase: 'output',
    responseId: 'response1', source: 'live', clock: 'server', atMs: 200, name: 'Output uncertain',
    verdict: { decision: 'uncertain', provider: 'jev', model: 'test', source: 'live', serviceMs: 1,
      policies: [{ policy: 'roadmap', decision: 'uncertain' }] } } });
  h.send({ type: 'mute', actionId: 'mute1', responseId: 'response1', turn: 1 });
  await expect.poll(() => h.received.some(e => e.type === 'muted')).toBe(true);
  await page.waitForTimeout(100);
  await resetPeak(page);
  await page.waitForTimeout(150);
  expect(await peak(page)).toBe(0);
  await expect(page.locator('.message.assistant')).toContainText('Audio paused:');
  await expect(page.locator('.message.assistant')).toContainText('uncertain (not a violation)');
  h.send({ type: 'arm', requestId: 'recovery', inputItemId: 'user1', turn: 1 });
  await expect.poll(() => h.received.some(e => e.type === 'armed' && e.requestId === 'recovery')).toBe(true);
  await expect.poll(() => peak(page)).toBeGreaterThan(0.05);
  await resetPeak(page);
  await monitorTurn(page, h, 2);
  await expect.poll(() => peak(page)).toBeGreaterThan(0.05);
  expect(await page.evaluate(() => (Reflect.get(window, 'sinkProbe') as SinkProbe).renderers.every(a => a.muted))).toBe(true);
  await page.getByRole('button', { name: 'Stop session' }).click();
  expect(await page.evaluate(() => (Reflect.get(window, 'sinkProbe') as SinkProbe).renderers.every(a => a.muted && a.paused && a.srcObject === null))).toBe(true);
});

test('gated rejection cannot carry silence into a new monitor session', async ({ page }) => {
  const h = await monitorTransport(page);
  await page.goto('/');
  await page.getByLabel('OUTPUT DELIVERY', { exact: true }).selectOption('gated');
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect.poll(() => h.received.some(e => e.type === 'connect-gated')).toBe(true);
  h.send({ type: 'input-speech', state: 'started', itemId: 'user1', turn: 1 });
  h.send({ type: 'input-speech', state: 'stopped', itemId: 'user1', turn: 1 });
  h.send({ type: 'arm', requestId: identity.requestId, inputItemId: 'user1', turn: 1 });
  await expect.poll(() => h.received.some(e => e.type === 'armed')).toBe(true);
  audio(h.socket);
  h.send({ type: 'mute', actionId: 'gated-drop', responseId: identity.responseId, turn: 1 });
  h.send({ type: 'audio-release', ...identity, revision: 4 });
  await page.waitForTimeout(150);
  expect(await peak(page)).toBe(0);
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.getByLabel('OUTPUT DELIVERY', { exact: true }).selectOption('monitor');
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await monitorTurn(page, h, 1);
  await expect.poll(() => peak(page)).toBeGreaterThan(0.05);
  expect(h.received.some(e => e.type === 'connect')).toBe(true);
  await page.getByRole('button', { name: 'Stop session' }).click();
  await page.waitForTimeout(100); await resetPeak(page); await page.waitForTimeout(100);
  expect(await peak(page)).toBe(0);
  expect(await page.evaluate(() => {
    const s = Reflect.get(window, 'sinkProbe') as SinkProbe;
    return s.analysers.every(a => a.context.state === 'closed') && s.renderers.every(a => a.muted && a.paused && a.srcObject === null);
  })).toBe(true);
});

test('blocked browser media playback fails closed with an actionable sound-permission message', async ({ page }) => {
  await monitorTransport(page);
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Playback denied', 'NotAllowedError'));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect(page.getByRole('alert')).toContainText('Allow sound for this site, then start a new call.');
  await expect(page.getByRole('button', { name: 'Start microphone' })).toBeEnabled();
  expect(await peak(page)).toBe(0);
  expect(await page.evaluate(() => (Reflect.get(window, 'sinkProbe') as SinkProbe).tracks.every(t => t.readyState === 'ended'))).toBe(true);
});

  test('assistant pause detector uses decoded acoustic frames upstream of muted playback gain', async ({ page }) => {
    const h = await monitorTransport(page);
    await page.goto('/');
    await page.getByLabel('USER INPUT SILENCE (MS)').fill('900');
    await page.getByLabel('OUTPUT CHECK TIMING').selectOption('pauses');
    await page.getByLabel('ASSISTANT PAUSE (MS)').fill('200');
    await page.getByRole('button', { name: 'Start microphone' }).click();
    await monitorTurn(page, h, 1);
    await expect.poll(() => peak(page)).toBeGreaterThan(0.05);
    await expect(page.getByLabel('OUTPUT CHECK TIMING')).toBeDisabled();
    await expect(page.getByLabel('USER INPUT SILENCE (MS)')).toBeDisabled();
    expect(h.received.find(e => e.type === 'connect')).toMatchObject({ settings: { inputSilenceMs: 900, outputCadence: 'pauses', assistantPauseMs: 200 } });
    await page.evaluate(() => { (Reflect.get(window, 'sinkProbe') as SinkProbe).gains.forEach(g => { g.gain.value = 0; }); });
    await page.waitForTimeout(250);
    await page.evaluate(() => { (Reflect.get(window, 'remoteSyntheticGain') as GainNode).gain.value = 0; });
    await expect.poll(() => h.received.filter(e => e.type === 'assistant-pause').length).toBe(1);
    expect(h.received.find(e => e.type === 'assistant-pause')).toMatchObject({ responseId: 'response1', requestId: 'req1', turn: 1, sequence: 1 });
    await page.waitForTimeout(350);
    expect(h.received.filter(e => e.type === 'assistant-pause')).toHaveLength(1);
    await page.getByRole('button', { name: 'Stop session' }).click();
  });
