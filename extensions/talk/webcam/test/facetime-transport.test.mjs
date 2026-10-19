import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createFaceTimeTransport } from '../src/main/facetime-transport.ts';

const snapshot = (seq = 0, serviceInstanceId = 'service-a') => ({
  type: 'snapshot', protocolVersion: 1, serviceInstanceId, seq,
  call: { phase: 'idle' }, video: { available: true },
});
const event = (seq, extra = {}) => ({
  type: 'event', protocolVersion: 1, serviceInstanceId: 'service-a', seq,
  event: 'video.layout', video: { orientation: 'portrait' }, ...extra,
});
const line = (record) => JSON.stringify(record) + '\n';
const response = (id, result, extra = {}) => ({ type: 'response', protocolVersion: 1, id, ok: true, result, ...extra });
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Timed out waiting for fake socket activity');
}
async function fixture(t, accept = (socket) => socket.write(line(snapshot())), overrides = {}) {
  // Short paths also work within macOS's small sockaddr_un path limit.
  const dir = await mkdtemp(join(tmpdir(), 'ft-'));
  const path = join(dir, 's');
  const sockets = [];
  const commands = [];
  const snapshots = [];
  const events = [];
  const disconnects = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        commands.push({ socket, record: JSON.parse(buffer.slice(0, index)) });
        buffer = buffer.slice(index + 1);
      }
    });
    accept(socket, sockets.length);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const client = createFaceTimeTransport({
    socketPath: path, onSnapshot: (r) => snapshots.push(r), onEvent: (r) => events.push(r),
    onDisconnect: (e) => disconnects.push(e), requestTimeoutMs: 100,
    snapshotTimeoutMs: 100, reconnectMinMs: 10, reconnectMaxMs: 20, ...overrides,
  });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { client, sockets, commands, snapshots, events, disconnects, path };
}

test('fragmented UTF-8 and combined NDJSON preserve raw video events; duplicates are ignored', async (t) => {
  const f = await fixture(t, () => {});
  f.client.start();
  f.client.start();
  await until(() => f.sockets.length === 1);
  const raw = event(1, { label: 'hé🙂', extraField: { untouched: true } });
  const bytes = Buffer.from(line(snapshot()) + line(raw) + line(event(1)) + line(event(0)) + line(event(3)));
  const split = bytes.indexOf(Buffer.from('🙂')) + 2;
  f.sockets[0].write(bytes.subarray(0, split));
  await delay(10);
  f.sockets[0].write(bytes.subarray(split));
  await until(() => f.events.length === 2);
  assert.deepEqual(f.snapshots, [snapshot()]);
  assert.deepEqual(f.events, [raw, event(3)]);
  assert.equal(f.sockets.length, 1);
});

test('correlates reversed responses, reports command errors, enforces video-only envelope', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.request('video.status'), /not connected/);
  f.client.start();
  await until(() => f.snapshots.length);
  for (const command of ['call', 'answer', 'hangup', 'audio.select', 'screen.share', 'status']) {
    await assert.rejects(f.client.request(command), /Only FaceTime/);
  }
  const first = f.client.request('video.status', { type: 'evil', command: 'call', id: 'forged' });
  const second = f.client.request('video.status');
  await until(() => f.commands.length === 2);
  const [a, b] = f.commands.map((c) => c.record);
  assert.equal(a.command, 'video.status');
  assert.equal(a.type, 'command');
  assert.notEqual(a.id, 'forged');
  assert.notEqual(a.id, b.id);
  f.sockets[0].write(line(response('unknown', null)) + line(response(b.id, { second: true }))
    + line(response(a.id, null, { ok: false, error: { message: 'not available' } })));
  await assert.rejects(first, /not available/);
  assert.deepEqual(await second, { second: true });
});

