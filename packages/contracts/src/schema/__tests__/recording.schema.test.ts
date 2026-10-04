import { describe, expect, it } from 'vitest';
import {
  AudioRecordingSettingsSchema,
  AudioRecordingStatusSchema,
} from '../recording.schema.js';

describe('audio recording contract', () => {
  it('fills default format, quality, and source', () => {
    expect(AudioRecordingSettingsSchema.parse({ directory: '/var/lib/tx5dr/recordings' })).toEqual({
      format: 'wav',
      quality: 'medium',
      source: 'rx',
      directory: '/var/lib/tx5dr/recordings',
    });
  });

  it.each([
    { format: 'flac' },
    { quality: 'lossless' },
    { source: 'monitor' },
  ])('rejects unsupported setting values: %j', (setting) => {
    expect(AudioRecordingSettingsSchema.safeParse({ directory: '/tmp', ...setting }).success).toBe(false);
  });

  it('rejects an empty directory', () => {
    expect(AudioRecordingSettingsSchema.safeParse({ directory: '   ' }).success).toBe(false);
  });

  it('accepts error status with no active session', () => {
    expect(AudioRecordingStatusSchema.parse({
      state: 'error',
      sessionId: null,
      filename: null,
      source: null,
      format: null,
      quality: null,
      startedAt: null,
      durationMs: 0,
      error: 'MP3 recording is unavailable',
    }).state).toBe('error');
  });
});
