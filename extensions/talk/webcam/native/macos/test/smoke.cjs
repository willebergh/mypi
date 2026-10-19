// Build both native/macos and native/macos/test with node-gyp, then run:
// UV_THREADPOOL_SIZE=1 node native/macos/test/smoke.cjs
'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { once } = require('node:events');
const bridge = require('../build/Release/bridge.node');
const fixture = require('./build/Release/fixture.node');
const BGRA = 0x42475241;
const RGBA = 0x52474241;

function expected(width, height, rgba) {
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const p = (y * width + x) * 4;
      const a = (x * 7 + y * 3) % 256;
      const b = (x * 13 + y) % 256;
      output[p] = rgba ? b : a;
      output[p + 1] = (x + y * 11) % 256;
      output[p + 2] = rgba ? a : b;
      output[p + 3] = 255;
    }
  }
  return output;
}

async function main() {
  assert.deepEqual(bridge.diagnostics(), {
    inFlight: 0, sourceRetains: 0, destinationTextures: 0, readbackCount: 0,
  });
  assert.throws(() => bridge.submit(), /initialize/);
  assert.equal(typeof bridge.initialize().device, 'string');
  bridge.initialize(); // Idempotent while idle.
  let sequence = 0.5; // Sequence is an opaque finite number, preserved exactly.
  for (const rgba of [false, true]) {
    const format = rgba ? 'rgba' : 'bgra';
    const surface = fixture.create(37, 19, rgba ? RGBA : BGRA);
    for (const bad of [Buffer.alloc(0), Buffer.alloc(surface.length + 1)]) {
      assert.throws(() => bridge.submit(bad, 37, 19, format, 0, false), /sizeof/);
    }
    assert.throws(() => bridge.submit(Buffer.alloc(surface.length), 37, 19, format, 0, false), /null/);
    assert.throws(() => bridge.submit(surface, 37.5, 19, format, 0, false), /integers/);
    assert.throws(() => bridge.submit(surface, 37, 19, format + 'X', 0, false), /pixelFormat/);
    assert.throws(() => bridge.submit(surface, 37, 19, format, NaN, false), /finite/);
    assert.throws(() => bridge.submit(surface, 38, 19, format, 0, false), /dimensions/);
    assert.throws(() => bridge.submit(surface, 37, 19, rgba ? 'bgra' : 'rgba', 0, false), /pixelFormat/);
    assert.equal(bridge.diagnostics().sourceRetains, 0);
    for (const debug of [false, true, false, true]) {
      const before = bridge.diagnostics().readbackCount;
      const promise = bridge.submit(surface, 37, 19, format, ++sequence, debug);
      assert.equal(bridge.diagnostics().inFlight, 1);
      assert.equal(bridge.diagnostics().sourceRetains, 1);
      assert.throws(() => bridge.submit(surface, 37, 19, format, 0, false), /busy/);
      assert.throws(() => bridge.shutdown(), /busy/);
      assert.throws(() => bridge.initialize(), /busy/);
      const result = await promise;
      assert.equal(result.sequence, sequence);
      assert.equal(result.width, 37);
      assert.equal(result.height, 19);
      assert(result.cpuSubmitMs >= 0);
      assert(result.nativeLatencyMs >= result.cpuSubmitMs);
      assert(result.gpuMs === null || result.gpuMs >= 0);
      assert.equal(bridge.diagnostics().sourceRetains, 0);
      assert.equal(bridge.diagnostics().inFlight, 0);
      assert.equal(bridge.diagnostics().destinationTextures, 1);
      assert.equal(bridge.diagnostics().readbackCount, before + Number(debug));
      if (debug) {
        assert.equal(result.sourceMatchesOutput, true);
        assert.deepEqual(result.outputBGRA, expected(37, 19, rgba));
      } else {
        assert(!('outputBGRA' in result));
        assert(!('sourceMatchesOutput' in result));
      }
    }
    const resized = fixture.create(38, 19, rgba ? RGBA : BGRA);
    assert.throws(() => bridge.submit(resized, 38, 19, format, 0, false), /fixed/);
    assert.equal(bridge.diagnostics().sourceRetains, 0);
    bridge.shutdown();
    assert.equal(bridge.diagnostics().destinationTextures, 0);
    bridge.initialize();
  }
  assert.throws(() => bridge.submit(fixture.create(37, 19, 0x4e563132), 37, 19, 'bgra', 0, false), /BGRA/);
  assert.throws(() => bridge.submit(fixture.create(37, 19, BGRA, 8), 37, 19, 'bgra', 0, false), /four-byte/);

  // Async init hooks can call back into the addon synchronously.
  const { createHook } = require('node:async_hooks');
  const hook = createHook({ init(id, type) {
    if (type === 'IOSurface Metal blit') {
      assert.throws(() => bridge.shutdown(), /busy/);
    }
  }}).enable();
  await bridge.submit(fixture.create(), 37, 19, 'bgra', ++sequence, false);
  hook.disable();
  bridge.shutdown();
  bridge.shutdown();

  // Force teardown while async GPU work is queued/running. When launched with
  // UV_THREADPOOL_SIZE=1, PBKDF2 holds the pool thread until cleanup has started.
  for (let i = 0; i < 5; ++i) {
    const worker = new Worker(__filename, { workerData: true, env: { ...process.env, UV_THREADPOOL_SIZE: '1' } });
    await once(worker, 'message');
    await worker.terminate();
  }
  console.log('macOS bridge smoke tests passed (BGRA/RGBA, busy, debug, cleanup)');
}

if (isMainThread) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
} else if (workerData) {
  bridge.initialize();
  require('node:crypto').pbkdf2('a', 'b', 1_000_000, 32, 'sha256', () => {});
  // Keep producer storage alive until teardown; Electron's release contract is
  // additionally the JS parent's responsibility, not just an IOSurface retain.
  global.surface = fixture.create(1024, 1024);
  bridge.submit(global.surface, 1024, 1024, 'bgra', 1, true);
  parentPort.postMessage('submitted');
}
