import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as THREE from 'three';
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { DEFAULT_SCENE_CONFIG: defaults, validateSceneConfig, SCENE_OPTIONS, CHARACTER_OPTIONS } = await import('../src/shared/scene-config.ts');
const { createWorld } = await import('../src/avatar/world.ts');
const presentationProtocol = await import('../src/shared/presentation-protocol.ts');
hooks.deregister();

test('coded scene IDs roundtrip; missing legacy ID migrates without resetting appearance', () => {
  assert.deepEqual(SCENE_OPTIONS.map(s => [s.id, s.name]), [['workshop', 'Workshop'], ['desk', 'Desk setup']]);
  for (const sceneId of ['workshop', 'desk']) {
    const config = { ...defaults, sceneId, hudMode: 'off', roomIntensity: .4 };
    assert.deepEqual(validateSceneConfig(JSON.parse(JSON.stringify(config))), config);
  }
  const { sceneId, ...legacy } = { ...defaults, hoodieColor: '#123456', aspectRatio: '9:16' };
  assert.deepEqual(validateSceneConfig(legacy), { ...legacy, sceneId: 'workshop' });
  for (const sceneId of [null, '', 'Desk', 'unknown', 1, {}, []]) {
    assert.throws(() => validateSceneConfig({ ...defaults, sceneId }), /Invalid scene id/);
  }
  assert.throws(() => validateSceneConfig({ ...defaults, sceneId: 'desk', geometry: {} }), /Unknown scene setting/);
});

test('character IDs roundtrip independently of scene; legacy configs retain robot and controls', () => {
  assert.equal(defaults.characterId, 'robot');
  assert.deepEqual(CHARACTER_OPTIONS.map(c => [c.id, c.name]), [['robot', 'Robot'], ['hoodie', 'Hoodie & face']]);
  for (const sceneId of ['workshop', 'desk']) for (const characterId of ['robot', 'hoodie']) {
    const config = { ...defaults, sceneId, characterId, hoodieColor: '#123456', idleIntensity: 0, aspectRatio: '9:16' };
    assert.deepEqual(validateSceneConfig(JSON.parse(JSON.stringify(config))), config);
    const { characterId: _, ...legacy } = config;
    assert.deepEqual(validateSceneConfig(legacy), { ...legacy, characterId: 'robot' });
    const { sceneId: __, ...oldest } = legacy;
    assert.deepEqual(validateSceneConfig(oldest), { ...oldest, sceneId: 'workshop', characterId: 'robot' });
  }
  for (const characterId of [null, '', 'Hoodie', 'unknown', 1, {}, []]) {
    assert.throws(() => validateSceneConfig({ ...defaults, characterId }), /Invalid character id/);
  }
});

function canvasFixture(t) {
  const previous = globalThis.document;
  const gradient = { addColorStop() {} };
  const context = new Proxy({
    createRadialGradient: () => gradient, createLinearGradient: () => gradient,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    measureText: value => ({ width: String(value).length * 5 }),
  }, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => {} });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}

function watchAssets(group) {
  const assets = new Set();
  group.traverse(node => {
    if (node.geometry) assets.add(node.geometry);
    for (const material of [node.material].flat().filter(Boolean)) {
      assets.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) assets.add(value);
    }
  });
  const counts = new Map([...assets].map(asset => [asset, 0]));
  for (const asset of assets) asset.addEventListener('dispose', () => counts.set(asset, counts.get(asset) + 1));
  return counts;
}

