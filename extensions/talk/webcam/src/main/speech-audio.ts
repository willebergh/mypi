import { app, systemPreferences } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SPEECH_BAND_COUNT, SPEECH_DEVICE_NAME, SPEECH_DEVICE_UID, silentSpeechFrame,
  type SpeechAudioStatus } from '../shared/audio';

interface NativeStatus { devicePresent: boolean; running: boolean; error?: string; deviceName?: string; deviceUid: string }
interface NativeMeter {
  getStatus(): NativeStatus;
  start(): NativeStatus;
  stop(): void;
  readLevels(): { rms: number; peak: number; bands: number[]; sampleRate: number };
}
const level = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
// The native API uses -60..0 dBFS normalized bars for all meters; the renderer
// gates on linear RMS/peak while frequency bars retain their display scale.
const amplitude = (value: unknown) => level(value) > 0 ? Math.pow(10, (level(value) * 60 - 60) / 20) : 0;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const HEALTHY_RESET_MS = 30_000;
const permissionError = 'Microphone permission is required for the Pi Talk virtual input. Allow this app in System Settings → Privacy & Security → Microphone, then restart the app.';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
// The current native addon has only a generic PITALK_AUDIO_START code. Keep a
// narrow allowlist of its exact transient messages, not all start/render errors.
const retryable = (error: string) => /^(PiTalk input callbacks stalled \(>250 ms\)|No PiTalk input callback within 750 ms|PiTalk visible input (device is absent|disconnected))$/.test(error);

/** Sole owner of a fixed virtual-input meter. Metadata calls do not open streams;
 * normal-app startup calls enable(). Verification/synthetic runs must not do so.
 */
export class SpeechAudio {
  private addon: NativeMeter | null = null;
  private loadError: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private pending: Promise<SpeechAudioStatus> | null = null;
  private closed = false;
  private wanted = false;
  private requestedPermission = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private activeSince = 0;
  private stopError: string | null = null;
  private nativeError: string | null = null;
  private status: SpeechAudioStatus = {
    ...silentSpeechFrame(), deviceName: SPEECH_DEVICE_NAME, deviceUid: SPEECH_DEVICE_UID,
    backendAvailable: false, devicePresent: false, permission: 'unknown', error: null,
  };
  constructor(private readonly publish: (state: SpeechAudioStatus) => void, private readonly options: {
    platform?: string;
    loadMeter?: () => NativeMeter;
    permission?: () => SpeechAudioStatus['permission'];
    requestPermission?: () => Promise<boolean>;
    captureAllowed?: boolean;
    now?: () => number; // Monotonic clock; injectable for inert controller tests.
  } = {}) {}

