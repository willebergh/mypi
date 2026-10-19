import { BrowserWindow, type NativeImage } from 'electron';
import path from 'node:path';
import type { OutputPreviewFrame } from '../shared/output-view';
import type { RendererStatus } from '../shared/types';
import { NativeBridge } from './native-bridge';

export class OffscreenRenderer {
  readonly bridge = new NativeBridge();
  window: BrowserWindow | null = null;
  status: RendererStatus = {
    state: 'stopped', fps: 0, frameCount: 0, width: 1280, height: 720,
    mode: 'bitmap', sharedTexture: 'Not tested', error: null, native: this.bridge.snapshot(),
  };
  sharedFrames = 0;
  releasedTextures = 0;
  textureDescription: unknown = null;
  private latest: NativeImage | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampleTime = 0;
  private sampleCount = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private targetSize = { width: 1280, height: 720 };
  private nativeEnabled = false;
  private monitorEpoch = 0;
  private monitorLast = -Infinity;
  private monitorFrame: OutputPreviewFrame | null = null;
  private monitorPending: Promise<OutputPreviewFrame | null> | null = null;

  private invalidateMonitor() {
    this.monitorEpoch++;
    this.monitorFrame = null;
    this.monitorLast = -Infinity;
  }

  /** Small sampled readback of this exact output window, never a third scene.
   * Camera transport remains IOSurface→Metal; monitor requests are capped at 4Hz.
   */
  previewFrame(): Promise<OutputPreviewFrame | null> {
    const win = this.window;
    if (!win || win.isDestroyed() || this.status.state !== 'running' || !this.status.frameCount) return Promise.resolve(null);
    if (this.monitorPending) return this.monitorPending;
    if (performance.now() - this.monitorLast < 250) return Promise.resolve(this.monitorFrame);
    this.monitorLast = performance.now();
    const epoch = this.monitorEpoch;
    const pending = (async () => {
      try {
        const image = this.status.mode === 'bitmap' ? this.latest : await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        if (!image || image.isEmpty() || epoch !== this.monitorEpoch || this.window !== win || this.status.state !== 'running') return null;
        const size = image.getSize();
        if (size.width !== this.targetSize.width || size.height !== this.targetSize.height) return null;
        const scale = Math.min(1, 640 / Math.max(size.width, size.height));
        const thumbnail = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' });
        this.monitorFrame = { dataUrl: `data:image/jpeg;base64,${thumbnail.toJPEG(75).toString('base64')}`,
          width: size.width, height: size.height, sequence: this.status.frameCount, timestamp: Date.now() };
        return this.monitorFrame;
      } catch { this.monitorFrame = null; return null; }
    })().finally(() => { if (this.monitorPending === pending) this.monitorPending = null; });
    this.monitorPending = pending;
    return pending;
  }

  constructor(private load: (window: BrowserWindow) => Promise<void>, private publish: () => void) {}

  refreshStatus() {
    this.status.native = this.bridge.snapshot();
    return { ...this.status };
  }

  // Also serialize direct verification/fatal-renderer calls, not just UI IPC.
  private transition(operation: () => Promise<void>) {
    const pending = this.lifecycle.then(operation);
    this.lifecycle = pending.catch(() => {});
    return pending;
  }

  start(forceBitmap = false, nativeEnabled = process.env.NATIVE_BRIDGE !== '0') {
    return this.transition(() => this.startInternal(forceBitmap, nativeEnabled));
  }