test('room switching disposes outgoing assets once and preserves robot and camera', t => {
  canvasFixture(t);
  const world = createWorld(defaults);
  t.after(() => world.dispose());
  const camera = world.camera;
  const robot = world.scene.children.find(node => node.name === 'hooded CRT / hero');
  assert.ok(robot);
  const robotAssets = watchAssets(robot);
  const initialRoom = world.scene.children.find(node => node !== robot);
  const roomAssets = watchAssets(initialRoom);
  assert.ok(roomAssets.size > 0);
  world.update({ ...defaults, eyeSquint: .2 }, 1, .016);
  assert.equal(initialRoom.parent, world.scene, 'appearance changes do not rebuild the environment');
  for (const sceneId of ['desk', 'workshop', 'desk']) {
    world.update({ ...defaults, sceneId }, 2, .016);
    assert.equal(world.camera, camera);
    assert.equal(robot.parent, world.scene);
    assert.equal(world.scene.children.length, 2, 'no stale room/light groups');
    const lights = [];
    world.scene.traverse(node => { if (node.isLight) lights.push(node); });
    assert.equal(lights.length, 4, 'three screen pools and camera-side robot fill');
    assert.deepEqual(world.camera.position.toArray(), sceneId === 'desk' ? [1.85, 4.2, 14.3] : [.15, 3.1, 7.85]);
    if (sceneId === 'desk') {
      const room = world.scene.children.find(node => node !== robot);
      assert.equal(room.name, 'Oak / desk setup');
      for (const name of ['large left landscape monitor', 'right lower landscape monitor', 'right upper landscape monitor']) {
        const screen = room.getObjectByName(`${name} screen`);
        assert.ok(screen.geometry.parameters.width > screen.geometry.parameters.height);
      }
      const upper = room.getObjectByName('right upper landscape monitor');
      const lower = room.getObjectByName('right lower landscape monitor');
      assert.equal(upper.position.x, lower.position.x);
      assert.ok(upper.position.y > lower.position.y);
      assert.ok(room.getObjectByName('silver Mac mini').position.x < room.getObjectByName('open silver laptop').position.x);
      assert.ok(room.getObjectByName('camera-side robot spotlight').target.parent === room);
      const assets = watchAssets(room);
      world.update({ ...defaults, sceneId, roomIntensity: 0 }, 4, .016);
      assert.equal(room.getObjectByName('laptop screen').material.color.r, 0);
      world.setScene('workshop');
      assert.ok([...assets.values()].every(count => count === 1), 'desk GPU assets disposed once');
    }
  }
  assert.equal(initialRoom.parent, null);
  assert.ok([...roomAssets.values()].every(count => count === 1));
  assert.ok([...robotAssets.values()].every(count => count === 0));
  world.dispose(); world.dispose();
  assert.ok([...robotAssets.values()].every(count => count === 1));
  assert.equal(world.scene.children.length, 0);
});

test('character switches release only character assets, in either room, with no rebuild on control edits', t => {
  canvasFixture(t);
  const world = createWorld(defaults);
  t.after(() => world.dispose());
  const watched = [];
  for (const sceneId of ['workshop', 'desk']) {
    world.update({ ...defaults, sceneId }, 1, .016);
    const room = world.scene.children.find(node => node.name !== 'hooded CRT / hero');
    const roomAssets = watchAssets(room);
    const pose = world.camera.position.toArray();
    for (const characterId of ['hoodie', 'robot', 'hoodie', 'robot']) {
      const outgoing = world.scene.children.find(node => node !== room);
      const assets = watchAssets(outgoing); watched.push(assets);
      const config = { ...defaults, sceneId, characterId, idleIntensity: 0, eyeSquint: .2 };
      world.setCharacter(config);
      assert.equal(outgoing.parent, null);
      assert.ok([...assets.values()].every(count => count === 1));
      assert.equal(room.parent, world.scene);
      assert.ok([...roomAssets.values()].every(count => count === 0));
      assert.deepEqual(world.camera.position.toArray(), pose);
      assert.equal(world.scene.children.length, 2);
      const installed = world.scene.children.find(node => node !== room);
      assert.equal(installed.name, characterId === 'hoodie' ? 'hoodie character / standalone' : 'hooded CRT / hero');
      assert.deepEqual(installed.position.toArray(), [-.62, 0, .62]);
      world.update(config, 4, .016);
      world.update({ ...config, hoodieColor: '#123456' }, 5, .016);
      assert.equal(installed.parent, world.scene, 'control edits keep character and animation instance');
    }
  }
  const finalAssets = watchAssets(world.scene);
  world.dispose(); world.dispose();
  assert.ok([...finalAssets.values()].every(count => count === 1));
  for (const assets of watched) assert.ok([...assets.values()].every(count => count === 1));
});

