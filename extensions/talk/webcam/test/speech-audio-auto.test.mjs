import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// SOURCE ONLY for the capture-recovery change: not executed, compiled, or built.
// When separately authorized, compile only the controller with an Electron stub;
// no app, addon, device, capture, or real permission API is used by this harness.
const directory = await mkdtemp(path.join(tmpdir(), 'webcam-audio-test-'));
after(() => rm(directory, { recursive: true, force: true }));
await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: ['electron'] },
  plugins: [{ name: 'inert-electron', enforce: 'pre',
    resolveId(id) { if (id === 'electron') return '\0inert-electron'; },
    load(id) { if (id === '\0inert-electron') return `
      export const app = { isPackaged: false, getAppPath() { throw Error('Real addon path forbidden'); } };
      export const systemPreferences = { getMediaAccessStatus() { throw Error('Real permission API forbidden'); }, askForMediaAccess() { throw Error('Real permission API forbidden'); } };
    `; },
  }],
  build: { ssr: fileURLToPath(new URL('../src/main/speech-audio.ts', import.meta.url)),
    outDir: directory, emptyOutDir: false, minify: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'speech.cjs' } } },
});
const { SpeechAudio } = createRequire(import.meta.url)(path.join(directory, 'speech.cjs'));
const UID = 'io.github.willebergh.pitalk.audio.visible';
const STALL = 'PiTalk input callbacks stalled (>250 ms)';
const delays = [2_000, 5_000, 15_000, 30_000, 60_000];
const settle = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
function fixture(t, overrides = {}) {
  let starts = 0, stops = 0, requests = 0, running = false, fault, present = true, clock = 0;
  const calls = [], events = [];
  const meter = {
    getStatus: () => ({ devicePresent: present, running, error: fault, deviceUid: UID }),
    start: () => {
      assert.equal(running, false, 'never create parallel streams');
      assert.equal(present, true);
      starts++; calls.push('start'); running = true; fault = undefined;
      return { devicePresent: true, running: true, deviceUid: UID };
    },
    stop: () => { stops++; calls.push('stop'); running = false; fault = undefined; },
    readLevels: () => ({ rms: 0, peak: 0, bands: Array(12).fill(0), sampleRate: 48000 }),
  };
  const audio = new SpeechAudio(state => events.push(state), {
    platform: 'darwin', loadMeter: () => meter, permission: () => 'granted', now: () => clock,
    requestPermission: async () => { requests++; return true; }, ...overrides,
  });
  t.after(() => audio.close());
  return { audio, events, meter, calls,
    fail(error = STALL) { fault = error; running = false; },
    set present(value) { present = value; },
    async tick(ms) { clock += ms; t.mock.timers.tick(ms); await settle(); },
    get starts() { return starts; }, get stops() { return stops; }, get requests() { return requests; } };
}
function fakeTimers(t) { t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); }
function zero(state) {
  assert.equal(state.rms, 0); assert.equal(state.peak, 0);
  assert.deepEqual(state.bands, Array(12).fill(0));
}
test('metadata is inert; repeated startup starts one stream; close never restarts', async t => {
  const h = fixture(t);
  h.audio.getStatus();
  assert.equal(h.starts, 0);
  assert.equal((await h.audio.enable()).state, 'active');
  await h.audio.enable();
  assert.equal(h.starts, 1);
  assert.equal(h.requests, 0);
  h.audio.close();
  await h.audio.enable();
  assert.equal(h.starts, 1);
  zero(h.events.at(-1));
});
test('silent healthy callbacks remain active without fabricated levels or retries', async t => {
  fakeTimers(t);
  const h = fixture(t);
  await h.audio.enable();
  await h.tick(10_000);
  assert.equal(h.events.at(-1).state, 'active'); zero(h.events.at(-1));
  assert.equal(h.starts, 1);
});
test('stall detected during readLevels immediately zeros and stops before bounded recovery', async t => {
  fakeTimers(t);
  const h = fixture(t);
  h.meter.readLevels = () => ({ rms: 1, peak: 1, bands: Array(12).fill(1), sampleRate: 48000 });
  await h.audio.enable();
  await h.tick(50);
  assert.equal(h.events.at(-1).rms, 1);
  // Current addon stops silently in readLevels, not necessarily by throwing.
  h.meter.readLevels = () => { h.fail(); return { rms: 1, peak: 1, bands: Array(12).fill(1), sampleRate: 48000 }; };
  await h.tick(50);
  assert.equal(h.events.at(-1).state, 'retrying');
  assert.match(h.events.at(-1).error, /250 ms.*Retrying in 2s/); zero(h.events.at(-1));
  assert.deepEqual(h.calls, ['start', 'stop']);
  await h.audio.enable(); // Repeated enable must not bypass backoff.
  await h.tick(1_999); assert.equal(h.starts, 1);
  h.meter.readLevels = () => ({ rms: 0, peak: 0, bands: Array(12).fill(0), sampleRate: 48000 });
  await h.tick(1);
  assert.deepEqual(h.calls, ['start', 'stop', 'start']);
  assert.equal(h.events.at(-1).state, 'active');
  assert.equal(h.events.at(-1).error, null);
  assert.equal(h.requests, 0);
});
test('metadata-discovered stall also clears old levels and schedules recovery', async t => {
  fakeTimers(t);
  const h = fixture(t);
  await h.audio.enable(); h.fail();
  const state = h.audio.getStatus();
  assert.equal(state.state, 'retrying'); zero(state);
  await h.tick(2_000); assert.equal(h.starts, 2);
});
test('missing exact device retries metadata only, then recovers without prompting or fallback', async t => {
  fakeTimers(t);
  const h = fixture(t); h.present = false;
  const result = await h.audio.enable();
  assert.equal(result.state, 'retrying');
  assert.match(result.error, /No microphone fallback/);
  await h.tick(2_000);
  assert.equal(h.starts, 0);
  assert.match(h.events.at(-1).error, /Retrying in 5s/);
  h.present = true;
  await h.tick(5_000);
  assert.equal(h.starts, 1);
  assert.equal(h.requests, 0);
});
test('five attempts cap rapid stall/start cycles; metadata/enable cannot reset the budget', async t => {
  fakeTimers(t);
  const h = fixture(t);
  await h.audio.enable();
  for (const delay of delays) {
    h.fail(); await h.tick(50);
    assert.equal(h.events.at(-1).state, 'retrying'); zero(h.events.at(-1));
    await h.tick(delay - 1);
    const before = h.starts;
    await h.tick(1); assert.equal(h.starts, before + 1);
  }
  h.fail(); await h.tick(50);
  assert.equal(h.events.at(-1).state, 'unavailable');
  assert.match(h.events.at(-1).error, /exhausted \(5 retries\)/);
  await h.audio.enable(); h.audio.getStatus(); await h.tick(600_000);
  assert.equal(h.starts, 6); assert.equal(h.requests, 0); zero(h.events.at(-1));
});
test('retry budget resets only after 30 seconds of continuously healthy polling', async t => {
  fakeTimers(t);
  const h = fixture(t);
  await h.audio.enable(); h.fail(); await h.tick(50); await h.tick(2_000);
  h.fail(); await h.tick(50);
  assert.match(h.events.at(-1).error, /Retrying in 5s/);
  await h.tick(5_000); await h.tick(30_000);
  h.fail(); await h.tick(50);
  assert.match(h.events.at(-1).error, /Retrying in 2s \(1\/5\)/);
});
for (const fault of ['No PiTalk input callback within 750 ms', 'PiTalk visible input device is absent'])
  test(`allowlisted native startup transient recovers: ${fault}`, async t => {
    fakeTimers(t);
    const h = fixture(t), start = h.meter.start;
    h.meter.start = () => { throw Object.assign(new Error(fault), { code: 'PITALK_AUDIO_START' }); };
    assert.equal((await h.audio.enable()).state, 'retrying');
    h.meter.start = start; await h.tick(2_000);
    assert.equal(h.starts, 1); assert.equal(h.requests, 0);
  });
