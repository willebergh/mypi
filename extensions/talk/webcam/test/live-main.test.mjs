import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { live, snapshot } from './live-test-support.mjs';
const require = createRequire(import.meta.url);
const presentationProtocol = await import('../src/shared/presentation-protocol.ts');
const liveProtocol = await import('../src/shared/live-protocol.ts');
const demoController = await import('../src/main/demo-hud.ts');
// Source-only additions; this harness/test was NOT executed for the integration.
const imageSource = await readFile(new URL('../src/main/presentation-images.ts', import.meta.url), 'utf8');
const imageExports = {};
vm.runInNewContext(ts.transpileModule(imageSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, { exports: imageExports, structuredClone,
  require: name => name === 'electron' ? {} : name.includes('presentation-protocol') ? presentationProtocol
    : name.includes('presentation-assets') ? { readPresentationAsset() { assert.fail('No filesystem reads in wiring fixture'); } } : require(name),
});
const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

/** Execute only main wiring with fake Electron/native services: no Electron/app/socket is launched. */
async function harness(lock = true, options = {}) {
  const events = new Map(), handlers = new Map(), windows = [], calls = [], createdPaths = [];
  function window() {
    const sent = [], mainFrame = {};
    const webContents = { mainFrame, sent, isDestroyed: () => false,
      send(channel, value) { sent.push([channel, value]); },
      setWindowOpenHandler() {}, on() {}, getURL: () => 'fixture',
      session: { setPermissionRequestHandler() {} }, executeJavaScript: async () => {},
    };
    return { webContents, isDestroyed: () => false, on() {}, loadURL: async () => {},
      restore() { calls.push('restore'); }, show() { calls.push('show'); }, focus() { calls.push('focus'); } };
  }
  const outputWindow = window();
  let current = { mode: 'live', connection: 'offline', snapshot: null }, notify;
  const electron = {
    app: { name: 'fixture', requestSingleInstanceLock() { calls.push('lock'); return lock; },
      quit() { calls.push('quit'); }, on: (event, cb) => events.set(event, cb), whenReady: () => Promise.resolve(), getPath: () => '/tmp' },
    BrowserWindow: class { constructor() { const win = window(); windows.push(win); return win; } },
    ipcMain: { handle(channel, cb) { handlers.set(channel, cb); } }, dialog: {},
    Menu: { buildFromTemplate: v => v, setApplicationMenu() {} },
    Tray: class { setTitle() {} setToolTip() {} setContextMenu() {} on() {} }, nativeImage: { createFromDataURL() {} },
  };
  const stubs = {
    electron, './logging': {},
    '../shared/live-protocol': liveProtocol,
    './demo-hud': demoController,
    '../shared/presentation-protocol': presentationProtocol,
    './presentation-images': { createPresentationPreparer: config => imageExports.createPresentationPreparer({ ...config,
      prepare: options.prepareImage ?? (async (_socket, image) => ({ assetId: image.assetId, width: 1, height: 1,
        dataUrl: 'data:image/png;base64,AA==' })),
    }) },
    './offscreen': { OffscreenRenderer: class { window = outputWindow; status = { state: 'stopped' };
      refreshStatus() { return this.status; } async start() { calls.push('output.start'); } async stop() { calls.push('output.stop'); } } },
    './speech-audio': { SpeechAudio: class { close() { calls.push('audio.close'); } enable() { calls.push('audio.enable'); return Promise.resolve(); } } },
    './output-view': { OutputView: class {} }, './verify': { verify: async () => { calls.push('verify'); } },
    'node:fs/promises': { mkdir: async () => {}, writeFile: async () => {} },
    './camera': { cameraStatus: action => { calls.push(`camera.${action}`); } },
    './facetime-aspect': { FaceTimeAspectSync: class { status() { return {}; } close() {} } },
    './facetime-transport': {},
    './live-client': {
      liveHudSocketPath: () => '/fixture/agent/webcam/hud.sock',
      talkLaunchSocket: value => value?.source === 'talk' && value.socketPath?.startsWith('/') ? value.socketPath : null,
      createLiveHudClient({ onState, socketPath }) { notify = onState; createdPaths.push(socketPath); return {
        getState: () => current, start() { calls.push('hud.start'); }, close() { calls.push('hud.close'); },
      }; },
    },
    '../shared/scene-config': { DEFAULT_SCENE_CONFIG: { aspectRatio: '16:9' } },
  };
  vm.runInNewContext(compiled, {
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : require(name), exports: {}, __dirname: '/fixture',
    APP_VITE_DEV_SERVER_URL: 'http://fixture/', APP_VITE_NAME: 'fixture', URL,
    process: { env: options.env ?? {}, argv: options.argv ?? [], platform: 'test', exit() { assert.fail('Unexpected exit'); } }, console,
  });
  await new Promise(resolve => setImmediate(resolve));
  const invoke = (channel, win, ...args) => handlers.get(channel)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);
  return { events, handlers, windows, calls, createdPaths, outputWindow, invoke,
    publish(s) { current = s; notify(s); }, rogueWindow: window };
}
test('main IPC: identical authorized snapshots, editor-only mode, always-on virtual meter but no camera/call activation', async () => {
  const h = await harness(), editor = h.windows[0], output = h.outputWindow;
  assert.equal(h.calls[0], 'lock');
  assert.ok(h.calls.includes('hud.start'));
  assert.equal(h.invoke('live-hud:get', editor).mode, 'live');
  const state = live(snapshot()); h.publish(state);
  assert.equal(h.invoke('live-hud:get', output), state);
  assert.equal(h.invoke('live-hud:get', editor), state);
  assert.equal(editor.webContents.sent.at(-1)[1], output.webContents.sent.at(-1)[1]);
  assert.throws(() => h.invoke('live-hud:get', h.rogueWindow()), /Unauthorized/);
  assert.throws(() => h.handlers.get('live-hud:get')({ sender: editor.webContents, senderFrame: {} }), /Unauthorized/);
  assert.throws(() => h.invoke('live-hud:mode', output, 'demo'), /Unauthorized/);
  assert.throws(() => h.invoke('live-hud:mode', editor, { mode: 'demo' }), /Invalid HUD mode/);
  assert.throws(() => h.invoke('live-hud:mode', editor, 'mock'), /Invalid HUD mode/);
  assert.equal(h.invoke('live-hud:mode', editor, 'demo').mode, 'demo');
  assert.equal(h.invoke('live-hud:get', output).snapshot, null);
  assert.equal(h.invoke('live-hud:mode', editor, 'live'), state);
  h.events.get('second-instance')();
  assert.deepEqual(h.calls.slice(-3), ['restore', 'show', 'focus']);
  assert.equal(h.calls.filter(c => c === 'audio.enable').length, 1);
  assert.ok(!h.calls.some(c => c.startsWith('camera.')));
  assert.ok(!h.handlers.has('speech-audio:enable') && !h.handlers.has('speech-audio:disable'));
  h.events.get('before-quit')({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.includes('hud.close'));
});
// Source-only Demo wiring coverage; not executed for this change.
test('Demo updates are editor/main-frame only, bounded and broadcast identically; Live ignores fixtures and timers stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const h = await harness(), editor = h.windows[0], output = h.outputWindow;
  t.after(() => h.events.get('before-quit')({ preventDefault() {} }));
  const update = { version: 1, type: 'main-context', percent: 87 };
  assert.throws(() => h.invoke('live-hud:demo-update', editor, update), /Select Demo/);
  const initial = h.invoke('live-hud:mode', editor, 'demo');
  assert.equal(initial.demo.version, 1);
  assert.throws(() => h.invoke('live-hud:demo-update', output, update), /Unauthorized/);
  assert.throws(() => h.invoke('live-hud:demo-update', h.rogueWindow(), update), /Unauthorized/);
  assert.throws(() => h.handlers.get('live-hud:demo-update')({ sender: editor.webContents, senderFrame: {} }, update), /Unauthorized/);
  assert.throws(() => h.invoke('live-hud:demo-update', editor, update, {}), /one action/);
  assert.throws(() => h.invoke('live-hud:demo-update', editor, { ...update, percent: Infinity }), /Invalid Demo/);
  assert.throws(() => h.invoke('live-hud:demo-update', editor, { ...update, snapshot: {} }), /Invalid Demo/);
  const changed = h.invoke('live-hud:demo-update', editor, update);
  assert.equal(changed.demo.mainContextPercent, 87);
  assert.deepEqual(changed, h.invoke('live-hud:get', output));
  const sent = win => win.webContents.sent.filter(([channel]) => channel === 'live-hud:state').at(-1)[1];
  assert.equal(sent(editor), sent(output));
  assert.equal(sent(output).demo.mainContextPercent, 87);
  h.invoke('live-hud:demo-update', editor, { version: 1, type: 'agent-status', id: 1, status: 'completed' });
  assert.equal(sent(output).demo.agents[0].status, 'completed');
  assert.equal(sent(output).demo.agents[0].endedAt, 10000);
  t.mock.timers.tick(3000);
  assert.ok(!sent(output).demo.agents.some(a => a.id === 1));
  assert.equal(sent(editor), sent(output));
  h.invoke('live-hud:demo-update', editor, { version: 1, type: 'agent-status', id: 2, status: 'completed' });
  const liveState = live(snapshot()); h.publish(liveState);
  assert.equal(sent(output).mode, 'demo', 'live publisher cannot override explicit Demo');
  assert.equal(h.invoke('live-hud:mode', editor, 'live'), liveState);
  assert.equal(h.invoke('live-hud:get', output).demo, undefined);
  const sentCount = output.webContents.sent.length;
  t.mock.timers.tick(4000);
  assert.equal(output.webContents.sent.length, sentCount, 'no Demo timer publishes into Live');
  assert.throws(() => h.invoke('live-hud:demo-update', editor, update), /Select Demo/);
  assert.equal(h.calls.filter(c => c === 'audio.enable').length, 1, 'Demo never enables audio');
  assert.ok(!h.calls.some(c => c.startsWith('camera.')));
});

