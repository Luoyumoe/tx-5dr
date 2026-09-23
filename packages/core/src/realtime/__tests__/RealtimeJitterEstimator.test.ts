import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RealtimeJitterEstimator,
  createRealtimeTimingProbe,
  isRealtimeTimingProbeMessage,
  resolveRealtimeJitterSeedTargetMs,
} from '../RealtimeJitterEstimator.js';

function createEstimator(nowMs = 0): RealtimeJitterEstimator {
  return new RealtimeJitterEstimator({
    minTargetMs: 60,
    initialTargetMs: 80,
    softFloorMs: 80,
    maxTargetMs: 220,
    nowMs,
  });
}

test('returns the initial target before samples arrive', () => {
  const estimator = createEstimator(1000);
  assert.equal(estimator.getSnapshot(1000).activeTargetMs, 80);
  assert.equal(estimator.getSnapshot(1000).recommendedTargetMs, 80);
});

test('raises target from early packet jitter before underruns happen', () => {
  const estimator = createEstimator(0);
  estimator.recordPacket({ sequence: 0, mediaTimestampMs: 0, arrivalTimeMs: 0, frameDurationMs: 20 });
  estimator.recordPacket({ sequence: 1, mediaTimestampMs: 20, arrivalTimeMs: 20, frameDurationMs: 20 });
  const snapshot = estimator.recordPacket({ sequence: 2, mediaTimestampMs: 40, arrivalTimeMs: 90, frameDurationMs: 20 });
  assert.equal(snapshot.activeTargetMs, 120);
  assert.equal(snapshot.relativeDelayP95Ms, 50);
});

test('adds jitter and scheduling margin without a fixed pre-roll allowance', () => {
  const estimator = new RealtimeJitterEstimator({
    minTargetMs: 40,
    initialTargetMs: 40,
    softFloorMs: 40,
    maxTargetMs: 400,
    frameDurationMs: 20,
    basePreRollMs: 0,
    schedulingMarginMs: 10,
    nowMs: 0,
  });

  estimator.recordPacket({ sequence: 0, arrivalTimeMs: 0, frameDurationMs: 20 });
  estimator.recordPacket({ sequence: 1, arrivalTimeMs: 48, frameDurationMs: 20 });
  const withinFloor = estimator.recordPacket({ sequence: 2, arrivalTimeMs: 68, frameDurationMs: 20 });
  assert.equal(withinFloor.relativeDelayP95Ms, 28);
  assert.equal(withinFloor.recommendedTargetMs, 40);
  assert.equal(withinFloor.activeTargetMs, 40);

  const aboveFloor = estimator.recordPacket({ sequence: 3, arrivalTimeMs: 105, frameDurationMs: 20 });
  assert.equal(aboveFloor.relativeDelayP95Ms, 45);
  assert.equal(aboveFloor.recommendedTargetMs, 60);
  assert.equal(aboveFloor.activeTargetMs, 60);
});

test('uses probes as startup jitter samples', () => {
  const estimator = createEstimator(0);
  estimator.recordProbe({ sequence: 1, sentAtMs: 1000, arrivalTimeMs: 5000, intervalMs: 200 });
  const snapshot = estimator.recordProbe({ sequence: 2, sentAtMs: 1200, arrivalTimeMs: 5260, intervalMs: 200 });
  assert.equal(snapshot.activeTargetMs, 140);
});

test('holds target for 10s before stepping down', () => {
  const estimator = createEstimator(0);
  estimator.noteUnderrun(100);
  assert.equal(estimator.targetMs, 100);
  assert.equal(estimator.maybeUpdate(9000).activeTargetMs, 100);
  assert.equal(estimator.maybeUpdate(10100).activeTargetMs, 80);
});

test('underrun triggers a protective target increase', () => {
  const estimator = createEstimator(0);
  assert.equal(estimator.noteUnderrun(100).activeTargetMs, 100);
});

test('validates timing probe messages and seed TTL', () => {
  const probe = createRealtimeTimingProbe('voice-uplink', 3, 1200, 200);
  assert.equal(isRealtimeTimingProbeMessage(probe), true);
  assert.equal(isRealtimeTimingProbeMessage({ ...probe, stream: 'bad' }), false);
  assert.equal(resolveRealtimeJitterSeedTargetMs({ targetMs: 120, updatedAtMs: 1000 }, 2000, 5000), 120);
  assert.equal(resolveRealtimeJitterSeedTargetMs({ targetMs: 120, updatedAtMs: 1000 }, 7000, 5000), null);
  assert.equal(resolveRealtimeJitterSeedTargetMs({ targetMs: 'bad', updatedAtMs: 1000 }, 2000, 5000), null);
});
