import { afterEach, describe, expect, it } from 'vitest';
import { clearResamplerCache, resampleAudioProfessional } from '../audioUtils.js';

function mean(samples: Float32Array): number {
  return samples.reduce((sum, sample) => sum + sample, 0) / Math.max(1, samples.length);
}

describe('audio resampler streams', () => {
  const streamKeys = ['recording-rx-test', 'recording-tx-test'];

  afterEach(() => {
    for (const streamKey of streamKeys) clearResamplerCache(streamKey);
  });

  it('keeps interleaved RX and TX recording streams independent', async () => {
    const rx = new Float32Array(4_800).fill(0.1);
    const tx = new Float32Array(4_800).fill(0.8);

    const rxFirst = await resampleAudioProfessional(rx, 48_000, 44_100, 1, 2, streamKeys[0]);
    const txFirst = await resampleAudioProfessional(tx, 48_000, 44_100, 1, 2, streamKeys[1]);
    const rxSecond = await resampleAudioProfessional(rx, 48_000, 44_100, 1, 2, streamKeys[0]);
    const txSecond = await resampleAudioProfessional(tx, 48_000, 44_100, 1, 2, streamKeys[1]);

    expect(mean(rxFirst.slice(-1_000))).toBeCloseTo(0.1, 3);
    expect(mean(txFirst.slice(-1_000))).toBeCloseTo(0.8, 3);
    expect(mean(rxSecond.slice(-1_000))).toBeCloseTo(0.1, 3);
    expect(mean(txSecond.slice(-1_000))).toBeCloseTo(0.8, 3);
  });
});
