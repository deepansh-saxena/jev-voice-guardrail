import { z } from 'zod';

const id = z.string().min(1).max(200);
const base = { event_id: id.optional() };
const transcript = {
  ...base, response_id: id, item_id: id,
  output_index: z.number().int().min(0), content_index: z.number().int().min(0),
};
const item = z.object({
  id, type: z.string(), role: z.string().optional(),
  content: z.array(z.object({ type: z.string(), transcript: z.string().optional(), text: z.string().optional() })).optional(),
});
const response = z.object({
  id, status: z.string(),
  metadata: z.record(z.string()).nullable().optional(),
  output: z.array(item).optional(),
});
export const realtimeSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('session.updated'), session: z.object({
    audio: z.object({ input: z.object({
      turn_detection: z.object({ create_response: z.boolean(), interrupt_response: z.boolean() }),
      transcription: z.object({ model: z.string() }),
    }) }),
  }) }),
  z.object({ ...base, type: z.literal('input_audio_buffer.speech_started'), item_id: id }),
  z.object({ ...base, type: z.literal('input_audio_buffer.speech_stopped'), item_id: id }),
  z.object({ ...base, type: z.literal('conversation.item.input_audio_transcription.completed'), item_id: id, transcript: z.string().max(16000) }),
  z.object({ ...base, type: z.literal('conversation.item.input_audio_transcription.failed'), item_id: id }),
  z.object({ ...base, type: z.literal('response.created'), response }),
  z.object({ ...base, type: z.literal('response.done'), response }),
  z.object({ ...base, type: z.literal('response.output_item.added'), response_id: id, output_index: z.number(), item }),
  z.object({ ...transcript, type: z.literal('response.output_audio_transcript.delta'), delta: z.string().max(16000) }),
  z.object({ ...transcript, type: z.literal('response.output_audio_transcript.done'), transcript: z.string().max(16000) }),
  z.object({ ...base, type: z.literal('output_audio_buffer.started'), response_id: id }),
  z.object({ ...base, type: z.literal('output_audio_buffer.stopped'), response_id: id }),
  z.object({ ...base, type: z.literal('output_audio_buffer.cleared'), response_id: id }),
  z.object({ ...base, type: z.literal('conversation.item.deleted'), item_id: id }),
  z.object({ ...base, type: z.literal('error'), error: z.object({ code: z.string().optional(), event_id: z.string().nullable().optional() }) }),
]);
export type RealtimeEvent = z.infer<typeof realtimeSchema>;
const allowed = new Set(realtimeSchema.options.map(o => o.shape.type.value));
export function parseRealtime(value: unknown): RealtimeEvent | null {
  const header = z.object({ type: z.string() }).parse(value);
  if (!allowed.has(header.type as RealtimeEvent['type'])) return null;
  return realtimeSchema.parse(value);
}