  private permission(): SpeechAudioStatus['permission'] {
    if ((this.options.platform ?? process.platform) !== 'darwin') return 'unknown';
    const value = this.options.permission?.() ?? systemPreferences.getMediaAccessStatus('microphone');
    return ['not-determined', 'granted', 'denied', 'restricted'].includes(value)
      ? value as SpeechAudioStatus['permission'] : 'unknown';
  }
  private load(): void {
    if ((this.options.platform ?? process.platform) !== 'darwin') { this.loadError = 'Agent speech audio is currently available only on macOS.'; return; }
    if (this.addon) return;
    try {
      if (this.options.loadMeter) {
        this.addon = this.options.loadMeter();
        this.loadError = null;
        return;
      }
      const filename = app.isPackaged ? path.join(process.resourcesPath, 'pitalk_audio.node')
        : path.join(app.getAppPath(), 'native/macos/audio/build/Release/pitalk_audio.node');
      this.addon = createRequire(__filename)(filename) as NativeMeter;
      this.loadError = null;
    } catch {
      this.loadError = 'Audio meter is not built. Run pnpm audio:build, then restart Electron.';
    }
  }
  private emit(): SpeechAudioStatus {
    this.status = { ...this.status, timestamp: Date.now() };
    this.publish(this.status);
    return this.status;
  }
  getStatus(): SpeechAudioStatus {
    this.load(); // Loading/metadata never starts a stream, even in fixtures.
    try {
      const native = this.addon?.getStatus();
      this.nativeError = native?.error ?? null;
      this.status = { ...this.status, permission: this.permission(), backendAvailable: !!this.addon,
        devicePresent: native?.devicePresent ?? false, deviceName: native?.deviceName || SPEECH_DEVICE_NAME,
        error: this.loadError ?? this.status.error };
      // Native metadata refresh can itself tear down a dead stream. Do not keep
      // publishing active/stale levels until the next periodic status check.
      if (this.status.state === 'active' && native && (!native.running || !native.devicePresent))
        return this.fail(native.error || (native.devicePresent ? 'Pi Talk input stopped unexpectedly.' : 'PiTalk visible input disconnected'));
    } catch (error) {
      this.nativeError = message(error);
      if (this.status.state === 'active') return this.fail(message(error));
      this.status = { ...this.status, error: message(error), devicePresent: false };
    }
    return this.status;
  }
  private current(token: number): boolean {
    return !this.closed && this.wanted && this.options.captureAllowed !== false && token === this.generation;
  }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  enable(): Promise<SpeechAudioStatus> {
    if (this.closed || this.options.captureAllowed === false) return Promise.resolve(this.status);
    if (this.pending) return this.pending;
    if (this.wanted) return Promise.resolve(this.getStatus());
    this.wanted = true;
    this.retries = 0;
    return this.begin(true);
  }
  private begin(allowPrompt: boolean): Promise<SpeechAudioStatus> {
    const token = ++this.generation;
    // Install pending before start can publish/reenter or await a permission reply.
    const operation = Promise.resolve().then(() => this.start(token, allowPrompt))
      .finally(() => { if (this.pending === operation) this.pending = null; });
    this.pending = operation;
    return operation;
  }
  private async start(token: number, allowPrompt: boolean): Promise<SpeechAudioStatus> {
    if (!this.current(token)) return this.status;
    const initial = this.getStatus();
    if (this.stopError) return this.fail(this.stopError);
    if (!this.addon) return this.fail(this.loadError || 'Audio backend unavailable.');
    if (!initial.devicePresent) {
      // Only absence without another native fault is retryable; lookup/format
      // errors are deliberately not guessed to be transient.
      const absent = this.nativeError == null || retryable(this.nativeError);
      const error = absent ? 'PiTalk visible input device is absent' : this.nativeError!;
      return this.fail(error, absent, absent
        ? 'Pi Talk virtual input is absent. No microphone fallback is allowed.' : error);
    }
    this.status = { ...initial, ...silentSpeechFrame('starting'), error: null };
    this.emit();
    if (!this.current(token)) return this.status;
    try {
      let permission = this.permission();
      if (permission === 'not-determined' && allowPrompt && !this.requestedPermission) {
        this.requestedPermission = true;
        const granted = await (this.options.requestPermission?.() ?? systemPreferences.askForMediaAccess('microphone'));
        permission = granted ? 'granted' : this.permission();
      }
      if (!this.current(token)) return this.status;
      if (permission !== 'granted') return this.fail(permissionError);
      const native = this.addon.start();
      this.status = { ...this.status, devicePresent: native.devicePresent };
      if (!native.running || !native.devicePresent) throw new Error(native.error || 'The Pi Talk input did not start.');
      this.status = { ...this.status, ...silentSpeechFrame('active'), permission, error: null, devicePresent: native.devicePresent };
      this.activeSince = this.now();
      this.poll = setInterval(() => this.sample(token), 50);
      this.poll.unref();
      return this.emit();
    } catch (error) {
      if (!this.current(token)) return this.status;
      return this.fail(message(error));
    }
  }
  private sample(token: number): void {
    if (!this.current(token) || !this.addon || this.status.state !== 'active') return;
    try {
      if (this.permission() !== 'granted') { this.fail(permissionError); return; }
      const frame = this.addon.readLevels();
      // readLevels() can stop AUHAL without throwing. Inspect running/error on
      // every poll, before accepting that frame (not just once each second).
      this.getStatus();
      if (!this.current(token) || this.status.state !== 'active') return;
      if (this.now() - this.activeSince >= HEALTHY_RESET_MS) this.retries = 0;
      this.status = { ...this.status, rms: amplitude(frame.rms), peak: amplitude(frame.peak),
        bands: Array.from({ length: SPEECH_BAND_COUNT }, (_, i) => level(frame.bands?.[i])) };
      this.emit();
    } catch (error) { this.fail(message(error)); }
  }
  private cancelRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
  private fail(error: string, transient = retryable(error), detail = error): SpeechAudioStatus {
    this.cancelRetry();
    this.stopNative(); // Dispose/drain the old AUHAL before scheduling any new one.
    this.status = { ...this.status, ...silentSpeechFrame('unavailable'), permission: this.permission(),
      error: this.stopError ? `${detail} ${this.stopError}` : detail };
    if (transient && !this.stopError && this.wanted && !this.closed && this.options.captureAllowed !== false &&
        this.status.permission === 'granted' && this.addon) {
      const delay = RETRY_DELAYS_MS[this.retries];
      if (delay !== undefined) {
        ++this.retries;
        const token = this.generation;
        this.status = { ...this.status, state: 'retrying', error: `${detail} Retrying in ${delay / 1000}s (${this.retries}/${RETRY_DELAYS_MS.length}).` };
        this.retry = setTimeout(() => {
          if (!this.current(token)) return; // Queued callbacks from old generations are inert.
          this.retry = null;
          if (this.permission() !== 'granted') { this.fail(permissionError); return; }
          if (!this.pending) void this.begin(false); // Retries can NEVER request permission.
        }, delay);
        this.retry.unref();
      } else this.status.error = `${detail} Automatic recovery exhausted (${RETRY_DELAYS_MS.length} retries); restart the app to retry.`;
    }
    return this.emit();
  }
  private stopNative(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    try { this.addon?.stop(); }
    catch (error) { this.stopError = `Audio teardown failed; restart the app. ${message(error)}`; }
  }
  disable(): SpeechAudioStatus {
    this.wanted = false;
    ++this.generation; // Late permission replies and queued polls/retries cannot revive capture.
    this.cancelRetry();
    // Retain pending until it settles: disable/enable must not overlap permission requests.
    this.stopNative();
    this.status = { ...this.status, ...silentSpeechFrame(), error: this.stopError, permission: this.permission() };
    return this.emit();
  }
  close(): void { this.closed = true; this.disable(); }
}
