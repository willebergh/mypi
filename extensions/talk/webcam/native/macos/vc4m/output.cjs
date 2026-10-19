'use strict';
// Optional output backend. No renderer/editor imports; receives trusted Electron
// SharedTexture objects from whichever offscreen source the caller owns.
class VirtualCameraOutput {
  constructor(native = require('./build/Release/vc4m.node')) {
    this.native = native;
    this.pending = null;
    this.running = false;
    this.droppedBusy = 0;
    this.released = 0;
    this.errors = [];
    this.samples = [];
  }
  discover() { return this.native.discover(); }
  connect() { return this.native.connect(); }
  start() { this.native.start(); this.running = true; }
  consume(texture, sequence) {
    const release = () => {
      try { texture.release(); this.released++; }
      catch (error) { this.errors.push(`Electron texture release failed: ${error}`); this.running = false; }
    };
    if (!this.running || this.pending) { this.droppedBusy++; release(); return; }
    // Hold the JS texture and release closure through GPU completion, not just
    // an IOSurface CFRetain (which does not stop Chromium overwriting pixels).
    let job;
    try {
      const info = texture.textureInfo;
      const { width, height } = info.codedSize;
      job = this.native.submit(info.handle.ioSurface, width, height, info.pixelFormat, sequence);
    } catch (error) {
      this.errors.push(String(error)); this.running = false; release(); return;
    }
    this.pending = Promise.resolve(job).then(result => {
      if (this.samples.length === 18000) this.samples.shift();
      this.samples.push(result);
    }).catch(error => {
      this.errors.push(String(error)); this.running = false;
    }).finally(() => { try { release(); } finally { this.pending = null; } });
  }
  async stop() {
    this.running = false;
    try { await this.pending; }
    catch (error) { this.errors.push(`Drain failed: ${error}`); }
    return this.native.stop();
  }
  async disconnect() { try { await this.stop(); } finally { this.native.disconnect(); } }
  status() {
    return { ...this.native.status(), admitting: this.running, droppedBusy: this.droppedBusy,
      released: this.released, errors: this.errors.slice(-10) };
  }
}
module.exports = { VirtualCameraOutput };
