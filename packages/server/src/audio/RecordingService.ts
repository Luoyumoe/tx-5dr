import { createRequire } from 'node:module';
import { basename, isAbsolute, join } from 'node:path';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { FileWriter } from 'wav';
import type {
  AudioRecordingFormat,
  AudioRecordingQuality,
  AudioRecordingSettings,
  AudioRecordingStatus,
} from '@tx5dr/contracts';
import type { AudioStreamManager, NativeAudioInputFrame } from './AudioStreamManager.js';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';
import { ConfigManager } from '../config/config-manager.js';

const logger = createLogger('RecordingService');
const MIX_LATENCY_MS = 100;
const TX_ACTIVITY_WINDOW_MS = 200;
const MIX_WRITE_CHUNK_SAMPLES = 4096;
const SIGNAL_THRESHOLD = 0.001;

interface Mp3Encoder {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array | Uint8Array;
  flush(): Int8Array | Uint8Array;
}

interface Mp3EncoderConstructor {
  new (channels: number, sampleRate: number, bitrate: number): Mp3Encoder;
}

interface Mp3Module {
  Mp3Encoder?: Mp3EncoderConstructor;
  default?: { Mp3Encoder?: Mp3EncoderConstructor };
}

interface MixSegment {
  start: number;
  samples: Float32Array;
}

interface MixState {
  sampleRate: number;
  startedAt: number;
  cursor: number;
  latestTimestamp: number;
  maxEnd: number;
  nextSourceSample: Record<'rx' | 'tx', number>;
  rx: MixSegment[];
  tx: MixSegment[];
}

interface ActiveRecording {
  sessionId: string;
  settings: AudioRecordingSettings;
  filename: string;
  path: string;
  sampleRate: number;
  bitDepth: number;
  startedAt: number;
  state: 'recording' | 'stopping' | 'error';
  writer: FileWriter | null;
  mp3Stream: WriteStream | null;
  mp3Encoder: Mp3Encoder | null;
  processing: Promise<void>;
  stopPromise: Promise<AudioRecordingStatus> | null;
  failure: Error | null;
  failedAt: number | null;
  lastTxActivityAt: number | null;
  mix: MixState | null;
}

const QUALITY_CONFIG: Record<AudioRecordingQuality, {
  sampleRate: number;
  bitDepth: number;
  resamplerQuality: number;
  mp3Bitrate: number;
}> = {
  low: { sampleRate: 12_000, bitDepth: 16, resamplerQuality: 3, mp3Bitrate: 64 },
  medium: { sampleRate: 24_000, bitDepth: 16, resamplerQuality: 2, mp3Bitrate: 128 },
  high: { sampleRate: 48_000, bitDepth: 24, resamplerQuality: 0, mp3Bitrate: 192 },
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function hasSignal(samples: Float32Array): boolean {
  let sum = 0;
  for (const sample of samples) {
    if (Number.isFinite(sample)) sum += sample * sample;
  }
  return samples.length > 0 && Math.sqrt(sum / samples.length) >= SIGNAL_THRESHOLD;
}

function monoSamples(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return new Float32Array(samples);
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[frame * channels + channel] ?? 0;
    }
    mono[frame] = sum / channels;
  }
  return mono;
}

function pcm16(samples: Float32Array): Buffer {
  const output = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index] ?? 0)
      ? Math.max(-1, Math.min(1, samples[index] ?? 0))
      : 0;
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    output.writeInt16LE(value, index * 2);
  }
  return output;
}

function pcm24(samples: Float32Array): Buffer {
  const output = Buffer.allocUnsafe(samples.length * 3);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index] ?? 0)
      ? Math.max(-1, Math.min(1, samples[index] ?? 0))
      : 0;
    const value = sample < 0 ? Math.round(sample * 0x800000) : Math.round(sample * 0x7fffff);
    output.writeIntLE(value, index * 3, 3);
  }
  return output;
}

