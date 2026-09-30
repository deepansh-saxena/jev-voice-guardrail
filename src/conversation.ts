import type { LabEvent } from '../shared/protocol';

export const emptyConversation = () => ({
  messages: {} as Record<string, LabEvent>,
  pending: {} as Record<string, LabEvent>,
  playing: {} as Record<string, boolean>,
  interrupted: {} as Record<string, boolean>,
});

// Keep display state separate from generated evidence used by judges and exports.
export function advanceConversation(previous: ReturnType<typeof emptyConversation>, event: LabEvent) {
  const state = {
    messages: { ...previous.messages }, pending: { ...previous.pending },
    playing: { ...previous.playing }, interrupted: { ...previous.interrupted },
  };
  const id = event.responseId;
  if (id && (event.kind === 'interrupt' || event.delivery === 'blocked' || event.name === 'Browser playback muted')) {
    state.interrupted[id] = true;
    state.playing[id] = false;
  }
  if (id && event.clock === 'browser' && event.name === 'speech-end-to-audio-energy' && !state.interrupted[id]) {
    state.playing[id] = true;
    if (state.pending[id]) state.messages[id] = state.pending[id];
  }
  if (event.kind === 'transcript') {
    const key = id ?? `user-${event.turn}`;
    if (event.role === 'user') state.messages[key] = event;
    else {
      state.pending[key] = event;
      if (state.playing[key] && !state.interrupted[key]) state.messages[key] = event;
      else if (!state.messages[key]) state.messages[key] = { ...event, text: '' };
    }
  }
  return state;
}
