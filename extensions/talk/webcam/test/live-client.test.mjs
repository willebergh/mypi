import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { snapshot, line } from './live-test-support.mjs';
const { createLiveHudClient, liveHudSocketPath, talkLaunchSocket } = await import('../src/main/live-client.ts');
const { LIVE_HUD_MAX_BYTES } = await import('../src/shared/live-protocol.ts');
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); }
  assert.fail('Timed out waiting for HUD client');
}
async function fixture(t, accept = () => {}, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hud-')), path = join(dir, 's');
  const sockets = [], states = [], incoming = [];
  const server = createServer(socket => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('data', bytes => incoming.push(bytes));
    accept(socket, sockets.length);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  const client = createLiveHudClient({ socketPath: path, onState: s => states.push(s), heartbeatMs: 5,
    reconnectMinMs: 10, reconnectMaxMs: 20, ...options });
  t.after(async () => {
    client.close();
    sockets.forEach(s => s.destroy());
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, client, sockets, states, incoming, live: () => states.filter(s => s.snapshot) };
}

test('private Pi socket defaults and override do not depend on cwd', () => {
  assert.equal(liveHudSocketPath({}), join(homedir(), '.pi/agent/webcam/hud.sock'));
  assert.equal(liveHudSocketPath({ PI_CODING_AGENT_DIR: '/private/pi' }), '/private/pi/webcam/hud.sock');
  assert.equal(liveHudSocketPath({ PI_CODING_AGENT_DIR: '/private/pi', PI_TALK_HUD_SOCKET: '/override/s' }), '/override/s');
  assert.equal(liveHudSocketPath({ PI_CODING_AGENT_DIR: '~/custom-agent' }), join(homedir(), 'custom-agent/webcam/hud.sock'));
  assert.equal(liveHudSocketPath({ PI_TALK_HUD_SOCKET: '~/hud.sock' }), join(homedir(), 'hud.sock'));
});
test('only explicit Talk launch data can retarget an existing instance', () => {
  assert.equal(talkLaunchSocket({ source: 'talk', socketPath: '/agent with spaces/hud.sock' }), '/agent with spaces/hud.sock');
  for (const value of [null, {}, [], { source: 'manual', socketPath: '/x' },
    { source: 'talk', socketPath: '../x' }, { source: 'talk', socketPath: '/x\nsecret' }]) assert.equal(talkLaunchSocket(value), null);
});

test('receive-only: fragmented UTF-8 and multiple frames; duplicate/regressing sequences do not publish', async t => {
  const f = await fixture(t);
  f.client.start(); f.client.start();
  await until(() => f.sockets.length);
  const s = snapshot(8, { todos: [{ id: 1, text: 'hé🙂', completed: false }] });
  const bytes = Buffer.from(line(s) + line(snapshot(8)) + line(snapshot(7)) + line(snapshot(9)));
  const split = bytes.indexOf(Buffer.from('🙂')) + 2;
  f.sockets[0].write(bytes.subarray(0, split));
  await delay(15);
  assert.equal(f.live().length, 0);
  f.sockets[0].write(bytes.subarray(split));
  await until(() => f.live().length === 2);
  assert.equal(f.live()[0].snapshot.todos[0].text, 'hé🙂');
  assert.deepEqual(f.live().map(s => s.snapshot.sequence), [8, 9]);
  assert.equal(f.incoming.length, 0);
  assert.equal(f.sockets.length, 1);
});
test('disconnect clears snapshot immediately; reconnect retains watermark, accepts new session/stream, fences retired generations', async t => {
  const f = await fixture(t, (s, n) => { if (n === 1) s.write(line(snapshot(10))); });
  f.client.start(); await until(() => f.live().length === 1);
  f.sockets[0].destroy(); await until(() => f.sockets.length === 2);
  assert.equal(f.client.getState().snapshot, null);
  f.sockets[1].write(line(snapshot(9)) + line(snapshot(10)));
  await delay(20); assert.equal(f.live().length, 1);
  f.sockets[1].write(line(snapshot(11)) + line(snapshot(0, { sessionId: 'b' }))
    + line(snapshot(99)) + line(snapshot(1, { sessionId: 'b' }))
    + line(snapshot(0, { streamId: 'new' })) + line(snapshot(99, { sessionId: 'b' })));
  await until(() => f.live().length === 5);
  assert.deepEqual(f.live().map(s => s.snapshot.sequence), [10, 11, 0, 1, 0]);
  assert.equal(f.client.getState().snapshot.streamId, 'new');
  assert.equal(f.incoming.length, 0);
});
test('watchdog checks <=1s, expires at 5s; duplicate frames cannot keep an old snapshot alive', async t => {
  let clock = 100_000;
  const f = await fixture(t, s => s.write(line(snapshot(1, { timestamp: clock }))), { now: () => clock, reconnectMinMs: 100, reconnectMaxMs: 100 });
  f.client.start(); await until(() => f.live().length);
  clock += 4999; await delay(15);
  assert.equal(f.client.getState().connection, 'live');
  f.sockets[0].write(line(snapshot(1, { timestamp: clock })));
  await delay(10);
  clock++;
  await until(() => f.client.getState().connection === 'stale');
  assert.equal(f.client.getState().snapshot, null);
});
test('silent initial connection times out; fresh heartbeat renews deadline', async t => {
  let clock = 100_000;
  const f = await fixture(t, () => {}, { now: () => clock, reconnectMinMs: 100, reconnectMaxMs: 100 });
  f.client.start(); await until(() => f.sockets.length);
  clock += 5000; await until(() => f.states.some(s => s.connection === 'stale'));
  await until(() => f.sockets.length === 2);
  f.sockets[1].write(line(snapshot(1, { timestamp: clock })));
  await until(() => f.live().length === 1);
  clock += 4000;
  f.sockets[1].write(line(snapshot(2, { timestamp: clock })));
  await until(() => f.live().length === 2);
  clock += 4000; await delay(20);
  assert.equal(f.client.getState().connection, 'live');
});
for (const [name, bytes] of [
  ['malformed JSON', '{bad\n'], ['unknown fields', line({ ...snapshot(), commands: ['answer'] })],
  ['bad UTF-8', Buffer.from([0xff, 10])], ['oversize partial frame', 'x'.repeat(LIVE_HUD_MAX_BYTES + 1)],
  ['oversize complete frame', 'x'.repeat(LIVE_HUD_MAX_BYTES + 1) + '\n'],
  ['wrong version', line({ ...snapshot(), version: 2 })], ['partial EOF', '{"version":'],
]) test(`fails closed on ${name}, clears data and never leaks diagnostics`, async t => {
  const f = await fixture(t, s => { s.write(line(snapshot())); s.end(bytes); }, { reconnectMinMs: 100, reconnectMaxMs: 100 });
  f.client.start();
  await until(() => f.states.some(s => s.connection === 'error'));
  assert.equal(f.client.getState().snapshot, null);
  assert.ok(f.states.every(s => !s.detail));
  assert.equal(f.incoming.length, 0);
});
test('old timestamps fail stale and future timestamps fail error before rendering', async t => {
  let clock = 100_000;
  const f = await fixture(t, (s, n) => s.write(line(snapshot(n, { timestamp: n === 1 ? clock - 5000 : clock + 1001 }))),
    { now: () => clock, reconnectMinMs: 100, reconnectMaxMs: 100 });
  f.client.start();
  await until(() => f.states.some(s => s.connection === 'stale'));
  await until(() => f.states.some(s => s.connection === 'error'));
  assert.equal(f.live().length, 0);
});
test('close is permanent, clears snapshot and timers, suppresses remaining records and callbacks', async t => {
  let count = 0, client;
  const f = await fixture(t, s => s.write(line(snapshot(1)) + line(snapshot(2))), {
    onState(s) { if (s.snapshot) { count++; client.close(); } },
  });
  client = f.client; client.start();
  await until(() => count === 1);
  client.close(); client.start();
  await delay(50);
  assert.equal(count, 1); assert.equal(f.sockets.length, 1);
  assert.equal(client.getState().snapshot, null);
});
test('callback failure cannot break state machine or cleanup', async t => {
  let count = 0;
  const f = await fixture(t, (s, n) => s.write(line(snapshot(n))), { onState(s) { if (s.snapshot) count++; throw new Error('consumer'); } });
  f.client.start(); await until(() => count === 1);
  f.sockets[0].destroy(); await until(() => count === 2);
  f.client.close();
  assert.equal(f.client.getState().connection, 'offline');
});
test('socket, watchdog and reconnect timers do not hold Node open', async t => {
  const support = new URL('./live-test-support.mjs', import.meta.url).href;
  const module = new URL('../src/main/live-client.ts', import.meta.url).href;
  const prefix = `import ${JSON.stringify(support)}; const {createLiveHudClient} = await import(${JSON.stringify(module)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `${prefix}
    createLiveHudClient({ socketPath:'/nonexistent/hud.sock', onState() {}, reconnectMinMs:1 }).start();
  `], { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const f = await fixture(t, s => s.write(line(snapshot())));
  const connected = spawn(process.execPath, ['--input-type=module', '-e', `${prefix}
    const keepAlive=setTimeout(()=>process.exit(7),1500);
    createLiveHudClient({ socketPath:${JSON.stringify(f.path)}, onState(s) { if(s.snapshot) clearTimeout(keepAlive); } }).start();
  `], { stdio: 'ignore' });
  t.after(() => connected.kill());
  assert.equal(await new Promise(resolve => connected.once('exit', resolve)), 0);
  assert.equal(f.incoming.length, 0);
});
test('generation history is bounded and fails closed instead of evicting replay fences', async t => {
  const f = await fixture(t, () => {}, { reconnectMinMs: 100, reconnectMaxMs: 100 });
  f.client.start(); await until(() => f.sockets.length);
  f.sockets[0].write(Array.from({ length: 129 }, (_, n) => line(snapshot(0, { sessionId: `s-${n}` }))).join(''));
  await until(() => f.states.some(s => s.connection === 'error'));
  assert.equal(f.live().length, 128);
  assert.equal(f.client.getState().snapshot, null);
});
test('validates timer bounds', () => {
  for (const options of [{ heartbeatMs: 1001 }, { heartbeatMs: 0 }, { heartbeatMs: Infinity }, { reconnectMinMs: 2, reconnectMaxMs: 1 }, { reconnectMaxMs: 2 ** 31 }]) {
    assert.throws(() => createLiveHudClient({ onState() {}, ...options }), /Invalid HUD timer/);
  }
});
