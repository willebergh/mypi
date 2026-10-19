import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { createHoodieCharacter } = await import('../src/avatar/hoodie-character.ts');
const { createRobot } = await import('../src/avatar/robot.ts');
const { WorldResources } = await import('../src/avatar/materials.ts');
const { DEFAULT_SCENE_CONFIG: defaults } = await import('../src/shared/scene-config.ts');
hooks.deregister();

const canvasTests = new WeakSet();
function fixture(t, factory = createHoodieCharacter) {
  if (!canvasTests.has(t)) {
    canvasTests.add(t);
    const previous = globalThis.document;
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  }
  const context = new Proxy({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    measureText: value => ({ width: String(value).length * 10 }),
  }, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => {} });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  const resources = new WorldResources();
  t.after(() => resources.dispose());
  let talk = { source: 'live', status: 'preparing', active: true, generation: 'one',
    steps: [{ id: 'voice', label: 'Preparing voice' }], currentStep: 0,
    readyToAnswer: false, audioEnabled: false, answerSubmitted: false };
  const character = factory(resources, defaults, () => talk);
  let face;
  character.group.traverse(node => { if (node.material?.isShaderMaterial) face = node; });
  return { character, resources, face, talk: changes => { talk = { ...talk, ...changes }; } };
}
const values = face => Object.fromEntries(Object.entries(face.material.uniforms)
  .filter(([, { value }]) => !value?.isTexture).map(([key, { value }]) => [key,
    value?.toArray ? value.toArray() : ArrayBuffer.isView(value) ? [...value] : value]));
const speech = (changes = {}) => ({ state: 'active', timestamp: Date.now(), rms: .2, peak: .4,
  bands: Array.from({ length: 12 }, (_, i) => i / 11), ...changes });

test('standalone asset is fabric plus one face; geometry/resources are finite and owned', t => {
  const { character, resources, face } = fixture(t);
  assert.equal(character.group.parent, null);
  assert.deepEqual(character.group.position.toArray(), [0, 0, 0]);
  let faces = 0;
  character.group.traverse(node => {
    if (!node.isMesh) return;
    assert.ok(resources.geometries.has(node.geometry));
    assert.ok(resources.materials.has(node.material));
    for (const attr of Object.values(node.geometry.attributes)) assert.ok([...attr.array].every(Number.isFinite));
    if (node.material.isShaderMaterial) faces++;
    else {
      if (node.material.isMeshBasicMaterial) {
        assert.equal(node.material.name, 'shadowed hood lining');
        assert.equal(node.material.color.getHex(), 0, 'lining stays black under scene lights');
      } else assert.equal(node.material.metalness, 0);
      assert.match(node.material.name, /fabric|lining/);
    }
  });
  assert.equal(faces, 1);
  assert.ok(face.material.fragmentShader.includes('glass = vec3(0.0);'), 'hoodie face has no visible glass backing');
  assert.ok(character.group.getObjectByName('continuous pullover'));
  assert.ok(character.group.getObjectByName('covered collar'));
  assert.ok(character.group.getObjectByName('closed draped hood'));
  assert.ok(face.position.z < .68, 'face is behind the sewn hood lip');
  const other = fixture(t);
  assert.notEqual(face.material, other.face.material);
  assert.notEqual(face.material.uniforms.mouthBands.value, other.face.material.uniforms.mouthBands.value);
  const assets = [...resources.geometries, ...resources.materials, ...resources.textures];
  let disposed = 0;
  for (const asset of assets) asset.addEventListener('dispose', () => disposed++);
  resources.dispose(); resources.dispose();
  assert.equal(disposed, assets.length);
});

test('structured readiness, warmup, blinks, stop/new generation and still setting', t => {
  const { character, face, talk } = fixture(t);
  character.update(defaults, 0);
  assert.equal(values(face).bootActive, 1); assert.equal(values(face).eyePower, 0);
  talk({ readyToAnswer: true });
  character.update(defaults, 1); assert.equal(values(face).blink, 0);
  character.update(defaults, 1.45); assert.ok(values(face).blink > 0 && values(face).blink < 1);
  character.update(defaults, 1.9); assert.equal(values(face).blink, 1);
  character.update(defaults, 6.385); assert.ok(values(face).blink < .1);
  character.update({ ...defaults, idleIntensity: 0 }, 6.385); assert.equal(values(face).blink, 1);
  talk({ generation: 'two' });
  character.update(defaults, 7); assert.equal(values(face).blink, 0);
  character.update(defaults, 8); assert.equal(values(face).blink, 1);
  talk({ readyToAnswer: false, active: false });
  character.update(defaults, 9); assert.equal(values(face).bootActive, 1);
  assert.equal(values(face).bootRunning, 0); assert.equal(values(face).eyePower, 0);
});

