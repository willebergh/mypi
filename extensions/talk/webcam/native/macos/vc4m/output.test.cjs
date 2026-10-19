'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VirtualCameraOutput } = require('./output.cjs');
function backend(submit) {
  const calls = [];
  return { calls, discover: () => ({ available: true }), connect() { calls.push('connect'); },
    start() { calls.push('start'); }, stop() { calls.push('stop'); }, disconnect() { calls.push('disconnect'); },
    status: () => ({}), submit };
}
function texture(release = () => {}) {
  return { textureInfo: { codedSize: { width: 1280, height: 720 }, pixelFormat: 'bgra', handle: { ioSurface: Buffer.alloc(8) } }, release };
}
test('retains Electron frame through GPU completion, drops while busy, drains before stop', async () => {
  let complete, releases = 0;
  const native = backend(() => new Promise(resolve => { complete = resolve; }));
  const out = new VirtualCameraOutput(native);
  out.connect(); out.start();
  out.consume(texture(() => releases++), 1);
  assert.equal(releases, 0);
  out.consume(texture(() => releases++), 2);
  assert.equal(releases, 1);
  const stopping = out.stop();
  assert(!native.calls.includes('stop'));
  complete({ accepted: true }); await stopping;
  assert.equal(releases, 2); assert.equal(out.pending, null);
  assert.equal(out.droppedBusy, 1); assert(native.calls.includes('stop'));
});
test('release exceptions cannot prevent native disconnect', async () => {
  const native = backend(async () => ({ accepted: true }));
  const out = new VirtualCameraOutput(native); out.start();
  out.consume(texture(() => { throw new Error('release failure'); }), 1);
  await out.disconnect();
  assert.equal(out.pending, null); assert.equal(out.running, false);
  assert.match(out.errors[0], /release failure/);
  assert.deepEqual(native.calls, ['start', 'stop', 'disconnect']);
});
test('async disconnect error releases input and halts admission', async () => {
  let released = 0;
  const out = new VirtualCameraOutput(backend(async () => { throw new Error('device removed'); }));
  out.start(); out.consume(texture(() => released++), 1);
  await out.pending;
  assert.equal(released, 1); assert.equal(out.running, false); assert.match(out.errors[0], /device removed/);
  await out.disconnect();
});
test('synchronous submission failure and missing backend are reported', async () => {
  let released = 0;
  const native = backend(() => { throw new Error('not publishing'); });
  native.connect = () => { throw new Error('device missing'); };
  const out = new VirtualCameraOutput(native);
  assert.throws(() => out.connect(), /device missing/);
  out.start(); out.consume(texture(() => released++), 1);
  assert.equal(released, 1); assert.equal(out.running, false); assert.equal(out.pending, null);
  await out.disconnect();
});
test('native disconnect is attempted even when stop throws', async () => {
  const native = backend(() => {}); native.stop = () => { throw new Error('stop failure'); };
  const out = new VirtualCameraOutput(native);
  await assert.rejects(out.disconnect(), /stop failure/);
  assert(native.calls.includes('disconnect'));
});