test('pending and outgoing limits; serialization cannot substitute non-video commands', async (t) => {
  const f = await fixture(t, undefined, { requestTimeoutMs: 500 });
  f.client.start();
  await until(() => f.snapshots.length);
  await assert.rejects(f.client.request('video.status', { padding: 'x'.repeat(64 * 1024) }), /size limit/);
  const circular = {}; circular.self = circular;
  await assert.rejects(f.client.request('video.status', circular), /encode/);
  const requests = Array.from({ length: 8 }, () => f.client.request('video.status', {
    toJSON: () => ({ command: 'call', type: 'command' }),
  }));
  const settled = Promise.allSettled(requests);
  await assert.rejects(f.client.request('video.status'), /Too many pending/);
  await until(() => f.commands.length === 8);
  assert.ok(f.commands.every(({ record }) => record.command === 'video.status'));
  f.client.close();
  assert.ok((await settled).every((r) => r.status === 'rejected' && /closed/.test(r.reason.message)));
});

test('request timeout ignores late responses and never replays after reconnect', async (t) => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.snapshots.length);
  await assert.rejects(f.client.request('video.status'), /timed out.*not retried/);
  await until(() => f.commands.length === 1);
  f.sockets[0].write(line(response(f.commands[0].record.id, 'late')));
  f.sockets[0].destroy();
  await until(() => f.snapshots.length === 2);
  await delay(30);
  assert.equal(f.commands.length, 1);
  const next = f.client.request('video.status');
  await until(() => f.commands.length === 2);
  f.sockets[1].write(line(response(f.commands[1].record.id, 'fresh')));
  assert.equal(await next, 'fresh');
});

test('disconnect rejects pending, requires a fresh snapshot, and permits a new service sequence', async (t) => {
  const f = await fixture(t, (socket, n) => {
    if (n === 1) socket.write(line(snapshot(20)));
  });
  f.client.start();
  await until(() => f.snapshots.length);
  const request = f.client.request('video.status');
  const rejected = assert.rejects(request, /disconnected/);
  await until(() => f.commands.length);
  f.sockets[0].destroy();
  await rejected;
  await until(() => f.sockets.length === 2);
  await assert.rejects(f.client.request('video.status'), /not connected/);
  f.sockets[1].write(line(snapshot(0, 'service-b')) + line(event(1, { serviceInstanceId: 'service-b' })));
  await until(() => f.events.length);
  assert.equal(f.snapshots.length, 2);
  assert.equal(f.commands.length, 1);
});

for (const [name, records] of [
  ['malformed JSON', '{broken\n'],
  ['non-object', '[]\n'],
  ['wrong snapshot version', line({ ...snapshot(), protocolVersion: 2 })],
  ['missing call.phase', line({ ...snapshot(), call: {} })],
  ['unsafe snapshot seq', line(snapshot(Number.MAX_SAFE_INTEGER + 1))],
  ['missing service instance', line({ ...snapshot(), serviceInstanceId: '' })],
  ['wrong event instance', line(snapshot()) + line(event(1, { serviceInstanceId: 'other' }))],
  ['wrong event version', line(snapshot()) + line(event(1, { protocolVersion: 2 }))],
  ['negative event seq', line(snapshot()) + line(event(-1))],
  ['wrong response version', line(snapshot()) + line(response('id', {}, { protocolVersion: 2 }))],
  ['oversize unterminated line', 'x'.repeat(256 * 1024 + 1)],
  ['oversize terminated line', 'x'.repeat(256 * 1024 + 1) + '\n'],
  ['invalid UTF-8', Buffer.from([0xff, 10])],
]) {
  test(`disconnects on ${name}`, async (t) => {
    const f = await fixture(t, (socket) => socket.write(records), { reconnectMinMs: 200, reconnectMaxMs: 200 });
    f.client.start();
    await until(() => f.disconnects.length);
    assert.ok(f.disconnects[0] instanceof Error);
    assert.equal(f.disconnects.length, 1);
    await assert.rejects(f.client.request('video.status'), /not connected/);
  });
}

test('same-service snapshot may not regress watermark', async (t) => {
  const f = await fixture(t, (socket, n) => socket.write(line(snapshot(n === 1 ? 10 : 9))));
  f.client.start();
  await until(() => f.snapshots.length);
  f.sockets[0].destroy();
  await until(() => f.disconnects.length >= 2);
  assert.equal(f.snapshots.length, 1);
});