function encodedBuffer(encoded: Int8Array | Uint8Array): Buffer {
  return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

/**
 * Owns one station-wide audio recording session. AudioStreamManager remains
 * owner of capture and TX monitor timing; this service only observes frames.
 */
export class RecordingService {
  private readonly streamManager: AudioStreamManager;
  private readonly settingsProvider: () => AudioRecordingSettings;
  private active: ActiveRecording | null = null;
  private sequence = 1;
  private status: AudioRecordingStatus = {
    state: 'idle',
    sessionId: null,
    filename: null,
    source: null,
    format: null,
    quality: null,
    startedAt: null,
    durationMs: 0,
    error: null,
  };
  private operationTail: Promise<void> = Promise.resolve();
  private readonly onRxFrame = (frame: NativeAudioInputFrame): void => {
    this.handleRxFrame(frame);
  };
  private readonly onTxFrame = (frame: { samples: Float32Array; sampleRate: number }): void => {
    this.handleTxFrame(frame);
  };

  constructor(
    streamManager: AudioStreamManager,
    settingsProvider: () => AudioRecordingSettings = () => ConfigManager.getInstance().getRecordingSettings(),
  ) {
    this.streamManager = streamManager;
    this.settingsProvider = settingsProvider;
    this.streamManager.on('nativeAudioInputData', this.onRxFrame);
    this.streamManager.on('txMonitorAudioData', this.onTxFrame);
    logger.info('recording service initialized');
  }

  getStatus(): AudioRecordingStatus {
    const active = this.active;
    if (!active) return { ...this.status };
    const end = active.failedAt ?? Date.now();
    return {
      state: active.state,
      sessionId: active.sessionId,
      filename: active.filename,
      source: active.settings.source,
      format: active.settings.format,
      quality: active.settings.quality,
      startedAt: active.startedAt,
      durationMs: Math.max(0, end - active.startedAt),
      error: active.failure?.message ?? null,
    };
  }

  async start(): Promise<AudioRecordingStatus> {
    return this.enqueueOperation(() => this.startInternal());
  }

  async stop(): Promise<AudioRecordingStatus> {
    return this.enqueueOperation(() => this.stopInternal());
  }

  async destroy(): Promise<void> {
    this.streamManager.off('nativeAudioInputData', this.onRxFrame);
    this.streamManager.off('txMonitorAudioData', this.onTxFrame);
    if (this.active) await this.stop();
  }

  private async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let resolveTail!: () => void;
    this.operationTail = new Promise<void>((resolve) => { resolveTail = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      resolveTail();
    }
  }

  private async startInternal(): Promise<AudioRecordingStatus> {
    if (this.active && (this.active.state === 'recording' || this.active.state === 'stopping')) {
      return this.getStatus();
    }

    let settings: AudioRecordingSettings;
    try {
      settings = this.settingsProvider();
      if (!isAbsolute(settings.directory)) {
        throw new Error('Recording directory must be an absolute path');
      }
      const quality = QUALITY_CONFIG[settings.quality];
      if (!quality) throw new Error(`Unsupported recording quality: ${settings.quality}`);
      if (settings.format === 'mp3') this.getMp3EncoderConstructor();
      await mkdir(settings.directory, { recursive: true });
      const allocation = await this.allocateFilename(settings.directory, settings.format);
      const active = await this.openOutput(allocation.path, allocation.filename, settings, quality);
      this.active = active;
      this.setActiveStatus(active);
      logger.info('recording started', {
        sessionId: active.sessionId,
        filename: active.filename,
        source: settings.source,
        format: settings.format,
        quality: settings.quality,
      });
      return this.getStatus();
    } catch (error) {
      const failure = asError(error);
      logger.error('recording start failed', failure);
      this.status = {
        ...this.status,
        state: 'error',
        error: failure.message,
        durationMs: 0,
      };
      throw failure;
    }
  }

  private async stopInternal(): Promise<AudioRecordingStatus> {
    const active = this.active;
    if (!active) return this.getStatus();
    if (active.stopPromise) return active.stopPromise;

    active.state = active.failure ? 'error' : 'stopping';
    this.setActiveStatus(active);
    active.stopPromise = this.finishRecording(active);
    return active.stopPromise;
  }

  private async finishRecording(active: ActiveRecording): Promise<AudioRecordingStatus> {
    try {
      await active.processing;
      if (active.mix) await this.drainMix(active, active.mix.maxEnd);
      if (active.mp3Encoder && active.mp3Stream && !active.failure) {
        const tail = encodedBuffer(active.mp3Encoder.flush());
        if (tail.length > 0) await this.writeStream(active.mp3Stream, tail);
      }
      if (active.writer) await this.closeWav(active.writer);
      if (active.mp3Stream) await this.closeMp3(active.mp3Stream);
    } catch (error) {
      this.fail(active, error);
    }

    const finalStatus: AudioRecordingStatus = {
      state: active.failure ? 'error' : 'idle',
      sessionId: active.failure ? active.sessionId : null,
      filename: active.failure ? active.filename : null,
      source: active.failure ? active.settings.source : null,
      format: active.failure ? active.settings.format : null,
      quality: active.failure ? active.settings.quality : null,
      startedAt: active.failure ? active.startedAt : null,
      durationMs: Math.max(0, (active.failedAt ?? Date.now()) - active.startedAt),
      error: active.failure?.message ?? null,
    };
    this.active = null;
    this.status = finalStatus;
    logger.info('recording stopped', {
      sessionId: active.sessionId,
      filename: active.filename,
      state: finalStatus.state,
      durationMs: finalStatus.durationMs,
    });
    return { ...finalStatus };
  }

  private async openOutput(
    path: string,
    filename: string,
    settings: AudioRecordingSettings,
    quality: typeof QUALITY_CONFIG[AudioRecordingQuality],
  ): Promise<ActiveRecording> {
    const active: ActiveRecording = {
      sessionId: randomUUID(),
      settings,
      filename,
      path,
      sampleRate: quality.sampleRate,
      bitDepth: quality.bitDepth,
      startedAt: Date.now(),
      state: 'recording',
      writer: null,
      mp3Stream: null,
      mp3Encoder: null,
      processing: Promise.resolve(),
      stopPromise: null,
      failure: null,
      failedAt: null,
      lastTxActivityAt: null,
      mix: settings.source === 'both' ? {
        sampleRate: quality.sampleRate,
        startedAt: Date.now(),
        cursor: 0,
        latestTimestamp: Date.now(),
        maxEnd: 0,
        nextSourceSample: { rx: 0, tx: 0 },
        rx: [],
        tx: [],
      } : null,
    };

    if (settings.format === 'wav') {
      const writer = new FileWriter(path, {
        channels: 1,
        sampleRate: quality.sampleRate,
        bitDepth: quality.bitDepth,
        flags: 'wx',
      } as unknown as ConstructorParameters<typeof FileWriter>[1]);
      active.writer = writer;
      writer.on('error', (error: Error) => this.fail(active, error));
    } else {
      const Constructor = this.getMp3EncoderConstructor();
      const stream = createWriteStream(path, { flags: 'wx' });
      try {
        await this.waitForOpen(stream);
        active.mp3Stream = stream;
        try {
          active.mp3Encoder = new Constructor(1, quality.sampleRate, quality.mp3Bitrate);
        } catch (error) {
          throw new Error(`MP3 encoder initialization failed: ${asError(error).message}`);
        }
      } catch (error) {
        stream.destroy();
        try { await unlink(path); } catch { /* best effort cleanup */ }
        throw error;
      }
      stream.on('error', (error: Error) => this.fail(active, error));
    }
    return active;
  }

  private handleRxFrame(frame: NativeAudioInputFrame): void {
    const active = this.active;
    if (!active || active.state !== 'recording' || (active.settings.source !== 'rx' && active.settings.source !== 'both')) return;
    const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : Date.now();
    if (active.settings.source === 'both'
      && active.lastTxActivityAt !== null
      && timestamp - active.lastTxActivityAt < TX_ACTIVITY_WINDOW_MS) {
      return;
    }
    const samples = monoSamples(frame.samples, frame.channels);
    this.queueFrame(active, 'rx', samples, frame.sampleRate, timestamp);
  }

  private handleTxFrame(frame: { samples: Float32Array; sampleRate: number }): void {
    const active = this.active;
    if (!active || active.state !== 'recording' || (active.settings.source !== 'tx' && active.settings.source !== 'both')) return;
    const timestamp = Date.now();
    if (active.settings.source === 'both' && hasSignal(frame.samples)) active.lastTxActivityAt = timestamp;
    this.queueFrame(active, 'tx', new Float32Array(frame.samples), frame.sampleRate, timestamp);
  }

  private queueFrame(
    active: ActiveRecording,
    source: 'rx' | 'tx',
    samples: Float32Array,
    sampleRate: number,
    timestamp: number,
  ): void {
    if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
    active.processing = active.processing.then(async () => {
      if (active.failure) return;
      const resampled = await this.prepareSamples(samples, sampleRate, active);
      if (active.settings.source === 'both' && active.mix) {
        await this.appendMix(active, source, resampled, timestamp);
      } else {
        await this.writeEncodedSamples(active, resampled);
      }
    }).catch((error: unknown) => {
      this.fail(active, error);
    });
  }

  private async prepareSamples(samples: Float32Array, sampleRate: number, active: ActiveRecording): Promise<Float32Array> {
    if (sampleRate === active.sampleRate) return samples;
    return resampleAudioProfessional(
      samples,
      sampleRate,
      active.sampleRate,
      1,
      QUALITY_CONFIG[active.settings.quality].resamplerQuality,
    );
  }

  private async appendMix(active: ActiveRecording, source: 'rx' | 'tx', samples: Float32Array, timestamp: number): Promise<void> {
    const mix = active.mix;
    if (!mix || samples.length === 0) return;
    mix.latestTimestamp = Math.max(mix.latestTimestamp, timestamp);
    const timestampOffset = Math.max(0, Math.floor(((timestamp - mix.startedAt) / 1000) * mix.sampleRate));
    const start = Math.max(timestampOffset, mix.nextSourceSample[source], mix.cursor);
    const segment: MixSegment = { start, samples: new Float32Array(samples) };
    mix[source].push(segment);
    mix.nextSourceSample[source] = start + samples.length;
    mix.maxEnd = Math.max(mix.maxEnd, start + samples.length);
    const watermark = Math.floor(((mix.latestTimestamp - mix.startedAt - MIX_LATENCY_MS) / 1000) * mix.sampleRate);
    if (watermark > mix.cursor) await this.drainMix(active, watermark);
  }

  private async drainMix(active: ActiveRecording, target: number): Promise<void> {
    const mix = active.mix;
    if (!mix) return;
    const end = Math.max(mix.cursor, Math.min(target, mix.maxEnd));
    while (mix.cursor < end) {
      const count = Math.min(MIX_WRITE_CHUNK_SAMPLES, end - mix.cursor);
      const mixed = new Float32Array(count);
      this.readMixSource(mix.rx, mix.cursor, mixed);
      this.readMixSource(mix.tx, mix.cursor, mixed);
      for (let index = 0; index < mixed.length; index += 1) {
        mixed[index] = Math.max(-1, Math.min(1, mixed[index]));
      }
      await this.writeEncodedSamples(active, mixed);
      mix.cursor += count;
    }
  }

  private readMixSource(segments: MixSegment[], cursor: number, output: Float32Array): void {
    while (segments.length > 0 && segments[0].start + segments[0].samples.length <= cursor) segments.shift();
    for (const segment of segments) {
      if (segment.start >= cursor + output.length) break;
      const from = Math.max(cursor, segment.start);
      const to = Math.min(cursor + output.length, segment.start + segment.samples.length);
      for (let position = from; position < to; position += 1) {
        const sourceIndex = position - segment.start;
        const outputIndex = position - cursor;
        output[outputIndex] = Math.max(-1, Math.min(1, output[outputIndex] + (segment.samples[sourceIndex] ?? 0)));
      }
    }
  }

  private async writeEncodedSamples(active: ActiveRecording, samples: Float32Array): Promise<void> {
    if (samples.length === 0 || active.failure) return;
    if (active.writer) {
      const bytes = active.bitDepth === 24 ? pcm24(samples) : pcm16(samples);
      await this.writeWriter(active.writer, bytes);
      return;
    }
    if (active.mp3Encoder && active.mp3Stream) {
      const pcm = pcm16(samples);
      const input = new Int16Array(pcm.buffer, pcm.byteOffset, samples.length);
      const bytes = encodedBuffer(active.mp3Encoder.encodeBuffer(input));
      if (bytes.length > 0) await this.writeStream(active.mp3Stream, bytes);
    }
  }

  private async writeWriter(writer: FileWriter, bytes: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      writer.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }

  private async writeStream(stream: WriteStream, bytes: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }

  private async closeWav(writer: FileWriter): Promise<void> {
    if (writer.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const error = (failure: Error) => { cleanup(); reject(failure); };
      const cleanup = () => {
        writer.off('done', done);
        writer.off('error', error);
      };
      writer.once('done', done);
      writer.once('error', error);
      writer.end();
    });
  }

  private async closeMp3(stream: WriteStream): Promise<void> {
    if (stream.destroyed || stream.closed) return;
    await new Promise<void>((resolve, reject) => {
      stream.once('close', resolve);
      stream.once('error', reject);
      stream.end();
    });
  }

  private fail(active: ActiveRecording, error: unknown): void {
    if (active.failure) return;
    active.failure = asError(error);
    active.failedAt = Date.now();
    active.state = 'error';
    this.setActiveStatus(active);
    logger.error('recording failed', active.failure);
  }

  private setActiveStatus(active: ActiveRecording): void {
    this.status = this.getStatusFor(active);
  }

  private getStatusFor(active: ActiveRecording): AudioRecordingStatus {
    const end = active.failedAt ?? Date.now();
    return {
      state: active.state,
      sessionId: active.sessionId,
      filename: active.filename,
      source: active.settings.source,
      format: active.settings.format,
      quality: active.settings.quality,
      startedAt: active.startedAt,
      durationMs: Math.max(0, end - active.startedAt),
      error: active.failure?.message ?? null,
    };
  }

  private async allocateFilename(directory: string, format: AudioRecordingFormat): Promise<{ path: string; filename: string }> {
    let maxSequence = this.sequence - 1;
    try {
      const entries = await readdir(directory);
      for (const entry of entries) {
        const match = /^recording-(\d+)\.(?:wav|mp3)$/i.exec(entry);
        if (match) maxSequence = Math.max(maxSequence, Number.parseInt(match[1] ?? '0', 10));
      }
    } catch (error) {
      logger.warn('recording directory scan failed', error);
    }
    let number = Math.max(1, maxSequence + 1);
    const extension = format;
    for (;;) {
      const filename = `recording-${String(number).padStart(6, '0')}.${extension}`;
      const path = join(directory, filename);
      try {
        await stat(path);
        number += 1;
      } catch {
        this.sequence = number + 1;
        return { path, filename: basename(path) };
      }
    }
  }

  private getMp3EncoderConstructor(): Mp3EncoderConstructor {
    try {
      const require = createRequire(import.meta.url);
      const module = require('lamejs') as Mp3Module;
      const Constructor = module.Mp3Encoder ?? module.default?.Mp3Encoder;
      if (Constructor) return Constructor;
    } catch {
      // Optional dependency. Keep WAV available when MP3 codec is absent.
    }
    throw new Error('MP3 recording is unavailable: install the optional "lamejs" dependency');
  }

  private async waitForOpen(stream: WriteStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
  }
}
