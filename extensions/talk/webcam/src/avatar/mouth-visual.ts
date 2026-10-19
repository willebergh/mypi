import type { SpeechAudioFrame } from '../shared/audio';

const BAND_COUNT = 12;
const MAX_AGE_MS = 250;
// Visual-only calibration for the fixed virtual agent input: measured speech RMS
// .00259–.00352, peaks .00734–.00849, strongest bands .063–.126.
// Keep a dual-level noise gate; capture levels and HUD RMS remain untouched.
const RMS_GATE = .0002;
const RMS_FULL = .0012;
const PEAK_GATE = .0008;
const BAND_FULL = .05;

/** Real spectrum only: no floor, synthetic bands, or per-frame peak normalization. */
export function mouthVisualTargets(audio: SpeechAudioFrame | undefined, now: number): Float32Array {
  const targets = new Float32Array(BAND_COUNT);
  if (!audio) return targets;
  const age = now - audio.timestamp;
  if (audio.state !== 'active' || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS
    || !Number.isFinite(audio.rms) || !Number.isFinite(audio.peak)
    || audio.rms <= RMS_GATE || audio.peak <= PEAK_GATE
    || audio.bands?.length !== BAND_COUNT || !audio.bands.every(Number.isFinite)) return targets;

  const level = Math.max(0, Math.min(1, (audio.rms - RMS_GATE) / (RMS_FULL - RMS_GATE)));
  const gate = level * level * (3 - 2 * level);
  for (let i = 0; i < BAND_COUNT; i++) {
    // Fixed square-root compression exposes low-level spectral detail while
    // retaining real per-band variation; exactly zero still maps to zero.
    targets[i] = gate * Math.sqrt(Math.max(0, Math.min(1, audio.bands[i] / BAND_FULL)));
  }
  return targets;
}
