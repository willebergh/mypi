import { app, type OffscreenSharedTexture } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { NativeBridgeStatus } from '../shared/types';

export interface NativeFrameResult {
  sequence: number;
  width: number;
  height: number;
  cpuSubmitMs: number;
  gpuMs: number | null;
  nativeLatencyMs: number;
  outputBGRA?: Buffer;
  sourceMatchesOutput?: boolean;
}
interface Addon {
  initialize(): { device: string };
  submit(surface: Buffer, width: number, height: number, format: string, sequence: number, readback: boolean): Promise<NativeFrameResult>;
  shutdown(): void;
  diagnostics(): NativeBridgeStatus['resources'];
}
interface ReadbackRequest {
  resolve: (result: NativeFrameResult) => void;
  reject: (error: Error) => void;
}
const resources = () => ({ inFlight: 0, sourceRetains: 0, destinationTextures: 0, readbackCount: 0 });
const initialStatus = (): NativeBridgeStatus => ({
  state: 'idle', device: '', framesReceived: 0, framesProcessed: 0, droppedFrames: 0,
  failedFrames: 0, inFlight: 0, maxInFlight: 0, lastSequence: 0, orderingErrors: 0,
  averageCpuSubmitMs: 0, averageGpuMs: null, averageNativeLatencyMs: 0, averageCompletionMs: 0,
  cpuSubmitTotalMs: 0, gpuTotalMs: 0, gpuTimedFrames: 0, completionTotalMs: 0,
  error: null, resources: resources(),
});

/** One GPU job, zero waiting frames. This class alone owns Electron's release callback. */
export class NativeBridge {
  private addon: Addon | null = null;
  private pending: Promise<void> | null = null;
  private accepting = false;
  private readback: ReadbackRequest | null = null;
  private nativeLatencyTotal = 0;
  private status = initialStatus();

  start(enabled: boolean) {
    if (this.pending) throw new Error('Native bridge was restarted before draining');
    this.status = initialStatus();
    this.nativeLatencyTotal = 0;
    if (!enabled) { this.status.state = 'disabled'; return; }
    if (process.platform !== 'darwin') { this.status.state = 'unavailable'; return; }
    try {
      // Opt-in development backend; keeps the existing Electron release/drain owner.
      // No scene/editor dependencies and no change to the in-house extension.
      const vc4m = process.env.VC4M_OUTPUT === '1'
        && !process.argv.includes('--verify') && process.env.PI_TALK_SYNTHETIC_FIXTURE !== '1';
      if (vc4m && app.isPackaged) throw new Error('VC4M_OUTPUT currently supports development runs only');
      const filename = vc4m ? path.join(app.getAppPath(), 'native/macos/vc4m/bridge-addon.cjs')
        : app.isPackaged ? path.join(process.resourcesPath, 'bridge.node')
        : path.join(app.getAppPath(), 'native/macos/build/Release/bridge.node');
      this.addon ??= createRequire(__filename)(filename) as Addon;
      this.status.device = this.addon.initialize().device;
      this.status.state = 'running';
      this.accepting = true;
    } catch (error) {
      this.status.state = 'error';
      this.status.error = String(error);
    }
  }

  snapshot(): NativeBridgeStatus {
    if (this.addon) this.status.resources = this.addon.diagnostics();
    return { ...this.status, resources: { ...this.status.resources } };
  }

  private releaseSource(release: () => void) {
    try { release(); }
    catch (error) {
      this.status.state = 'error';
      this.status.error = `Electron texture release failed: ${String(error)}`;
      this.accepting = false;
    }
  }

  consume(texture: OffscreenSharedTexture, release: () => void) {
    // Caller transfers ownership even for dropped/disabled frames. Never throw after transfer.
    const s = this.status;
    if (s.state === 'disabled' || s.state === 'unavailable' || s.state === 'idle') { this.releaseSource(release); return; }
    s.framesReceived++;
    if (!this.accepting || !this.addon || this.pending) {
      s.droppedFrames++;
      this.releaseSource(release);
      return;
    }
    const info = texture.textureInfo;
    const sequence = s.framesReceived;
    const started = performance.now();
    const debug = this.readback;
    this.readback = null;
    s.inFlight = 1;
    s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
    let operation: Promise<NativeFrameResult>;
    try {
      const surface = info.handle.ioSurface;
      if (!surface) throw new Error('Electron frame has no IOSurface handle');
      operation = this.addon.submit(surface, info.codedSize.width, info.codedSize.height,
        info.pixelFormat, sequence, !!debug);
    } catch (error) {
      operation = Promise.reject(error);
    }
    this.pending = operation.then(result => {
      if (result.sequence !== sequence || result.sequence <= s.lastSequence) s.orderingErrors++;
      s.lastSequence = result.sequence;
      s.framesProcessed++;
      s.cpuSubmitTotalMs += result.cpuSubmitMs;
      this.nativeLatencyTotal += result.nativeLatencyMs;
      s.completionTotalMs += performance.now() - started;
      if (result.gpuMs !== null) { s.gpuTimedFrames++; s.gpuTotalMs += result.gpuMs; }
      s.averageCpuSubmitMs = s.cpuSubmitTotalMs / s.framesProcessed;
      s.averageGpuMs = s.gpuTimedFrames ? s.gpuTotalMs / s.gpuTimedFrames : null;
      s.averageNativeLatencyMs = this.nativeLatencyTotal / s.framesProcessed;
      s.averageCompletionMs = s.completionTotalMs / s.framesProcessed;
      debug?.resolve(result);
    }).catch(error => {
      s.failedFrames++;
      s.error = String(error);
      s.state = 'error';
      this.accepting = false;
      debug?.reject(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      // submit resolves/rejects only after command completion and native source cleanup.
      this.releaseSource(release);
      s.inFlight = 0;
      this.pending = null;
    });
  }

  async readbackNext(): Promise<NativeFrameResult> {
    if (!this.accepting) throw new Error('Native GPU bridge is not running');
    if (this.readback) throw new Error('A debug readback is already pending');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.readback?.reject === fail) this.readback = null;
        reject(new Error('Timed out waiting for a native debug frame'));
      }, 5000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      this.readback = { resolve: result => { clearTimeout(timer); resolve(result); }, reject: fail };
    });
  }

  async drain() {
    this.accepting = false;
    if (this.status.state === 'running') this.status.state = 'draining';
    this.readback?.reject(new Error('Native bridge stopped before debug frame arrived'));
    this.readback = null;
    await this.pending;
  }

  async stop() {
    await this.drain();
    this.addon?.shutdown();
    if (this.status.state !== 'disabled' && this.status.state !== 'unavailable' && this.status.state !== 'error') {
      this.status.state = 'idle';
    }
    this.status.resources = this.addon?.diagnostics() ?? resources();
  }
}
