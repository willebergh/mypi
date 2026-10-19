'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('./bridge-addon.cjs');
function fixture() {
  const calls = [];
  const camera = { connect() { calls.push('connect'); }, start() { calls.push('start'); },
    disconnect() { calls.push('disconnect'); }, status: () => ({ inFlight: 0, error: '' }),
    async submit() { calls.push('camera'); return { accepted: true, gpuMs: 0.1, cpuSubmitMs: 0.2, nativeLatencyMs: 0.5 }; } };
  const metal = { initialize: () => ({ device: 'Metal' }), shutdown() { calls.push('shutdown'); },
    diagnostics: () => ({ inFlight: 0, sourceRetains: 0, destinationTextures: 0, readbackCount: 0 }),
    async submit() { calls.push('debug'); return { outputBGRA: Buffer.from([1]), sourceMatchesOutput: true }; } };
  return { camera, metal, calls, adapter: createAdapter(camera, metal) };
}
test('production frames publish without the extra private-texture copy', async () => {
  const { adapter, calls } = fixture(); adapter.initialize();
  const frame = await adapter.submit(Buffer.alloc(8), 1280, 720, 'bgra', 7, false);
  assert.equal(frame.sequence, 7); assert.equal(frame.width, 1280);
  assert.deepEqual(calls, ['connect', 'start', 'camera']); adapter.shutdown();
  assert.deepEqual(calls.slice(-2), ['disconnect', 'shutdown']);
});
test('explicit debug readback finishes before camera publication', async () => {
  const { adapter, calls } = fixture(); adapter.initialize();
  const frame = await adapter.submit(Buffer.alloc(8), 1280, 720, 'bgra', 1, true);
  assert(frame.sourceMatchesOutput); assert.deepEqual(calls.slice(-2), ['debug', 'camera']);
});
test('failed initialization disconnects both backends', () => {
  const { adapter, camera, calls } = fixture(); camera.start = () => { throw new Error('missing device'); };
  assert.throws(() => adapter.initialize(), /missing device/);
  assert.deepEqual(calls, ['connect', 'disconnect', 'shutdown']);
});
