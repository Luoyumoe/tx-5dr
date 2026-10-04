import { z } from 'zod';

export const AudioRecordingFormatSchema = z.enum(['wav', 'mp3']);
export const AudioRecordingQualitySchema = z.enum(['low', 'medium', 'high']);
export const AudioRecordingSourceSchema = z.enum(['rx', 'tx', 'both']);

export const AudioRecordingSettingsSchema = z.object({
  format: AudioRecordingFormatSchema.default('wav'),
  quality: AudioRecordingQualitySchema.default('medium'),
  source: AudioRecordingSourceSchema.default('rx'),
  directory: z.string().trim().min(1),
});

export const AudioRecordingStatusSchema = z.object({
  state: z.enum(['idle', 'recording', 'stopping', 'error']),
  sessionId: z.string().nullable(),
  filename: z.string().nullable(),
  source: AudioRecordingSourceSchema.nullable(),
  format: AudioRecordingFormatSchema.nullable(),
  quality: AudioRecordingQualitySchema.nullable(),
  startedAt: z.number().nullable(),
  durationMs: z.number().nonnegative(),
  error: z.string().nullable(),
});

export const AudioRecordingSettingsResponseSchema = z.object({
  success: z.boolean(),
  settings: AudioRecordingSettingsSchema,
});

export const AudioRecordingStatusResponseSchema = z.object({
  success: z.boolean(),
  status: AudioRecordingStatusSchema,
});

export type AudioRecordingFormat = z.infer<typeof AudioRecordingFormatSchema>;
export type AudioRecordingQuality = z.infer<typeof AudioRecordingQualitySchema>;
export type AudioRecordingSource = z.infer<typeof AudioRecordingSourceSchema>;
export type AudioRecordingSettings = z.infer<typeof AudioRecordingSettingsSchema>;
export type AudioRecordingStatus = z.infer<typeof AudioRecordingStatusSchema>;
