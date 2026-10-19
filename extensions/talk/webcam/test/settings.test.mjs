// Source-only tests: deliberately not executed for the persistence implementation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, lstat, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, parseSettings, validateSettings, validateEditorPreferences, MAX_SETTINGS_BYTES } from '../src/shared/settings.ts';
import { SettingsStore } from '../src/main/settings-store.ts';
import { OutputView } from '../src/main/output-view.ts';

const pose = { position: [2, 3, 4], target: [0, 1, 0], fov: 48 };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webcam-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('full scene/framing/workspace preferences round-trip, with no runtime payload', () => {
  const settings = defaultSettings();
  settings.scene = { ...settings.scene, sceneId: 'desk', characterId: 'hoodie', aspectRatio: '9:16',
    hudMode: 'off', hudOpacity: .4, hudSession: false, hudSubagents: false, hudTodos: false, hudWeekly: false,
    hudInsetTop: 1, hudInsetRight: 2, hudInsetBottom: 3, hudInsetLeft: 4,
    hudPortraitInsetTop: 5, hudPortraitInsetRight: 6, hudPortraitInsetBottom: 7, hudPortraitInsetLeft: 8,
    eyeGlowIntensity: 2.4, eyeGlowColor: '#123456', eyeSquint: .2, casingTint: '#abcdef', casingWear: .1,
    hoodieColor: '#789abc', idleIntensity: 1.1, roomIntensity: 1.8, warmCoolBalance: .3 };
  settings.outputView = { mode: 'custom', pose };
  settings.editorPose = pose;
  settings.editor = { visibleViews: 'both', inspectorSection: 'Overlay' };
  settings.windowBounds = { x: -1000, y: 20, width: 1300, height: 800 };
  settings.hudSource = 'demo'; settings.outputStopped = true;
  assert.deepEqual(parseSettings(JSON.stringify(settings)), settings);
  const unsafe = { ...settings, snapshot: { privateText: 'never save' }, demo: { todos: ['fake'] },
    callId: 'secret', auth: 'secret', deviceId: 'secret', presentation: { text: 'secret' }, revision: 42 };
  assert.deepEqual(validateSettings(unsafe), settings);
});

test('partial legacy sceneConfig migrates defaults, minimal -> dashboard, numeric ranges clamp', () => {
  const migrated = validateSettings({ version: 0, sceneConfig: { hudMode: 'minimal', eyeSquint: 20, roomIntensity: -5, hudPortraitInsetTop: 99 } });
  assert.equal(migrated.version, 1);
  assert.equal(migrated.scene.hudMode, 'dashboard');
  assert.equal(migrated.scene.eyeSquint, 1);
  assert.equal(migrated.scene.roomIntensity, 0);
  assert.equal(migrated.scene.hudPortraitInsetTop, 15);
  assert.equal(migrated.scene.sceneId, 'workshop');
  assert.equal(migrated.scene.characterId, 'robot');
  assert.deepEqual(validateSettings({}), defaultSettings());
  assert.deepEqual(validateSettings({ version: 1, editor: { future: 'ignored' } }), defaultSettings());
});

test('bounded schema rejects unsupported versions, unsafe JSON, bad known values and camera poses', () => {
  for (const input of [null, [], { version: 99 }, { version: '1' }, { scene: { eyeSquint: NaN } },
    { scene: { eyeGlowColor: 'red' } }, { hudSource: 'auto-demo' }, { outputStopped: 'yes' },
    { outputView: { mode: 'follow-editor' } }, { editorPose: { ...pose, position: [999, 0, 0] } },
    { editorPose: { ...pose, fov: 101 } }, { editor: { inspectorSection: 'Auth' } }]) {
    assert.throws(() => validateSettings(input));
  }
  assert.throws(() => parseSettings('{"__proto__":{"polluted":true}}'));
  assert.throws(() => parseSettings('{"scene":{"constructor":{}}}'));
  assert.throws(() => parseSettings(' '.repeat(MAX_SETTINGS_BYTES + 1)));
  assert.equal({}.polluted, undefined);
  assert.throws(() => validateEditorPreferences({ scene: {} }, defaultSettings().editor));
  assert.throws(() => validateEditorPreferences({}, defaultSettings().editor));
  assert.deepEqual(validateEditorPreferences({ visibleViews: 'output' }, defaultSettings().editor), { visibleViews: 'output', inspectorSection: 'Scene' });
});

