'use strict';
// Implements the existing NativeBridge Addon contract. NativeBridge remains the
// sole owner of Electron's release callback, through BOTH GPU operations.
// Normal frames use only the camera adapter's GPU copy. Explicit debug readback
// requests additionally run the original Metal bridge (never in the hot path).
function createAdapter(camera, metal) {
  let initialized = false;
  return {
    initialize() {
      try {
        const device = metal.initialize().device;
        camera.connect(); camera.start(); initialized = true;
        console.log('[vc4m] Publishing hidden scene output: 1280x720 BGRA @ 30 FPS');
        return { device: `${device} → VirtualCamera4Mac` };
      } catch (error) {
        try { camera.disconnect(); } finally { metal.shutdown(); }
        throw error;
      }
    },
    async submit(surface, width, height, format, sequence, readback) {
      if (!initialized) throw new Error('VirtualCamera4Mac output is not initialized');
      // Await debug work before publishing; the caller holds Electron's texture
      // until this entire Promise resolves/rejects, including all error paths.
      const debug = readback ? await metal.submit(surface, width, height, format, sequence, true) : null;
      const frame = await camera.submit(surface, width, height, format, sequence);
      return { sequence, width, height, cpuSubmitMs: frame.cpuSubmitMs ?? 0,
        gpuMs: frame.gpuMs ?? null, nativeLatencyMs: frame.nativeLatencyMs ?? 0,
        ...(debug ? { outputBGRA: debug.outputBGRA, sourceMatchesOutput: debug.sourceMatchesOutput } : {}) };
    },
    shutdown() {
      try { camera.disconnect(); }
      finally { initialized = false; metal.shutdown(); }
    },
    diagnostics() {
      const s = camera.status(), m = metal.diagnostics();
      if (s.error) console.error('[vc4m]', s.error);
      return { inFlight: s.inFlight + m.inFlight, sourceRetains: s.inFlight + m.sourceRetains,
        destinationTextures: m.destinationTextures, readbackCount: m.readbackCount };
    },
  };
}
// Factory is exported for lifecycle tests without opening a camera stream.
module.exports.createAdapter = createAdapter;
for (const name of ['initialize', 'submit', 'shutdown', 'diagnostics']) {
  module.exports[name] = (...args) => {
    module.exports.instance ??= createAdapter(require('./build/Release/vc4m.node'), require('../build/Release/bridge.node'));
    return module.exports.instance[name](...args);
  };
}
