import type { FaceTimeRecord, FaceTimeTransport } from './facetime-transport';
import type { FaceTimeAspectStatus } from '../shared/types';
import type { SceneAspectRatio } from '../shared/scene-config';

type Aspect = SceneAspectRatio;
type Context = { windowId: string; peer: string; aspect: Aspect | null };
const record = (value: unknown): FaceTimeRecord => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as FaceTimeRecord : {};
const target = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value) <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
export function previewAspect(value: unknown): Aspect | null {
  const r = record(value), width = r.width, height = r.height;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)
    || width <= 0 || height <= 0 || width > 1e6 || height > 1e6) return null;
  // Square/near-square tiles are ambiguous; avoid flapping around 1:1.
  const ratio = width / height;
  return ratio > 1.05 ? '16:9' : ratio < 1 / 1.05 ? '9:16' : null;
}
function context(value: unknown): Context | null {
  const r = record(value);
  if (r.available !== true || r.source !== 'local_preview_geometry' || !target(r.windowId) || !target(r.peer)) return null;
  return { windowId: r.windowId, peer: r.peer, aspect: previewAspect(r.localPreview) };
}
export interface FaceTimeAspectOptions {
  createTransport(callbacks: {
    onSnapshot(snapshot: FaceTimeRecord): void;
    onEvent(event: FaceTimeRecord): void;
    onDisconnect(error: Error): void;
  }): FaceTimeTransport;
  getAspect(): Aspect;
  /** Recheck current() INSIDE the app's serialized mutation, not before enqueue. */
  applyAspect(aspect: Aspect, current: () => boolean): Promise<void>;
  onStatus?(status: FaceTimeAspectStatus): void;
  pollMs?: number;
}

/** FaceTime observation -> scene only; explicit studio choice -> one guarded rotation.
 * No renderer socket access, call/audio commands, mutation retries or offline replay.
 */
export class FaceTimeAspectSync {
  private readonly client: FaceTimeTransport;
  private enabled = false;
  private closed = false;
  private connected = false;
  private epoch = 0;
  private intent = 0;
  private manualPending = false;
  private desired: Aspect | null = null;
  private currentContext: Context | null = null;
  private error: string | null = null;
  private rotating = false;
  private readQueued = false;
  private tasks: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly options: FaceTimeAspectOptions;

  constructor(options: FaceTimeAspectOptions) {
    this.options = options;
    const pollMs = options.pollMs ?? 3000;
    if (!Number.isFinite(pollMs) || pollMs < 50) throw new Error('Invalid FaceTime aspect polling interval');
    this.client = options.createTransport({
      onSnapshot: snapshot => {
        if (this.closed || !this.enabled) return;
        this.epoch++;
        this.connected = true;
        this.error = null;
        this.currentContext = context(snapshot.video);
        this.publish();
        // Always reconcile freshly: snapshots are cached; first appearance and
        // disappearing/replaced contexts do not emit video.layout_changed.
        this.requestRead();
      },
      onEvent: event => {
        if (event.event === 'video.layout_changed' && event.source === 'local_preview_geometry') this.requestRead();
      },
      onDisconnect: error => {
        if (this.closed) return;
        this.epoch++;
        this.connected = false;
        this.currentContext = null;
        this.rotating = false;
        this.error = error.message;
        this.publish();
      },
    });
  }
  start() {
    if (this.closed || this.enabled) return;
    this.enabled = true;
    this.client.start();
    this.timer = setInterval(() => this.requestRead(), this.options.pollMs ?? 3000);
    this.timer.unref?.();
    this.publish();
  }
  status(): FaceTimeAspectStatus {
    return { enabled: this.enabled && !this.closed, connected: this.connected,
      available: this.currentContext !== null, observedAspect: this.currentContext?.aspect ?? null,
      desiredAspect: this.desired ?? this.options.getAspect(),
      state: !this.enabled || this.closed ? 'disabled' : !this.connected ? 'offline' : this.rotating ? 'rotating'
        : this.error ? 'error' : !this.currentContext || !this.currentContext.aspect ? 'unavailable' : 'following',
      error: this.error };
  }
  /** Notify synchronously when accepting an explicit studio aspect edit.
   * This fences an older observation already queued on the app's scene queue.
   */
  studioAspectChanged(aspect: Aspect) {
    if (this.closed || !this.enabled) return;
    const intent = ++this.intent, epoch = this.epoch;
    this.manualPending = true;
    this.desired = aspect;
    this.error = null;
    this.publish();
    this.enqueue(async () => {
      const valid = () => !this.closed && this.connected && epoch === this.epoch && intent === this.intent;
      try {
        // No offline intent replay. Reconnect will follow a fresh observation.
        if (!valid()) return;
        const before = context(await this.client.request('video.status'));
        if (!valid()) return;
        this.currentContext = before;
        if (!before) throw new Error('No unique FaceTime video view; scene changed locally, no rotation sent');
        if (!before.aspect) throw new Error('FaceTime preview orientation is ambiguous; no rotation sent');
        if (before.aspect === aspect) { this.error = null; return; }
        this.rotating = true;
        this.publish();
        // This is the ONLY mutation. Always use freshly read target values.
        const result = record(await this.client.request('video.rotate', {
          expectedWindowId: before.windowId, expectedPeer: before.peer,
        }));
        if (!valid()) return;
        const after = context(result.after);
        if (result.attempted !== true || result.verifiedChange !== true || !after
          || after.windowId !== before.windowId || after.peer !== before.peer || after.aspect !== aspect) {
          throw new Error('FaceTime rotation did not verify the requested orientation; not retried');
        }
        this.currentContext = after;
        this.error = null;
      } catch (error) {
        if (valid()) this.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (intent === this.intent) {
          this.manualPending = false;
          this.desired = null;
          this.rotating = false;
        }
        this.publish();
        // Read-only verification also absorbs delayed rotation-echo events.
        this.requestRead();
      }
    });
  }
  private enqueue(operation: () => Promise<void>) {
    this.tasks = this.tasks.then(operation).catch(error => {
      if (!this.closed) { this.error = String(error); this.publish(); }
    });
  }
  private requestRead() {
    if (this.closed || !this.enabled || !this.connected || this.readQueued || this.manualPending) return;
    this.readQueued = true;
    const epoch = this.epoch, intent = this.intent;
    this.enqueue(async () => {
      this.readQueued = false;
      const valid = () => !this.closed && this.connected && epoch === this.epoch && intent === this.intent && !this.manualPending;
      if (!valid()) return;
      try {
        const next = context(await this.client.request('video.status'));
        if (!valid()) return;
        this.currentContext = next;
        // Preserve explicit-action errors until the next studio edit or reconnect,
        // so a successful read does not hide an unverified/timed-out mutation.
        if (next?.aspect && next.aspect !== this.options.getAspect()) {
          await this.options.applyAspect(next.aspect, valid);
        }
        if (valid()) this.publish();
      } catch (error) {
        if (valid()) { this.error = error instanceof Error ? error.message : String(error); this.publish(); }
      }
    });
  }
  private publish() {
    if (this.closed) return;
    try { this.options.onStatus?.(this.status()); } catch { /* Isolate observer errors. */ }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.enabled = false;
    this.connected = false;
    this.epoch++;
    this.intent++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client.close();
  }
}