test('snapshot timeout and partial EOF reconnect without replay', async (t) => {
  const f = await fixture(t, (socket, n) => {
    if (n === 2) socket.end('{"type":');
    if (n >= 3) socket.write(line(snapshot()));
  }, { snapshotTimeoutMs: 30 });
  f.client.start();
  await until(() => f.snapshots.length);
  assert.match(f.disconnects[0].message, /snapshot timed out/);
  assert.match(f.disconnects[1].message, /Incomplete/);
  assert.equal(f.commands.length, 0);
});

test('callback exceptions are isolated; close from callback suppresses remaining records', async (t) => {
  let count = 0;
  const f = await fixture(t, undefined, {
    onSnapshot() { throw new Error('consumer'); },
    onEvent() { count++; if (count === 2) f.client.close(); throw new Error('consumer'); },
    onDisconnect() { throw new Error('consumer'); },
  });
  f.client.start();
  await until(() => f.sockets.length);
  f.sockets[0].write(line(event(1)) + line(event(2)) + line(event(3)));
  await until(() => count === 2);
  await delay(40);
  assert.equal(count, 2);
  f.client.start();
  await assert.rejects(f.client.request('video.status'), /not connected/);
  assert.equal(f.sockets.length, 1);
});

test('close cancels pending and reconnect callbacks permanently', async (t) => {
  const f = await fixture(t);
  f.client.start();
  await until(() => f.snapshots.length);
  const pending = f.client.request('video.status');
  const rejection = assert.rejects(pending, /closed/);
  f.client.close();
  f.client.close();
  await rejection;
  await delay(50);
  assert.equal(f.disconnects.length, 0);
  assert.equal(f.sockets.length, 1);
});

test('missing optional socket and reconnect timers do not hold a process open', async () => {
  const moduleURL = new URL('../src/main/facetime-transport.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createFaceTimeTransport } from ${JSON.stringify(moduleURL)};
    const client = createFaceTimeTransport({ socketPath: '/nonexistent/facetime.sock',
      onSnapshot() {}, onEvent() {}, onDisconnect() {}, reconnectMinMs: 1 });
    client.start();
  `], { timeout: 2000, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});

test('live socket, snapshot timer, and pending request timer are all unrefed', async (t) => {
  const f = await fixture(t);
  const moduleURL = new URL('../src/main/facetime-transport.ts', import.meta.url).href;
  // Use asynchronous spawn so this process can continue serving the fake socket.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createFaceTimeTransport } from ${JSON.stringify(moduleURL)};
    const keepAlive = setTimeout(() => process.exit(7), 1500);
    const client = createFaceTimeTransport({ socketPath: ${JSON.stringify(f.path)},
      onSnapshot() {
        client.request('video.status').catch(() => {});
        clearTimeout(keepAlive);
      }, onEvent() {}, onDisconnect() {} });
    client.start();
  `], { stdio: 'ignore' });
  t.after(() => child.kill());
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  assert.equal(f.commands.length, 1);
});

test('throwing disconnect callback cannot prevent reconnect; close cancels scheduled retry', async (t) => {
  let disconnected = 0;
  const f = await fixture(t, undefined, {
    onDisconnect() { disconnected++; throw new Error('consumer'); },
    reconnectMinMs: 50, reconnectMaxMs: 50,
  });
  f.client.start();
  await until(() => f.snapshots.length === 1);
  f.sockets[0].destroy();
  await until(() => f.snapshots.length === 2);
  f.sockets[1].destroy();
  await until(() => disconnected === 2);
  f.client.close();
  await delay(80);
  assert.equal(f.sockets.length, 2);
});

test('validates timer bounds', () => {
  const callbacks = { onSnapshot() {}, onEvent() {}, onDisconnect() {} };
  for (const options of [{ requestTimeoutMs: 0 }, { snapshotTimeoutMs: Infinity },
    { reconnectMinMs: 30, reconnectMaxMs: 10 }, { requestTimeoutMs: 2 ** 31 }]) {
    assert.throws(() => createFaceTimeTransport({ ...callbacks, ...options }), /Invalid/);
  }
});