test('presentation IPC is sender/frame allowlisted, selector-free and separate from metadata snapshots', async () => {
  const h = await harness(), editor = h.windows[0], output = h.outputWindow;
  const metadata = { version: 1, scopeId: 'scope', runId: 'run', id: 'revision', text: 'Public slide' };
  h.publish(live(snapshot(1, { talk: { phase: 'connected', mode: 'facetime', runId: 'run', voiceReady: true, audioEnabled: true },
    presentation: metadata })));
  assert.equal(h.invoke('presentation:get', editor).presentation.text, 'Public slide');
  assert.equal(h.invoke('presentation:get', output).presentation.id, 'revision');
  assert.throws(() => h.invoke('presentation:get', h.rogueWindow()), /Unauthorized/);
  assert.throws(() => h.handlers.get('presentation:get')({ sender: editor.webContents, senderFrame: {} }), /Unauthorized/);
  assert.throws(() => h.invoke('presentation:get', editor, '/private/source.png'), /no arguments/);
  assert.ok(editor.webContents.sent.some(([channel]) => channel === 'presentation:state'));
  h.publish({ mode: 'live', connection: 'stale', snapshot: null });
  assert.equal(h.invoke('presentation:get', editor), null);
});

test('pending image cannot revive after retarget/demo/disconnect; new revisions clear old pixels immediately', async () => {
  const jobs = [];
  const h = await harness(true, { prepareImage: (socket, image) => new Promise(resolve => jobs.push({ socket, image, resolve })) });
  const editor = h.windows[0];
  const state = id => live(snapshot(1, { talk: { phase: 'connected', mode: 'facetime', runId: 'run', voiceReady: true, audioEnabled: true },
    presentation: { version: 1, scopeId: 'scope', runId: 'run', id, text: id,
      image: { assetId: id === 'one' ? 'a'.repeat(32) : 'b'.repeat(32), mime: 'image/png', bytes: 100, width: 1, height: 1 } } }));
  const finish = job => job.resolve({ assetId: job.image.assetId, width: 1, height: 1, dataUrl: 'data:image/png;base64,AA==' });
  h.publish(state('one'));
  assert.equal(h.invoke('presentation:get', editor).image, undefined);
  h.publish(state('two'));
  assert.equal(jobs.length, 1, 'one in-flight preparation plus latest pending metadata');
  finish(jobs[0]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.length, 2);
  assert.equal(h.invoke('presentation:get', editor).presentation.id, 'two');
  assert.equal(h.invoke('presentation:get', editor).image, undefined, 'old image never accompanies new text');
  h.events.get('second-instance')({}, [], '', { source: 'talk', socketPath: '/other/webcam/hud.sock' });
  finish(jobs[1]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.invoke('presentation:get', editor), null, 'retained old revision and late promise both fenced');
  h.publish(state('three'));
  h.invoke('live-hud:mode', editor, 'demo');
  finish(jobs[2]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.invoke('presentation:get', editor), null);
  h.invoke('live-hud:mode', editor, 'live');
  assert.equal(h.invoke('presentation:get', editor), null, 'return to live does not replay a cleared revision');
  h.publish(state('four'));
  h.publish({ mode: 'live', connection: 'offline', snapshot: null });
  finish(jobs[3]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.invoke('presentation:get', editor), null);
});