test('one write queue flushes rapid changes and newer edits made during an older async write', async t => {
  const directory = await fixture(t);
  const store = new SettingsStore(directory, () => {});
  await store.load();
  for (let i = 0; i < 40; i++) store.update({ scene: { ...store.get().scene, eyeSquint: i / 100 } });
  const writing = store.flush();
  store.update({ scene: { ...store.get().scene, aspectRatio: '9:16', eyeSquint: .91 }, outputStopped: true });
  await writing;
  await store.flush();
  const disk = parseSettings(await readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.deepEqual(disk, store.get());
  assert.equal(disk.scene.eyeSquint, .91);
  assert.equal(disk.outputStopped, true);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(path.join(directory, 'settings.json'))).mode & 0o777, 0o600);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  }
  const restarted = new SettingsStore(directory, () => {});
  assert.deepEqual(await restarted.load(), disk);
  const getterCopy = restarted.get(); getterCopy.scene.eyeSquint = 0;
  assert.equal(restarted.get().scene.eyeSquint, .91);
});

test('corrupt/unsupported/oversize files are preserved read-only, including after edits/quit flush', async t => {
  const directory = await fixture(t), file = path.join(directory, 'settings.json');
  for (const original of ['{bad private content', '{"version":300}', ' '.repeat(MAX_SETTINGS_BYTES + 1)]) {
    await writeFile(file, original, { mode: 0o600 });
    const store = new SettingsStore(directory, () => {});
    assert.deepEqual(await store.load(), { ...defaultSettings(), outputStopped: true });
    assert.equal(store.status().readOnly, true);
    assert.match(store.status().warning, /repair or rename/);
    assert.ok(!store.status().warning.includes('private content'));
    store.update({ hudSource: 'demo', outputStopped: true });
    await store.flush();
    assert.equal(await readFile(file, 'utf8'), original);
  }
});

test('symlink file and directory targets are never loaded or replaced', async t => {
  if (process.platform === 'win32') return;
  const directory = await fixture(t), target = path.join(directory, 'original.json'), original = '{"version":99}';
  await writeFile(target, original);
  await symlink(target, path.join(directory, 'settings.json'));
  const store = new SettingsStore(directory, () => {});
  await store.load(); store.update({ outputStopped: true }); await store.flush();
  assert.equal(store.status().readOnly, true);
  assert.equal((await lstat(path.join(directory, 'settings.json'))).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), original);
  const alias = `${directory}-link`;
  t.after(() => rm(alias, { force: true }));
  await symlink(directory, alias);
  const other = new SettingsStore(alias, () => {});
  await other.load();
  assert.equal(other.status().readOnly, true);
});

test('external changes are preserved, fixtures do no settings I/O, getters never write', async t => {
  const directory = await fixture(t), file = path.join(directory, 'settings.json');
  const store = new SettingsStore(directory, () => {});
  await store.load(); store.get(); store.status();
  assert.deepEqual(await readdir(directory), []);
  store.update({ hudSource: 'demo' });
  await writeFile(file, 'external change', { mode: 0o600 });
  await store.flush();
  assert.equal(store.status().readOnly, true);
  assert.equal(await readFile(file, 'utf8'), 'external change');
  const disabled = new SettingsStore(path.join(directory, 'unused'), () => {}, false);
  await disabled.load(); disabled.update({ hudSource: 'demo' }); await disabled.flush();
  assert.deepEqual(await readdir(directory), ['settings.json']);
});

test('saved hero/follow/custom restore without publishing; runtime revisions are fresh', () => {
  const events = [], view = new OutputView((state, editor) => events.push({ state, editor }));
  for (const request of [{ mode: 'hero' }, { mode: 'follow-editor', pose }, { mode: 'custom', pose }]) {
    view.restore(request);
    assert.deepEqual(view.preferences(), request);
    assert.equal(view.get().revision, 0);
  }
  assert.equal(events.length, 0);
  view.set({ mode: 'follow-editor', pose });
  view.editorPose({ ...pose, fov: 55 });
  assert.equal(view.preferences().pose.fov, 55);
  assert.equal(events.at(-1).editor, false);
  view.set({ mode: 'custom', pose });
  view.editorPose({ ...pose, fov: 60 });
  assert.equal(view.preferences().pose.fov, 48);
});
