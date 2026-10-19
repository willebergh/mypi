import assert from 'node:assert/strict';
import test from 'node:test';
import { mouthVisualTargets } from '../src/avatar/mouth-visual.ts';

const now = 10000;
const frame = (overrides = {}) => ({
  state: 'active', timestamp: now - 42, rms: .0025918, peak: .007342,
  bands: [0, .001, .002, .004, .008, .012, .018, .025, .035, .045, .055, .06307],
  ...overrides,
});
const silent = (audio, time = now) => assert.deepEqual([...mouthVisualTargets(audio, time)], Array(12).fill(0));

test('measured speech envelopes produce visible bounded real-band targets', () => {
  // Window maxima are calibration envelopes, not claimed simultaneous raw frames.
  for (const [rms, peak, bandMax, minimum] of [
    [.0025918, .007342, .06307, .45],
    [.0026497, .008489, .08508, .55],
    [.0035188, .008438, .12647, .99],
  ]) {
    const audio = frame({ rms, peak, bands: frame().bands.map(b => b / .06307 * bandMax) });
    const targets = [...mouthVisualTargets(audio, now)];
    assert.equal(targets[0], 0);
    assert.ok(targets[11] > minimum);
    assert.ok(targets.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
    assert.ok(targets.every((v, i) => i === 0 || v >= targets[i - 1]));
  }
});

test('zero, quiet, stale, unavailable, malformed and nonfinite inputs target silence', () => {
  silent(undefined);
  silent(frame({ rms: 0, peak: 0, bands: Array(12).fill(0) }));
  silent(frame({ bands: Array(12).fill(0) }));
  silent(frame({ rms: .0012 }));
  silent(frame({ peak: .0045 }));
  silent(frame({ timestamp: now - 251 }));
  silent(frame({ timestamp: now + 1 }));
  for (const state of ['off', 'starting', 'retrying', 'unavailable', 'error']) silent(frame({ state }));
  for (const value of [NaN, Infinity, -Infinity]) {
    silent(frame({ rms: value }));
    silent(frame({ peak: value }));
    silent(frame({ timestamp: value }));
    silent(frame({ bands: [value, ...Array(11).fill(.06)] }));
    silent(frame(), value);
  }
  for (const count of [0, 11, 13]) silent(frame({ bands: Array(count).fill(.06) }));
});

test('fixed scaling preserves spectral differences without peak normalization or fake voice', () => {
  const targets = mouthVisualTargets(frame({ rms: .0035, bands: [0, .03, .12, 2, ...Array(8).fill(0)] }), now);
  assert.deepEqual([...targets], [0, .5, 1, 1, ...Array(8).fill(0)]);
  assert.ok(mouthVisualTargets(frame({ timestamp: now - 250 }), now)[11] > 0);
  silent(frame({ bands: Array(12).fill(0) }));
});