for (const fault of ['PiTalk device format or AUHAL selection changed', 'Invalid Float32 PCM returned by AUHAL',
  'Audio callback exceeded preallocated maximum frames', 'AudioUnitRender failed (OSStatus -50)',
  'PiTalk input must already run at 48000 Hz; no device rate is changed', 'Device UID lookup failed (OSStatus -50)', 'unclassified failure'])
  test(`nonrecoverable/unknown native fault stays unavailable: ${fault}`, async t => {
    fakeTimers(t);
    const h = fixture(t);
    h.meter.start = () => { throw Object.assign(new Error(fault), { code: 'PITALK_AUDIO_START' }); };
    const result = await h.audio.enable();
    assert.equal(result.state, 'unavailable'); assert.equal(result.error, fault); zero(result);
    const stops = h.stops; await h.tick(600_000);
    assert.equal(h.stops, stops); assert.equal(h.requests, 0);
  });
for (const permission of ['denied', 'restricted', 'unknown'])
  test(`${permission} permission never prompts or retries`, async t => {
    fakeTimers(t);
    const h = fixture(t, { permission: () => permission });
    assert.equal((await h.audio.enable()).state, 'unavailable');
    await h.tick(600_000);
    assert.equal(h.starts, 0); assert.equal(h.requests, 0);
  });
