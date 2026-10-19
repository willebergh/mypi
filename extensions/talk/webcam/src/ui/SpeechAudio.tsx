import { useEffect, useRef, useState } from 'react';
import type { SpeechAudioStatus } from '../shared/audio';
import { acquireLiveHudFeed } from '../shared/live-feed';
import { captionCallActive, LIVE_HUD_STALE_MS } from '../shared/live-protocol';
import './SpeechAudio.css';

interface SpeechAudioApi {
  getSpeechAudioStatus: () => Promise<SpeechAudioStatus>;
  onSpeechAudio: (callback: (state: SpeechAudioStatus) => void) => () => void;
}

const api = () => window.webcam as unknown as Partial<SpeechAudioApi>;

// TEMPORARY renderer-only observation; remove this helper and its effect hooks.
// Retain the budget through React remounts/Vite HMR: never rearm on hot updates.
const TEMP_MOUTH_DIAGNOSTIC = true;
const diagnosticBudget: { started: number; records: number; initialLogged: boolean } = import.meta.hot
  ? (import.meta.hot.data.mouthDiagnosticCallback55 ??= { started: 0, records: 0, initialLogged: false })
  : { started: 0, records: 0, initialLogged: false };

function mouthDiagnostic() {
  const budget = diagnosticBudget;
  if (!TEMP_MOUTH_DIAGNOSTIC) return { accept: (_next: SpeechAudioStatus) => {}, unavailable: () => {}, dispose: () => {} };
  let live = true;
  let latest: SpeechAudioStatus | null = null;
  let windowStart = Date.now();
  let samples = 0, maxRms = 0, maxPeak = 0, maxBand = 0;
  const level = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  const fault = (error: string | null) => !error ? null
    : /PiTalk input callbacks stalled|No PiTalk input callback within/.test(error) ? 'callback-stall'
    : /Microphone permission/.test(error) ? 'permission'
    : /PiTalk visible input (?:device is absent|disconnected)|Pi Talk virtual input is absent/.test(error) ? 'missing-device'
    : /format|sample rate|channel count/i.test(error) ? 'format' : 'other';
  const active = () => live && budget.started > 0 && budget.records < 8 && Date.now() <= budget.started + 90_000;
  const emit = (reason: 'current' | 'change' | 'window-end' | 'status-unavailable') => {
    if (!active()) return;
    const now = Date.now(), s = latest;
    const age = s && Number.isFinite(s.timestamp) && s.timestamp > 0 ? now - s.timestamp : null;
    const fresh = age !== null && age >= 0 && age <= 250;
    const bands12 = s?.bands?.length === 12;
    // Match the mouth's existing freshness/audibility gates; do not change them.
    const audioActive = s?.state === 'active' && fresh && bands12 && level(s.rms) > .003 && level(s.peak) > .006;
    const retry = s?.error?.match(/Retrying in (\d{1,3})s \((\d{1,2})\/(\d{1,2})\)\.$/);
    console.error('[mouth-diagnostic-callback55]', JSON.stringify({
      record: ++budget.records, reason, elapsedMs: now - budget.started,
      state: s && ['off', 'starting', 'retrying', 'active', 'unavailable', 'error'].includes(s.state) ? s.state : 'unknown',
      backendAvailable: typeof s?.backendAvailable === 'boolean' ? s.backendAvailable : null,
      devicePresent: typeof s?.devicePresent === 'boolean' ? s.devicePresent : null,
      permission: s && ['not-determined', 'granted', 'denied', 'restricted', 'unknown'].includes(s.permission) ? s.permission : 'unknown',
      fault: fault(s?.error ?? null),
      retry: retry ? { delayMs: Number(retry[1]) * 1000, attempt: Number(retry[2]), limit: Number(retry[3]) } : null,
      retryExhausted: !!s?.error?.includes('Automatic recovery exhausted'),
      frameAgeMs: age, bands12, fresh, audioActive,
      window: { durationMs: now - windowStart, samples, maxRms, maxPeak, maxBand },
    }));
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const schedule = () => {
    // Absolute deadlines survive remounts; never replay missed windows or rearm.
    for (const offset of [5_000, 10_000, 20_000, 35_000, 60_000, 75_000, 89_900]) {
      const remaining = budget.started + offset - Date.now();
      if (remaining <= 0) continue;
      timers.push(setTimeout(() => {
        emit('window-end');
        samples = 0; maxRms = 0; maxPeak = 0; maxBand = 0; windowStart = Date.now();
      }, remaining));
    }
  };
  const feed = acquireLiveHudFeed();
  const arm = () => {
    if (budget.started || !live) return;
    const state = feed.read(), now = Date.now(), snapshot = state.snapshot;
    if (state.mode !== 'live' || state.connection !== 'live' || !snapshot
      || now - snapshot.timestamp < -1000 || now - snapshot.timestamp >= LIVE_HUD_STALE_MS
      || !captionCallActive(snapshot.talk)) return;
    budget.started = now;
    windowStart = now;
    schedule();
    if (latest && !budget.initialLogged) { budget.initialLogged = true; emit('current'); }
  };
  const unsubscribe = feed.subscribe(arm);
  if (budget.started) schedule();
  else arm();
  return {
    accept(next: SpeechAudioStatus) {
      latest = next;
      if (!active()) return;
      samples++;
      maxRms = Math.max(maxRms, level(next.rms));
      maxPeak = Math.max(maxPeak, level(next.peak));
      for (const band of next.bands ?? []) maxBand = Math.max(maxBand, level(band));
      if (!budget.initialLogged) { budget.initialLogged = true; emit('current'); }
    },
    unavailable() { emit('status-unavailable'); },
    dispose() { live = false; timers.forEach(clearTimeout); unsubscribe(); feed.dispose(); },
  };
}

export default function SpeechAudio() {
  const [status, setStatus] = useState<SpeechAudioStatus | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const current = api();
    const diagnostic = mouthDiagnostic();
    if (typeof current.getSpeechAudioStatus !== 'function' || typeof current.onSpeechAudio !== 'function') {
      setAvailable(false);
      diagnostic.unavailable();
      return () => { mounted.current = false; revision.current++; diagnostic.dispose(); };
    }
    setAvailable(true);
    let receivedEvent = false;
    const unsubscribe = current.onSpeechAudio(next => {
      receivedEvent = true;
      revision.current++;
      if (mounted.current) { diagnostic.accept(next); setStatus(next); }
    });
    const request = ++revision.current;
    current.getSpeechAudioStatus().then(next => {
      if (mounted.current && !receivedEvent && revision.current === request) { diagnostic.accept(next); setStatus(next); }
    }).catch(() => {
      if (mounted.current && revision.current === request) { diagnostic.unavailable(); setAvailable(false); }
    });
    return () => {
      mounted.current = false;
      revision.current++;
      diagnostic.dispose();
      unsubscribe();
    };
  }, []);

  const message = available === false
    ? 'Audio status unavailable. Restart Electron after updating the webcam app.'
    : status?.backendAvailable === false
      ? status.error || 'Audio backend unavailable. Run pnpm audio:build, then restart Electron.'
      : status?.devicePresent === false
        ? status.error || 'Pi Talk virtual input not found. No other audio input will be used.'
        : status?.permission === 'denied' || status?.permission === 'restricted'
          ? 'Microphone permission denied. Grant access in System Settings → Privacy & Security → Microphone.'
          : status?.error || '';
  const listening = status?.state === 'active';
  const label = status?.state === 'retrying' ? 'Retrying…' : status?.state === 'starting' ? 'Starting…' : listening ? 'Listening' : status?.state === 'error' || status?.state === 'unavailable' || available === false ? 'Unavailable' : 'Starting…';
  const level = Math.round(Math.max(0, Math.min(1, status?.rms ?? 0)) * 100);

  return <fieldset className="speech-audio">
    <legend className="visually-hidden">Agent speech / mouth</legend>
    <div className="speech-summary"><span>Speech</span><strong className={`speech-status ${listening ? 'is-listening' : ''}`} role="status">{label}</strong></div>
    <div className="speech-level" role="img" aria-label={`Agent speech audio level ${level} percent`}>
      <span>Mouth level</span><span className="speech-level-track"><span style={{ width: `${level}%` }} /></span>
    </div>
    {message && <p role="alert" className="speech-message">{message}</p>}
    <details className="speech-routing"><summary>Virtual input only</summary><p className="panel-note">Always listens to the Pi Talk virtual agent-speech input only. No physical/default microphone or caller audio is captured. Listening stops when the app quits. This meter is read-only.</p></details>
  </fieldset>;
}
