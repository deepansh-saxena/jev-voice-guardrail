import { z } from 'zod';

export const sessionSettingsSchema = z.object({
  inputSilenceMs: z.number().finite().int().min(100).max(2000),
  outputCadence: z.enum(['periodic', 'pauses', 'complete']),
  outputIntervalMs: z.number().finite().int().min(100).max(2000),
  assistantPauseMs: z.number().finite().int().min(100).max(2000),
}).strict();
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export const defaultSessionSettings: SessionSettings = {
  inputSilenceMs: 500, outputCadence: 'periodic', outputIntervalMs: 200, assistantPauseMs: 500,
};
export function cadenceDescription(settings: SessionSettings) {
  return settings.outputCadence === 'complete' ? 'Waiting for complete response'
    : settings.outputCadence === 'pauses' ? `Checking on assistant audio pauses (${settings.assistantPauseMs} ms)`
      : `New-text checks every ${settings.outputIntervalMs} ms`;
}
