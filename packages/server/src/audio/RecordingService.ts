import { createRequire } from 'node:module';
import { createWriteStream, type WriteStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { FileWriter } from 'wav';
import {
  RecordingEntrySchema,
  RecordingSettingsSchema,
  type RecordingEntry,
  type RecordingSettings,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import type { AudioStreamManager, NativeAudioInputFrame } from './AudioStreamManager.js';
import { clearResamplerCache, resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RecordingService');
const MIX_LATENCY_MS = 100;
const TX_ACTIVITY_WINDOW_MS = 200;
const MIX_WRITE_CHUNK_SAMPLES = 4096;
const SIGNAL_THRESHOLD = 0.001;
const MP3_FRAME_SAMPLES = 1152;
const MP3_FRAME_BYTES = MP3_FRAME_SAMPLES * 2;
const MP3_WRITE_BATCH_BYTES = 64 * 1024;
const RECORDING_FILE_PATTERN = /^(.+?)-(\d{8})-(\d{6})-(\d{6})\.(wav|mp3)$/i;
const LEGACY_RECORDING_FILE_PATTERN = /^(.+?)-(\d{6})\.(wav|mp3)$/i;
const DEFAULT_SETTINGS: RecordingSettings = {
  prefix: 'recording',
  format: 'wav',
  mp3Bitrate: 128,
  sampleRate: 24000,
  bitDepth: 16,
  source: 'both',
  directory: 'recordings',
};

interface Mp3Encoder {
  encodeBuffer(samples: Int16Array): Int8Array | Uint8Array;
  flush(): Int8Array | Uint8Array;
}

interface Mp3EncoderConstructor {
  new (channels: number, sampleRate: number, bitrate: number): Mp3Encoder;
}

interface Mp3BundleContext {
  lamejs?: { Mp3Encoder?: Mp3EncoderConstructor };
}

interface Mp3RecordingState {
  encoder: Mp3Encoder;
  stream: WriteStream;
  pendingPcm: Buffer;
  pendingOutput: Buffer[];
  pendingOutputBytes: number;
  writeChain: Promise<void>;
}

interface ParsedRecordingFileName {
  prefix: string;
  format: RecordingEntry['format'];
  sequence: number;
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

interface RecordingSession {
  id: string;
  resamplerKey: string;
  startedAt: number;
  source: RecordingSettings['source'];
  format: RecordingSettings['format'];
  mp3Bitrate: RecordingSettings['mp3Bitrate'];
  sampleRate: RecordingSettings['sampleRate'];
  bitDepth: RecordingSettings['bitDepth'];
  finalPath: string;
  tempPath: string;
  writer: FileWriter | null;
  mp3: Mp3RecordingState | null;
  lastTxActivityAt: number | null;
  mix: MixState | null;
  processing: Promise<void>;
}

let cachedMp3Encoder: Mp3EncoderConstructor | null = null;

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

function pcm(samples: Float32Array, bitDepth: RecordingSettings['bitDepth']): Buffer {
  const bytesPerSample = bitDepth / 8;
  const output = Buffer.allocUnsafe(samples.length * bytesPerSample);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index] ?? 0)
      ? Math.max(-1, Math.min(1, samples[index] ?? 0))
      : 0;
    if (bitDepth === 16) {
      output.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), index * 2);
    } else if (bitDepth === 24) {
      output.writeIntLE(Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff), index * 3, 3);
    } else {
      output.writeInt32LE(Math.round(sample < 0 ? sample * 0x80000000 : sample * 0x7fffffff), index * 4);
    }
  }
  return output;
}