test('missing device with undetermined permission does not prompt or retry', async t => {
  fakeTimers(t);
  const h = fixture(t, { permission: () => 'not-determined' }); h.present = false;
  assert.equal((await h.audio.enable()).state, 'unavailable');
  await h.tick(600_000); assert.equal(h.starts, 0); assert.equal(h.requests, 0);
});
test('initial declined permission prompts once, stays unavailable, and never retries', async t => {
  fakeTimers(t);
  let requests = 0, permission = 'not-determined';
  const h = fixture(t, { permission: () => permission, requestPermission: async () => {
    requests++; permission = 'denied'; return false;
  } });
  assert.equal((await h.audio.enable()).state, 'unavailable');
  await h.audio.enable(); await h.tick(600_000);
  assert.equal(requests, 1); assert.equal(h.starts, 0); zero(h.events.at(-1));
});
test('active disconnection recovers only when the same fixed device returns', async t => {
  fakeTimers(t);
  const h = fixture(t);
  await h.audio.enable(); h.present = false; h.fail('PiTalk visible input disconnected');
  await h.tick(50); assert.equal(h.events.at(-1).state, 'retrying'); zero(h.events.at(-1));
  await h.tick(2_000); assert.equal(h.starts, 1);
  h.present = true; await h.tick(5_000); assert.equal(h.starts, 2);
});
test('active format change is visible and never automatically reopened', async t => {
  fakeTimers(t);
  const h = fixture(t);
  await h.audio.enable(); h.fail('PiTalk device format or AUHAL selection changed');
  await h.tick(50); assert.equal(h.events.at(-1).state, 'unavailable');
  assert.match(h.events.at(-1).error, /format or AUHAL selection changed/); zero(h.events.at(-1));
  await h.tick(600_000); assert.equal(h.starts, 1);
});
test('permission revoked during backoff cancels recovery without requesting access', async t => {
  fakeTimers(t);
  let permission = 'granted';
  const h = fixture(t, { permission: () => permission });
  await h.audio.enable(); h.fail(); await h.tick(50);
  permission = 'not-determined'; await h.tick(2_000); await h.tick(600_000);
  assert.equal(h.starts, 1); assert.equal(h.requests, 0);
  assert.equal(h.events.at(-1).state, 'unavailable'); zero(h.events.at(-1));
});
test('pending permission + disable/enable cannot create overlapping requests or late streams', async t => {
  let approve, requests = 0;
  const h = fixture(t, { permission: () => 'not-determined', requestPermission: () => {
    requests++; return new Promise(resolve => { approve = resolve; });
  } });
  const pending = h.audio.enable(); await settle();
  h.audio.disable(); const second = h.audio.enable();
  assert.equal(second, pending); assert.equal(requests, 1);
  approve(true); await pending;
  assert.equal(h.starts, 0); zero(h.events.at(-1));
  await h.audio.enable();
  assert.equal(requests, 1, 'a controller never prompts twice'); assert.equal(h.starts, 0);
});
test('late permission approval after close cannot start capture', async t => {
  let approve;
  const h = fixture(t, { permission: () => 'not-determined', requestPermission: () => new Promise(resolve => { approve = resolve; }) });
  const pending = h.audio.enable(); await settle();
  h.audio.close(); approve(true); await pending;
  assert.equal(h.starts, 0); zero(h.events.at(-1));
});
test('close before queued startup, during backoff, and stale-generation polls stay inert', async t => {
  fakeTimers(t);
  const queued = fixture(t);
  const pending = queued.audio.enable(); queued.audio.close(); await pending;
  assert.equal(queued.starts, 0);
  const h = fixture(t);
  await h.audio.enable(); h.fail(); await h.tick(50); await h.tick(2_000);
  const reads = h.events.length;
  h.audio.sample(1); // TS private, intentionally exercised as an old queued poll.
  assert.equal(h.events.length, reads);
  h.fail(); await h.tick(50); h.audio.close();
  await h.tick(600_000); await h.audio.enable();
  assert.equal(h.starts, 2); zero(h.events.at(-1));
});
test('teardown failure zeros levels but forbids creating another AudioUnit', async t => {
  fakeTimers(t);
  const h = fixture(t);
  await h.audio.enable();
  h.meter.stop = () => { throw Error('dispose failed'); };
  h.fail(); await h.tick(50);
  assert.equal(h.events.at(-1).state, 'unavailable');
  assert.match(h.events.at(-1).error, /teardown failed/); zero(h.events.at(-1));
  await h.tick(600_000); assert.equal(h.starts, 1);
});
test('verification/fixture capture guard blocks explicit enable and all future retries', async t => {
  fakeTimers(t);
  const h = fixture(t, { captureAllowed: false, loadMeter: () => assert.fail('guard must not load/start on enable') });
  await h.audio.enable(); await h.tick(600_000);
  assert.equal(h.starts, 0); assert.equal(h.requests, 0); assert.equal(h.events.length, 0);
});