  private async startInternal(forceBitmap: boolean, nativeEnabled: boolean) {
    if (this.window) return;
    this.status = { ...this.status, state: 'starting', frameCount: 0, fps: 0, error: null };
    this.nativeEnabled = !forceBitmap && nativeEnabled;
    this.bridge.start(this.nativeEnabled);
    this.refreshStatus();
    this.publish();
    try {
      if (!forceBitmap) {
        let failure = 'No usable native texture within 4s';
        try {
          await this.create(true);
          // Require a real native handle, not merely API availability.
          const deadline = performance.now() + 4000;
          while (this.sharedFrames === 0 && performance.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } catch (error) {
          failure = `Shared texture startup failed: ${String(error)}`;
        }
        if (this.sharedFrames === 0) {
          await this.destroy();
          this.nativeEnabled = false;
          this.bridge.start(false);
          this.status.sharedTexture = `${failure}; bitmap fallback`;
          await this.create(false);
        }
      } else {
        await this.create(false);
      }
      this.status.state = 'running';
      this.sampleTime = performance.now();
      this.sampleCount = this.status.frameCount;
      this.timer = setInterval(() => {
        const now = performance.now();
        this.status.fps = (this.status.frameCount - this.sampleCount) * 1000 / (now - this.sampleTime);
        this.sampleTime = now;
        this.sampleCount = this.status.frameCount;
        this.refreshStatus();
        this.publish();
      }, 1000);
      this.refreshStatus();
      this.publish();
    } catch (error) {
      await this.destroy();
      this.status.state = 'error';
      this.status.error = String(error);
      this.publish();
      throw error;
    }
  }

  setResolution(width: number, height: number) {
    return this.transition(async () => {
      if (width === this.targetSize.width && height === this.targetSize.height) return;
      this.targetSize = { width, height };
      this.invalidateMonitor();
      const win = this.window;
      if (win && !win.isDestroyed()) {
        win.webContents.stopPainting();
        // Metal destinations have fixed dimensions: drain/reinitialize just the bridge, not the window.
        await this.bridge.stop();
        this.latest = null;
        win.setContentSize(width, height);
        this.bridge.start(this.nativeEnabled);
        win.webContents.startPainting();
      }
      this.status.width = width; this.status.height = height;
      this.refreshStatus(); this.publish();
    });
  }

  private async create(shared: boolean) {
    this.sharedFrames = 0;
    this.releasedTextures = 0;
    this.status.mode = shared ? 'shared-texture' : 'bitmap';
    const win = new BrowserWindow({
      width: this.targetSize.width, height: this.targetSize.height, useContentSize: true, show: false,
      webPreferences: {
        offscreen: { useSharedTexture: shared, deviceScaleFactor: 1 },
        preload: path.join(__dirname, 'preload.cjs'),
        backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    this.window = win;
    this.invalidateMonitor();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => {
      if (event.url !== win.webContents.getURL()) event.preventDefault();
    });
    win.webContents.setFrameRate(30);
    // Vite can reload every page when a UI source file changes. Resume OSR after navigation.
    win.webContents.on('did-finish-load', () => win.webContents.startPainting());
    win.webContents.on('console-message', details => {
      if (details.level === 'error') console.error('[output]', details.message);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      void this.stop().then(() => {
        this.status.state = 'error';
        this.status.error = `Output renderer exited: ${details.reason}`;
        this.publish();
      });
    });
    win.webContents.on('paint', (event, _dirty, image) => {
      let handedOff = false;
      try {
        if (event.texture) {
          const info = event.texture.textureInfo;
          const handle = info.handle;
          if (handle.ioSurface?.length || handle.ntHandle?.length || handle.nativePixmap) {
            this.sharedFrames++;
            this.status.sharedTexture = `Native GPU handle received (${process.platform})`;
          }
          // Chromium can deliver an old-size frame while a resize is settling. Release, don't import it.
          if (info.codedSize.width !== this.targetSize.width || info.codedSize.height !== this.targetSize.height) return;
          this.textureDescription = {
            pixelFormat: info.pixelFormat, codedSize: info.codedSize,
            handleTypes: Object.keys(handle),
          };
          this.status.width = info.codedSize.width;
          this.status.height = info.codedSize.height;
          handedOff = true;
          this.bridge.consume(event.texture, () => {
            event.texture!.release();
            this.releasedTextures++;
          });
        } else if (!image.isEmpty()) {
          const incoming = image.getSize();
          if (incoming.width !== this.targetSize.width || incoming.height !== this.targetSize.height) return;
          // Retain only one NativeImage; replaced images become GC-eligible. No PNG conversion in hot path.
          this.latest = image;
          const size = image.getSize();
          this.status.width = size.width;
          this.status.height = size.height;
        } else return;
        this.status.frameCount++;
      } finally {
        if (event.texture && !handedOff) {
          event.texture.release();
          this.releasedTextures++;
        }
      }
    });
    await this.load(win);
  }

  async capturePNG(): Promise<Buffer> {
    if (!this.window || this.status.state !== 'running' || !this.status.frameCount) {
      throw new Error('No running renderer frame available');
    }
    // PNG is an explicit, on-demand readback, separate from native continuous GPU processing.
    const image = this.status.mode === 'bitmap' ? this.latest : await this.window.webContents.capturePage();
    if (!image || image.isEmpty()) throw new Error('Captured frame is empty');
    return image.toPNG();
  }

  stop() {
    return this.transition(async () => {
      await this.destroy();
      this.status.state = 'stopped';
      this.status.fps = 0;
      this.refreshStatus();
      this.publish();
    });
  }

  private async destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const win = this.window;
    this.window = null;
    this.invalidateMonitor();
    if (win && !win.isDestroyed()) win.webContents.stopPainting();
    // Electron's backing pool must outlive the last native GPU read. Drain before window destruction.
    await this.bridge.stop();
    if (win && !win.isDestroyed()) win.destroy();
    this.latest = null;
  }
}