test('mouth uses fresh supplied bins only, clamps invalid input, releases on stale/silent/missing audio', t => {
  const { character, face } = fixture(t);
  character.update(defaults, 0);
  character.update(defaults, .1, speech());
  const mouth = values(face).mouthBands;
  assert.equal(mouth[0], 0); assert.ok(mouth[11] > .9);
  assert.ok(mouth.every((v, i) => i === 0 || v > mouth[i - 1]));
  for (const frame of [speech({ timestamp: Date.now() - 1000 }), speech({ timestamp: Date.now() + 1000 }),
    speech({ rms: 0 }), speech({ bands: [] }), speech({ state: 'off' }), undefined]) {
    character.update(defaults, 1, frame); character.update(defaults, 2, frame);
    assert.ok(values(face).mouthBands.every(v => v === 0));
    character.update(defaults, 0); character.update(defaults, .1, speech());
  }
  character.update(defaults, .2, speech({ bands: [NaN, Infinity, -2, 5, ...Array(8).fill(0)] }));
  assert.ok(values(face).mouthBands.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  character.update(defaults, 0); assert.ok(values(face).mouthBands.every(v => v === 0));
});

test('mouth attack/release is frame-rate independent and idle does not synthesize speech', t => {
  const result = hz => {
    const { character, face } = fixture(t);
    character.update(defaults, 0);
    for (let i = 1; i <= hz; i++) character.update(defaults, i / hz, speech());
    const attack = values(face).mouthBands;
    for (let i = 1; i <= hz / 2; i++) character.update(defaults, 1 + i / hz);
    const release = values(face).mouthBands;
    character.update({ ...defaults, idleIntensity: 1.5 }, 20);
    assert.ok(values(face).mouthBands.every(v => v === 0));
    return [attack, release].flat();
  };
  const slow = result(30), fast = result(120);
  slow.forEach((v, i) => assert.ok(Math.abs(v - fast[i]) < 1e-6));
});

test('garment colors update without casing controls or scene rebuilds; still pose is stable', t => {
  const { character, resources } = fixture(t);
  const meshes = []; character.group.traverse(node => { if (node.isMesh) meshes.push(node); });
  const config = { ...defaults, hoodieColor: '#345678', idleIntensity: 0 };
  character.update(config, 1);
  const cloth = [...resources.materials].find(m => m.name === 'hoodie fabric');
  assert.deepEqual(cloth.color.toArray(), new THREE.Color(config.hoodieColor).multiplyScalar(1.9).toArray());
  const transforms = character.group.children.map(node => [node.position.toArray(), node.rotation.toArray(), node.scale.toArray()]);
  character.update({ ...config, casingTint: '#ffffff', casingWear: 0, sceneId: 'desk' }, 10);
  assert.equal(JSON.stringify(character.group.children.map(node => [node.position.toArray(), node.rotation.toArray(), node.scale.toArray()])), JSON.stringify(transforms));
  assert.ok(meshes.every(node => node.parent));
});

// Locked from the pre-extraction robot, not from the new shared implementation.
// Covers every mesh/UV/index/normal, shader source, material appearance and animated uniforms/transforms.
test('legacy robot geometry, materials and animation match the pre-extraction fingerprint', t => {
  const { character, face, talk } = fixture(t, createRobot);
  const hash = createHash('sha256');
  character.group.traverse(node => {
    hash.update(JSON.stringify([node.type, node.position.toArray(), node.rotation.toArray(), node.scale.toArray()]));
    if (!node.isMesh) return;
    for (const [key, attr] of Object.entries(node.geometry.attributes)) {
      hash.update(key); hash.update(Buffer.from(attr.array.buffer, attr.array.byteOffset, attr.array.byteLength));
    }
    if (node.geometry.index) hash.update(Buffer.from(node.geometry.index.array.buffer));
    const m = node.material;
    hash.update(JSON.stringify([m.type, m.color?.toArray(), m.emissive?.toArray(), m.roughness, m.metalness,
      m.bumpScale, m.side, m.vertexShader, m.fragmentShader]));
  });
  const originalNow = Date.now; Date.now = () => 10000;
  t.after(() => { Date.now = originalNow; });
  for (const [time, changes, config, audio] of [
    [0, {}, defaults], [1, { readyToAnswer: true }, defaults], [1.45, {}, defaults, speech()],
    [1.9, {}, defaults, speech()], [6.34, {}, defaults],
    [7, {}, { ...defaults, idleIntensity: 0, hoodieColor: '#345678', eyeGlowColor: '#ffffff', casingWear: .2 }],
    [8, { generation: 'two' }, defaults], [9, { readyToAnswer: false, active: false }, defaults], [0, {}, defaults],
  ]) {
    talk(changes); character.update(config, time, audio);
    hash.update(JSON.stringify(values(face)));
    character.group.traverse(node => hash.update(JSON.stringify([node.position.toArray(), node.rotation.toArray(), node.scale.toArray(),
      node.material?.color?.toArray(), node.material?.bumpScale, node.material?.roughness])));
  }
  assert.equal(hash.digest('hex'), '388ff9f62339b6c6ad8b5ed33c5df5000087feb7ff4139e0cac9ed24c993e6a4');
});