test('v2 standalone display survives inactive Talk/standby, fences scope/disconnect and keeps v1 strict', async () => {
  const h = await harness(), editor = h.windows[0];
  const panel = (id, talk = { phase: 'idle', mode: 'inactive', voiceReady: false, audioEnabled: false }) =>
    live(snapshot(1, { displayScopeId: 'display', talk,
      presentation: { version: 2, scopeId: 'display', id, text: 'Standalone' } }));
  h.publish(panel('one'));
  assert.equal(h.invoke('presentation:get', editor).presentation.version, 2);
  h.publish(panel('one', { phase: 'standby', mode: 'facetime', voiceReady: false, audioEnabled: false }));
  assert.equal(h.invoke('presentation:get', editor).presentation.id, 'one');
  h.publish(panel('one')); // Ordinary Talk idle must not reset/block this revision.
  assert.equal(h.invoke('presentation:get', editor).presentation.id, 'one');
  const wrong = panel('two'); wrong.snapshot.displayScopeId = 'other'; h.publish(wrong);
  assert.equal(h.invoke('presentation:get', editor), null);
  h.publish(panel('three'));
  h.publish({ mode: 'live', connection: 'offline', snapshot: null });
  h.publish(panel('three'));
  assert.equal(h.invoke('presentation:get', editor), null, 'retained revision cannot return after disconnect');
  h.publish(panel('four'));
  assert.equal(h.invoke('presentation:get', editor).presentation.id, 'four');
  const legacy = panel('legacy'); legacy.snapshot.presentation = { version: 1, scopeId: 'call', runId: 'run', id: 'legacy', text: 'Call only' };
  h.publish(legacy); assert.equal(h.invoke('presentation:get', editor), null);
});