function encodedBuffer(encoded: Int8Array | Uint8Array): Buffer {
  return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRecordingFileName(fileName: string, expectedPrefix?: string): ParsedRecordingFileName | null {
  const currentPattern = expectedPrefix
    ? new RegExp(`^${escapeRegExp(expectedPrefix)}-(\\d{8})-(\\d{6})-(\\d{6})\\.(wav|mp3)$`, 'i')
    : RECORDING_FILE_PATTERN;
  const current = currentPattern.exec(fileName);
  if (current) {
    return {
      prefix: expectedPrefix ?? current[1]!,
      format: (expectedPrefix ? current[4] : current[5])!.toLowerCase() as RecordingEntry['format'],
      sequence: Number.parseInt(expectedPrefix ? current[3]! : current[4]!, 10),
    };
  }
  const legacyPattern = expectedPrefix
    ? new RegExp(`^${escapeRegExp(expectedPrefix)}-(\\d{6})\\.(wav|mp3)$`, 'i')
    : LEGACY_RECORDING_FILE_PATTERN;
  const legacy = legacyPattern.exec(fileName);
  if (legacy) {
    return {
      prefix: expectedPrefix ?? legacy[1]!,
      format: (expectedPrefix ? legacy[2] : legacy[3])!.toLowerCase() as RecordingEntry['format'],
      sequence: Number.parseInt(expectedPrefix ? legacy[1]! : legacy[2]!, 10),
    };
  }
  return null;
}

function formatRecordingTimestamp(date: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}-${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;
}

export class RecordingService {
  private settings: RecordingSettings = DEFAULT_SETTINGS;
  private session: RecordingSession | null = null;
  private stopPromise: Promise<ReturnType<RecordingService['getStatus']>> | null = null;
  private entries: RecordingEntry[] = [];
  private error: string | null = null;
  private stopping = false;

  constructor(
    private readonly audio: AudioStreamManager,
    private readonly dataDir: string,
    settingsProvider?: () => RecordingSettings,
  ) {
    try {
      if (settingsProvider) {
        this.settings = RecordingSettingsSchema.parse(settingsProvider());
      } else {
        const persisted = ConfigManager.getInstance().getConfig().recording;
        if (persisted) {
          const legacy = persisted as typeof persisted & { quality?: 'low' | 'medium' | 'high' };
          const sampleRate = legacy.sampleRate
            ?? (legacy.quality === 'low' ? 16000 : legacy.quality === 'high' ? 48000 : 24000);
          this.settings = RecordingSettingsSchema.parse({
            ...legacy,
            sampleRate,
            bitDepth: legacy.bitDepth ?? 16,
          });
        }
      }
    } catch {
      // Config may not be initialized in isolated service tests.
    }
    audio.on('nativeAudioInputData', this.onRx);
    audio.on('txRecordingAudioData', this.onTx);
    audio.on('error', this.onAudioError);
  }

  dispose(): void {
    this.audio.off('nativeAudioInputData', this.onRx);
    this.audio.off('txRecordingAudioData', this.onTx);
    this.audio.off('error', this.onAudioError);
    if (this.session) void this.stop().catch((error: unknown) => logger.error('recording dispose failed', asError(error)));
  }

  getSettings(): RecordingSettings {
    return { ...this.settings };
  }

  setSettings(input: RecordingSettings): RecordingSettings {
    if (this.session || this.stopping) throw new Error('Stop recording before changing recording settings');
    this.settings = RecordingSettingsSchema.parse(input);
    try {
      const config = ConfigManager.getInstance().getConfig();
      void ConfigManager.getInstance()
        .replaceConfigForMigration({ ...config, recording: this.settings })
        .catch((error: unknown) => logger.warn('Failed to persist recording settings', asError(error)));
    } catch {
      // Config may not be initialized in isolated service tests.
    }
    return this.getSettings();
  }

  isMp3Supported(): boolean {
    try {
      this.getMp3EncoderConstructor(this.settings.sampleRate, this.settings.mp3Bitrate);
      return true;
    } catch {
      return false;
    }
  }

  getStatus() {
    return {
      recording: this.session !== null,
      entry: this.entries[0] ?? null,
      error: this.error,
    };
  }

  async start(): Promise<ReturnType<RecordingService['getStatus']>> {
    if (this.session || this.stopping) throw new Error('Recording already active');
    const settings = this.settings;
    const root = this.resolveRoot(settings.directory);
    await fs.mkdir(root, { recursive: true });
    await this.cleanupTemporaryFiles(root);
    if (settings.format === 'mp3') this.getMp3EncoderConstructor(settings.sampleRate, settings.mp3Bitrate);

    const allocation = await this.allocateFile(root, settings.format, settings.prefix);
    const session: RecordingSession = {
      id: randomUUID(),
      resamplerKey: `recording-${randomUUID()}`,
      startedAt: Date.now(),
      source: settings.source,
      format: settings.format,
      mp3Bitrate: settings.mp3Bitrate,
      sampleRate: settings.sampleRate,
      bitDepth: settings.bitDepth,
      finalPath: allocation.finalPath,
      tempPath: allocation.tempPath,
      writer: null,
      mp3: null,
      lastTxActivityAt: null,
      mix: settings.source === 'both' ? {
        sampleRate: settings.sampleRate,
        startedAt: Date.now(),
        cursor: 0,
        latestTimestamp: Date.now(),
        maxEnd: 0,
        nextSourceSample: { rx: 0, tx: 0 },
        rx: [],
        tx: [],
      } : null,
      processing: Promise.resolve(),
    };

    try {
      if (settings.format === 'wav') {
        session.writer = new FileWriter(session.tempPath, {
          channels: 1,
          sampleRate: settings.sampleRate,
          bitDepth: settings.bitDepth,
          flags: 'wx',
        } as unknown as ConstructorParameters<typeof FileWriter>[1]);
      } else {
        const Constructor = this.getMp3EncoderConstructor(settings.sampleRate, settings.mp3Bitrate);
        const stream = createWriteStream(session.tempPath, { flags: 'wx' });
        session.mp3 = {
          encoder: new Constructor(1, settings.sampleRate, settings.mp3Bitrate),
          stream,
          pendingPcm: Buffer.alloc(0),
          pendingOutput: [],
          pendingOutputBytes: 0,
          writeChain: Promise.resolve(),
        };
        await this.waitForOpen(stream);
      }
      this.session = session;
      this.error = null;
      return this.getStatus();
    } catch (error) {
      session.mp3?.stream.destroy();
      await fs.rm(session.tempPath, { force: true }).catch(() => undefined);
      this.error = asError(error).message;
      throw error;
    }
  }

  async stop(): Promise<ReturnType<RecordingService['getStatus']>> {
    if (this.stopPromise) return this.stopPromise;
    const session = this.session;
    if (!session) return this.getStatus();
    this.stopping = true;
    this.stopPromise = this.finish(session).finally(() => {
      this.stopPromise = null;
      this.stopping = false;
    });
    return this.stopPromise;
  }

  async list(): Promise<RecordingEntry[]> {
    const root = this.resolveRoot(this.settings.directory);
    await fs.mkdir(root, { recursive: true });
    await this.cleanupTemporaryFiles(root, this.session?.tempPath);
    await this.loadIndex(root);
    const indexed = new Set(this.entries.map(entry => entry.fileName));
    let changed = false;
    try {
      const files = await fs.readdir(root, { withFileTypes: true });
      for (const file of files) {
        const parsed = parseRecordingFileName(file.name);
        if (!file.isFile() || !parsed || indexed.has(file.name)) continue;
        const filePath = path.join(root, file.name);
        const stat = await fs.stat(filePath);
        const endedAt = stat.mtimeMs;
        this.entries.push({
          id: `file-${file.name}`,
          fileName: file.name,
          format: parsed.format,
          source: 'rx',
          startedAt: stat.birthtimeMs || endedAt,
          endedAt,
          durationMs: 0,
          sizeBytes: stat.size,
        });
        changed = true;
      }
    } catch {
      // Directory may disappear between mkdir and scan.
    }
    this.entries = this.entries.filter(entry => entry.fileName && path.basename(entry.fileName) === entry.fileName);
    this.entries.sort((left, right) => right.endedAt - left.endedAt || right.fileName.localeCompare(left.fileName));
    if (changed) await this.saveIndex(root);
    return [...this.entries];
  }

  async download(id: string): Promise<{ path: string; entry: RecordingEntry }> {
    await this.list();
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new Error('Recording not found');
    const root = this.resolveRoot(this.settings.directory);
    const filePath = path.resolve(root, entry.fileName);
    if (path.dirname(filePath) !== root) throw new Error('Invalid recording path');
    return { path: filePath, entry };
  }

  async delete(id: string): Promise<void> {
    await this.list();
    const index = this.entries.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Recording not found');
    const root = this.resolveRoot(this.settings.directory);
    const filePath = path.resolve(root, this.entries[index]!.fileName);
    if (path.dirname(filePath) !== root) throw new Error('Invalid recording path');
    await fs.rm(filePath, { force: true });
    this.entries.splice(index, 1);
    await this.saveIndex(root);
  }

  private async finish(session: RecordingSession): Promise<ReturnType<RecordingService['getStatus']>> {
    try {
      await session.processing;
      if (session.mix) this.drainMix(session, session.mix.maxEnd);
      if (session.writer) await this.closeWav(session.writer);
      if (session.mp3) await this.closeMp3(session.mp3);
      await fs.rename(session.tempPath, session.finalPath);
      const stat = await fs.stat(session.finalPath);
      const endedAt = Date.now();
      this.entries.unshift({
        id: session.id,
        fileName: path.basename(session.finalPath),
        format: session.format,
        source: session.source,
        startedAt: session.startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - session.startedAt),
        sizeBytes: stat.size,
      });
      await this.saveIndex(this.resolveRoot(this.settings.directory));
      this.session = null;
      return this.getStatus();
    } catch (error) {
      const failure = asError(error);
      this.error = failure.message;
      session.mp3?.stream.destroy();
      await fs.rm(session.tempPath, { force: true }).catch(() => undefined);
      this.session = null;
      throw failure;
    } finally {
      clearResamplerCache(`${session.resamplerKey}-rx`);
      clearResamplerCache(`${session.resamplerKey}-tx`);
    }
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

  private async closeMp3(state: Mp3RecordingState): Promise<void> {
    try {
      if (state.pendingPcm.length > 0) {
        const count = Math.floor(state.pendingPcm.length / 2);
        const samples = new Int16Array(count);
        for (let index = 0; index < count; index += 1) samples[index] = state.pendingPcm.readInt16LE(index * 2);
        state.pendingPcm = Buffer.alloc(0);
        this.queueMp3Output(state, encodedBuffer(state.encoder.encodeBuffer(samples)));
      }
      this.queueMp3Output(state, encodedBuffer(state.encoder.flush()));
      this.flushMp3Output(state);
      await state.writeChain;
      await this.closeStream(state.stream);
    } catch (error) {
      state.stream.destroy();
      throw new Error(`MP3 recording failed: ${asError(error).message}`);
    }
  }

  private writeMp3Samples(state: Mp3RecordingState, samples: Float32Array): void {
    const input = pcm(samples, 16);
    const data = state.pendingPcm.length > 0 ? Buffer.concat([state.pendingPcm, input]) : input;
    let offset = 0;
    while (data.length - offset >= MP3_FRAME_BYTES) {
      const frame = data.subarray(offset, offset + MP3_FRAME_BYTES);
      const encodedSamples = new Int16Array(MP3_FRAME_SAMPLES);
      for (let index = 0; index < MP3_FRAME_SAMPLES; index += 1) {
        encodedSamples[index] = frame.readInt16LE(index * 2);
      }
      this.queueMp3Output(state, encodedBuffer(state.encoder.encodeBuffer(encodedSamples)));
      offset += MP3_FRAME_BYTES;
    }
    state.pendingPcm = offset === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(offset));
    if (state.pendingOutputBytes >= MP3_WRITE_BATCH_BYTES) this.flushMp3Output(state);
  }

  private queueMp3Output(state: Mp3RecordingState, encoded: Buffer): void {
    if (encoded.length === 0) return;
    state.pendingOutput.push(encoded);
    state.pendingOutputBytes += encoded.length;
  }

  private flushMp3Output(state: Mp3RecordingState): void {
    if (state.pendingOutputBytes === 0) return;
    const output = Buffer.concat(state.pendingOutput, state.pendingOutputBytes);
    state.pendingOutput = [];
    state.pendingOutputBytes = 0;
    state.writeChain = state.writeChain.then(() => this.writeStream(state.stream, output));
    void state.writeChain.catch(() => undefined);
  }

  private async writeStream(stream: WriteStream, data: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.write(data, error => error ? reject(error) : resolve());
    });
  }

  private async closeStream(stream: WriteStream): Promise<void> {
    if (stream.closed || stream.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      stream.once('close', resolve);
      stream.once('error', reject);
      stream.end();
    });
  }

  private async waitForOpen(stream: WriteStream): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', reject);
    });
  }

  private write(session: RecordingSession, samples: Float32Array): void {
    if (samples.length === 0) return;
    if (session.writer) session.writer.write(pcm(samples, session.bitDepth));
    else if (session.mp3) this.writeMp3Samples(session.mp3, samples);
  }

  private prepare = async (
    samples: Float32Array,
    inputRate: number,
    session: RecordingSession,
    source: 'rx' | 'tx',
  ): Promise<Float32Array> => (
    inputRate === session.sampleRate
      ? new Float32Array(samples)
      : resampleAudioProfessional(samples, inputRate, session.sampleRate, 1, 2, `${session.resamplerKey}-${source}`)
  );

  private onRx = (frame: NativeAudioInputFrame): void => {
    const session = this.session;
    if (!session || this.stopping || (session.source !== 'rx' && session.source !== 'both')) return;
    const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : Date.now();
    if (
      session.source === 'both'
      && session.lastTxActivityAt !== null
      && timestamp - session.lastTxActivityAt < TX_ACTIVITY_WINDOW_MS
    ) return;
    this.enqueue(session, async () => {
      const rawSamples = monoSamples(frame.samples, frame.channels);
      const samples = await this.prepare(rawSamples, frame.sampleRate, session, 'rx');
      if (!this.session || this.session.id !== session.id) return;
      if (session.source === 'rx') this.write(session, samples);
      else await this.appendMix(session, 'rx', samples, timestamp);
    });
  };

  private onTx = ({ samples, sampleRate }: { samples: Float32Array; sampleRate: number }): void => {
    const session = this.session;
    if (!session || this.stopping || (session.source !== 'tx' && session.source !== 'both')) return;
    const timestamp = Date.now();
    if (session.source === 'both' && hasSignal(samples)) session.lastTxActivityAt = timestamp;
    this.enqueue(session, async () => {
      const prepared = await this.prepare(samples, sampleRate, session, 'tx');
      if (!this.session || this.session.id !== session.id) return;
      if (session.source === 'tx') this.write(session, prepared);
      else await this.appendMix(session, 'tx', prepared, timestamp);
    });
  };

  private enqueue(session: RecordingSession, operation: () => Promise<void>): void {
    session.processing = session.processing.then(operation).catch(error => {
      this.fail(error);
    });
  }

  private async appendMix(
    session: RecordingSession,
    source: 'rx' | 'tx',
    samples: Float32Array,
    timestamp: number,
  ): Promise<void> {
    const mix = session.mix;
    if (!mix || samples.length === 0) return;
    if (mix.maxEnd === 0 && mix.cursor === 0 && mix.rx.length === 0 && mix.tx.length === 0) {
      mix.startedAt = timestamp;
    }
    mix.latestTimestamp = Math.max(mix.latestTimestamp, timestamp);
    const timestampOffset = Math.max(0, Math.floor(((timestamp - mix.startedAt) / 1000) * mix.sampleRate));
    const start = Math.max(timestampOffset, mix.nextSourceSample[source], mix.cursor);
    mix[source].push({ start, samples: new Float32Array(samples) });
    mix.nextSourceSample[source] = start + samples.length;
    mix.maxEnd = Math.max(mix.maxEnd, start + samples.length);
    const watermark = Math.floor(((mix.latestTimestamp - mix.startedAt - MIX_LATENCY_MS) / 1000) * mix.sampleRate);
    if (watermark > mix.cursor) this.drainMix(session, watermark);
  }

  private drainMix(session: RecordingSession, target: number): void {
    const mix = session.mix;
    if (!mix) return;
    const end = Math.max(mix.cursor, Math.min(target, mix.maxEnd));
    while (mix.cursor < end) {
      const count = Math.min(MIX_WRITE_CHUNK_SAMPLES, end - mix.cursor);
      const mixed = new Float32Array(count);
      this.readMixSource(mix.rx, mix.cursor, mixed);
      this.readMixSource(mix.tx, mix.cursor, mixed);
      for (let index = 0; index < mixed.length; index += 1) {
        mixed[index] = Math.max(-1, Math.min(1, mixed[index]!));
      }
      this.write(session, mixed);
      mix.cursor += count;
    }
  }

  private readMixSource(segments: MixSegment[], cursor: number, output: Float32Array): void {
    while (segments.length > 0 && segments[0]!.start + segments[0]!.samples.length <= cursor) segments.shift();
    for (const segment of segments) {
      if (segment.start >= cursor + output.length) break;
      const from = Math.max(cursor, segment.start);
      const to = Math.min(cursor + output.length, segment.start + segment.samples.length);
      for (let position = from; position < to; position += 1) {
        const sourceIndex = position - segment.start;
        const outputIndex = position - cursor;
        output[outputIndex] = Math.max(-1, Math.min(1, output[outputIndex]! + (segment.samples[sourceIndex] ?? 0)));
      }
    }
  }

  private onAudioError = (error: Error): void => {
    if (!this.session) return;
    this.fail(error);
  };

  private fail(error: unknown): void {
    this.error = asError(error).message;
    void this.stop().catch((stopError: unknown) => {
      this.error = asError(stopError).message;
    });
  }

  private resolveRoot(directory: string): string {
    return path.isAbsolute(directory) ? path.resolve(directory) : path.resolve(this.dataDir, directory);
  }

  private async allocateFile(root: string, format: RecordingSettings['format'], prefix: string): Promise<{ finalPath: string; tempPath: string }> {
    let sequence = 1;
    const timestamp = formatRecordingTimestamp(new Date());
    try {
      const files = await fs.readdir(root);
      for (const file of files) {
        const parsed = parseRecordingFileName(file.endsWith('.part') ? file.slice(0, -5) : file, prefix);
        if (parsed) sequence = Math.max(sequence, parsed.sequence + 1);
      }
    } catch {
      // Directory was created immediately before scan.
    }
    for (;;) {
      const fileName = `${prefix}-${timestamp}-${String(sequence).padStart(6, '0')}.${format}`;
      const finalPath = path.join(root, fileName);
      const tempPath = `${finalPath}.part`;
      try {
        await fs.access(finalPath);
        sequence += 1;
        continue;
      } catch {
        try {
          await fs.access(tempPath);
          sequence += 1;
          continue;
        } catch {
          return { finalPath, tempPath };
        }
      }
    }
  }

  private async cleanupTemporaryFiles(root: string, preservePath?: string): Promise<void> {
    const preserved = preservePath ? path.resolve(preservePath) : null;
    try {
      const files = await fs.readdir(root);
      await Promise.all(files
        .filter(file => {
          if (!file.endsWith('.part') || parseRecordingFileName(file.slice(0, -5)) === null) return false;
          return preserved === null || path.resolve(root, file) !== preserved;
        })
        .map(file => fs.rm(path.join(root, file), { force: true })));
    } catch {
      // Directory may be unavailable during shutdown.
    }
  }

  private async loadIndex(root: string): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(root, '.index.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const candidates = Array.isArray(parsed)
        ? parsed.flatMap(item => {
          const result = RecordingEntrySchema.safeParse(item);
          return result.success ? [result.data] : [];
        })
        : [];
      const valid: RecordingEntry[] = [];
      for (const entry of candidates) {
        if (path.basename(entry.fileName) !== entry.fileName) continue;
        try {
          const stat = await fs.stat(path.join(root, entry.fileName));
          if (stat.isFile()) valid.push({ ...entry, sizeBytes: stat.size });
        } catch {
          // Ignore files removed outside the recording API.
        }
      }
      this.entries = valid;
    } catch {
      this.entries = [];
    }
  }

  private async saveIndex(root: string): Promise<void> {
    await fs.mkdir(root, { recursive: true });
    const indexPath = path.join(root, '.index.json');
    const tempPath = `${indexPath}.part`;
    await fs.writeFile(tempPath, JSON.stringify(this.entries), 'utf8');
    await fs.rename(tempPath, indexPath);
  }

  private getMp3EncoderConstructor(sampleRate: number, bitrate: RecordingSettings['mp3Bitrate']): Mp3EncoderConstructor {
    if (cachedMp3Encoder) {
      try {
        void new cachedMp3Encoder(1, sampleRate, bitrate);
        return cachedMp3Encoder;
      } catch {
        cachedMp3Encoder = null;
      }
    }
    const require = createRequire(import.meta.url);
    try {
      const module = require('lamejs') as { Mp3Encoder?: Mp3EncoderConstructor };
      if (module.Mp3Encoder) {
        try {
          void new module.Mp3Encoder(1, sampleRate, bitrate);
          cachedMp3Encoder = module.Mp3Encoder;
          return cachedMp3Encoder;
        } catch {
          // Current lamejs CommonJS entry misses browser bundle dependencies.
        }
      }
    } catch {
      // Fall through to the bundled encoder.
    }
    try {
      const bundlePath = require.resolve('lamejs/lame.all.js');
      const context: Mp3BundleContext = {};
      vm.runInNewContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath });
      const Constructor = context.lamejs?.Mp3Encoder;
      if (Constructor) {
        void new Constructor(1, sampleRate, bitrate);
        cachedMp3Encoder = Constructor;
        return Constructor;
      }
    } catch (error) {
      throw new Error(`MP3 encoder initialization failed: ${asError(error).message}`);
    }
    throw new Error('MP3 recording is unavailable: lamejs encoder was not found');
  }
}