// Exercise the actual shared preview/output wrapper with no GPU, app, socket or audio capture.
const source = await readFile(new URL('../src/avatar/scene.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
for (const mode of ['editor', 'output']) test(`${mode}: scene switch precedes render/revision acknowledgement and preserves camera overrides`, () => {
  const calls = [], applied = [];
  let frame;
  const world = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(37.5), target: new THREE.Vector3(0, 2, 0),
    setScene(id) { calls.push(id); this.camera.position.set(1, 3, 8); this.camera.fov = 40; },
    setCharacter(config) { calls.push(config.characterId); },
    update() { calls.push('update'); }, dispose() { calls.push('dispose'); },
  };
  world.camera.position.set(0, 3, 8);
  class Renderer {
    domElement = { className: '', setAttribute() {}, addEventListener() {}, removeEventListener() {}, remove() {} };
    info = { reset() {}, render: { calls: 1, triangles: 1 } };
    setPixelRatio() {} setSize() {} render() { calls.push('render'); }
    dispose() {} forceContextLoss() {}
  }
  class Controls {
    constructor(camera) { this.target = new THREE.Vector3(); }
    update() {} saveState() {} addEventListener() {} removeEventListener() {} reset() {} dispose() {}
  }
  const stubs = {
    three: { ...THREE, WebGLRenderer: Renderer },
    '../shared/live-projection': { OFFLINE_LIVE_HUD: {}, projectLiveHud: () => ({}) },
    'three/examples/jsm/controls/OrbitControls.js': { OrbitControls: Controls },
    './world': { createWorld: () => world },
    './hud': { createHud: () => ({ scene: { visible: false }, bottomClearance: () => 120,
      renderLayers: () => [], update() {}, resize() {}, dispose() {} }) },
    './captions': { createClosedCaptions: () => ({ scene: { visible: false }, update() {}, resize() {}, dispose() {} }) },
    './presentation': { createCallPresentationOverlay: () => ({ scene: { visible: false }, update() {}, animate() {}, resize() {}, dispose() {},
      read: () => ({ active: false, rect: null, captionSafeBottom: 120 }) }) },
    './presentation-visibility': { withPresentationHudMask: (_rect, _layers, render) => render() },
    '../shared/presentation-protocol': presentationProtocol,
    '../shared/presentation-feed': { createPresentationFeed: () => ({ read: () => null, subscribe: () => () => {}, dispose() {} }) },
    '../shared/scene-config': { DEFAULT_SCENE_CONFIG: defaults, outputSize: aspect => aspect === '9:16' ? { width: 720, height: 1280 } : { width: 1280, height: 720 } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(name in stubs, name); return stubs[name];
  }, performance: { now: () => 0 }, requestAnimationFrame: cb => { frame = cb; return 1; }, cancelAnimationFrame() {}, console });
  const scene = exports.createScene({ appendChild() {} }, { mode, onConfigApplied: revision => applied.push(revision) });
  scene.setConfig({ ...defaults, sceneId: 'desk', aspectRatio: '9:16' }, 7);
  assert.deepEqual(calls, ['desk']);
  assert.equal(applied.length, 0);
  frame(100);
  assert.deepEqual(calls, ['desk', 'update', 'render']);
  assert.deepEqual(applied, [7]);
  assert.equal(world.camera.fov, 45);
  const pose = { position: [2, 4, 9], target: [0, 2, 0], fov: 42 };
  scene.setCameraPose(pose);
  scene.setConfig({ ...defaults, sceneId: 'workshop' }, 8);
  assert.equal(JSON.stringify(scene.getCameraPose()), JSON.stringify(pose));
  frame(200);
  assert.deepEqual(applied, [7, 8]);
  scene.setConfig({ ...defaults, characterId: 'hoodie' }, 9);
  assert.equal(calls.at(-1), 'hoodie');
  assert.equal(JSON.stringify(scene.getCameraPose()), JSON.stringify(pose));
  assert.deepEqual(applied, [7, 8], 'character revision waits for render');
  frame(300);
  assert.deepEqual(calls.slice(-3), ['hoodie', 'update', 'render']);
  assert.deepEqual(applied, [7, 8, 9]);
  scene.setCameraPose(null);
  assert.equal(world.camera.fov, 40, 'hero uses newly installed scene defaults');
  scene.dispose(); scene.dispose();
  assert.equal(calls.filter(call => call === 'dispose').length, 1);
});