test('v2 slow image preparation survives call ending, but not display scope change', async () => {
  const jobs = [];
  const h = await harness(true, { prepareImage: (socket, image) => new Promise(resolve => jobs.push({ socket, image, resolve })) });
  const editor = h.windows[0];
  const s = live(snapshot(1, { displayScopeId: 'display',
    talk: { phase: 'connected', mode: 'facetime', runId: 'run', voiceReady: true, audioEnabled: true },
    presentation: { version: 2, scopeId: 'display', id: 'image', text: 'Standalone image',
      image: { assetId: 'a'.repeat(32), mime: 'image/png', bytes: 100, width: 1, height: 1 } } }));
  h.publish(s);
  const ended = structuredClone(s); ended.snapshot.talk = { phase: 'standby', mode: 'facetime', voiceReady: false, audioEnabled: false };
  h.publish(ended);
  jobs[0].resolve({ assetId: jobs[0].image.assetId, width: 1, height: 1, dataUrl: 'data:image/png;base64,AA==' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.invoke('presentation:get', editor).image);
  const next = structuredClone(ended); next.snapshot.presentation.id = 'next'; h.publish(next);
  const changed = structuredClone(next); changed.snapshot.displayScopeId = 'new-display'; delete changed.snapshot.presentation; h.publish(changed);
  jobs[1].resolve({ assetId: jobs[1].image.assetId, width: 1, height: 1, dataUrl: 'data:image/png;base64,AA==' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.invoke('presentation:get', editor), null);
});

test('Talk launch retargets the existing instance to the exact socket without stealing focus', async () => {
  const h = await harness();
  h.invoke('live-hud:mode', h.windows[0], 'demo');
  const before = h.calls.length;
  h.events.get('second-instance')({}, [], '/ignored', { source: 'talk', socketPath: '/other agent/webcam/hud.sock' });
  assert.deepEqual(h.createdPaths, ['/fixture/agent/webcam/hud.sock', '/other agent/webcam/hud.sock']);
  assert.deepEqual(h.calls.slice(before), ['hud.close', 'hud.start']);
  assert.equal(h.invoke('live-hud:get', h.windows[0]).mode, 'live');
  const count = h.createdPaths.length;
  h.events.get('second-instance')({}, [], '/ignored', { source: 'talk', socketPath: '/other agent/webcam/hud.sock' });
  assert.equal(h.createdPaths.length, count, 'same endpoint does not reconnect or reset sequence fences');
});
for (const [name, options] of [
  ['verification', { argv: ['--verify'] }],
  ['synthetic fixture', { env: { PI_TALK_SYNTHETIC_FIXTURE: '1' } }],
]) test(`${name} starts neither real audio capture nor the live Pi socket`, async () => {
  const h = await harness(true, options);
  assert.ok(!h.calls.includes('audio.enable'));
  assert.ok(!h.calls.includes('hud.start'));
  assert.ok(!h.calls.includes('lock'), 'fixtures do not hand off to a live app and falsely report success');
  h.events.get('second-instance')({}, [], '', { source: 'talk', socketPath: '/other/hud.sock' });
  assert.ok(!h.calls.includes('hud.start'));
});

test('duplicate launch quits before creating editor or starting HUD/output', async () => {
  const h = await harness(false);
  assert.deepEqual(h.calls, ['lock', 'quit']);
  assert.equal(h.windows.length, 0);
  assert.equal(h.handlers.size, 0);
});
