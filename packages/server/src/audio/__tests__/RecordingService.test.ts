import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { RecordingService } from '../RecordingService.js';
import type { AudioStreamEvents, AudioStreamManager } from '../AudioStreamManager.js';
import type { AudioRecordingSettings } from '@tx5dr/contracts';

function createManager(): EventEmitter<AudioStreamEvents> {
  return new EventEmitter<AudioStreamEvents>();
}

function rxFrame(samples: number[], timestamp = Date.now()) {
  return {
    samples: new Float32Array(samples),
    sampleRate: 12_000,
    channels: 1,
    timestamp,
    sequence: 1,
    sourceKind: 'simulation' as const,
  };
}

describe('RecordingService', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  async function setup(settings: Omit<AudioRecordingSettings, 'directory'>): Promise<{
    manager: EventEmitter<AudioStreamEvents>;
    service: RecordingService;
    directory: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), 'tx5dr-recording-test-'));
    temporaryDirectories.push(directory);
    const manager = createManager();
    const service = new RecordingService(manager as unknown as AudioStreamManager, () => ({ ...settings, directory }));
    return { manager, service, directory };
  }

  it('writes RX frames to a numbered PCM WAV file', async () => {
    const { manager, service, directory } = await setup({
      format: 'wav', quality: 'low', source: 'rx',
    });
    expect((await service.start()).state).toBe('recording');
    manager.emit('nativeAudioInputData', rxFrame([0.25, -0.25]));
    expect((await service.stop()).state).toBe('idle');

    const files = await readdir(directory);
    expect(files).toEqual(['recording-000001.wav']);
    const output = await readFile(join(directory, files[0]!));
    expect(output.toString('ascii', 0, 4)).toBe('RIFF');
    expect(output.readUInt32LE(24)).toBe(12_000);
    expect(output.readInt16LE(44)).toBeCloseTo(8192, -1);
    expect(output.readInt16LE(46)).toBeCloseTo(-8192, -1);
    await service.destroy();
  });

  it('mixes RX and TX into one bounded mono stream', async () => {
    const { manager, service, directory } = await setup({
      format: 'wav', quality: 'low', source: 'both',
    });
    await service.start();
    const timestamp = Date.now();
    manager.emit('nativeAudioInputData', rxFrame([0.25, 0.25], timestamp));
    manager.emit('txMonitorAudioData', { samples: new Float32Array([0.25, 0.25]), sampleRate: 12_000 });
    expect((await service.stop()).state).toBe('idle');

    const file = (await readdir(directory))[0]!;
    const output = await readFile(join(directory, file));
    const pcm = Array.from({ length: (output.length - 44) / 2 }, (_, index) => output.readInt16LE(44 + index * 2));
    expect(pcm.some((sample) => Math.abs(sample) >= 8191)).toBe(true);
    await service.destroy();
  });

  it('continues numbering across completed sessions', async () => {
    const { service, directory } = await setup({
      format: 'wav', quality: 'low', source: 'rx',
    });
    await service.start();
    await service.stop();
    await service.start();
    await service.stop();
    expect((await readdir(directory)).sort()).toEqual([
      'recording-000001.wav',
      'recording-000002.wav',
    ]);
    await service.destroy();
  });

  it('reports MP3 encoder failures without leaving a fake file', async () => {
    const { service, directory } = await setup({
      format: 'mp3', quality: 'low', source: 'rx',
    });
    await expect(service.start()).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    expect(service.getStatus().state).toBe('error');
    await service.destroy();
  });
});
