import { expect, it } from 'vitest';
import { advanceConversation, emptyConversation } from '../src/conversation';
import type { LabEvent } from '../shared/protocol';

const event = (fields: Partial<LabEvent>): LabEvent => ({
  id: 'e', kind: 'lifecycle', name: '', source: 'live', clock: 'server', atMs: 0, responseId: 'r', ...fields,
});
const text = event({ kind: 'transcript', role: 'assistant', text: 'Hello there' });
const audio = event({ kind: 'metric', clock: 'browser', name: 'speech-end-to-audio-energy' });

it('holds generated text through approval until browser audio begins', () => {
  let state = advanceConversation(emptyConversation(), text);
  state = advanceConversation(state, event({ delivery: 'approved' }));
  expect(state.messages.r.text).toBe('');
  state = advanceConversation(state, audio);
  expect(state.messages.r.text).toBe('Hello there');
});

it('handles audio arriving before text', () => {
  const state = advanceConversation(advanceConversation(emptyConversation(), audio), text);
  expect(state.messages.r.text).toBe('Hello there');
});

it('freezes interrupted text and does not reveal blocked responses on late audio', () => {
  let state = advanceConversation(advanceConversation(emptyConversation(), text), audio);
  state = advanceConversation(state, event({ name: 'Browser playback muted', clock: 'browser' }));
  state = advanceConversation(state, { ...text, text: 'Hello there unseen words' });
  expect(state.messages.r.text).toBe('Hello there');
  let blocked = advanceConversation(emptyConversation(), text);
  blocked = advanceConversation(blocked, event({ kind: 'interrupt' }));
  blocked = advanceConversation(blocked, audio);
  expect(blocked.messages.r.text).toBe('');
});

it('shows user input immediately and isolates recovery responses', () => {
  let state = advanceConversation(emptyConversation(), { ...text, role: 'user', responseId: undefined, turn: 1 });
  expect(state.messages['user-1'].text).toBe('Hello there');
  state = advanceConversation(state, event({ kind: 'interrupt' }));
  state = advanceConversation(state, { ...audio, responseId: 'recovery' });
  state = advanceConversation(state, { ...text, responseId: 'recovery' });
  expect(state.messages.recovery.text).toBe('Hello there');
});
