import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
// Match Vite's extensionless relative TS resolution without changing app imports.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
} });
const { createTerminal, terminalFrame, terminalLine } = await import('../src/avatar/terminal.ts');
const { createRoom } = await import('../src/avatar/room.ts');
const { WorldResources } = await import('../src/avatar/materials.ts');
hooks.deregister();
import * as THREE from 'three';

function canvasFixture(t) {
  const previous = globalThis.document;
  const operations = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  }, {
    get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key)
      : (...args) => operations.push([key, ...args]),
    set: (target, key, value) => { operations.push([key, value]); target[key] = value; return true; },
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return operations;
}

test('synthetic terminal lines and staggered clocks are deterministic', () => {
  assert.equal(terminalLine(42, 2), terminalLine(42, 2));
  assert.notEqual(terminalLine(42, 2), terminalLine(43, 2));
  assert.match(terminalLine(42, 2), /^\d{2}:\d{2} /);
  assert.equal(terminalFrame(0, 0), terminalFrame(.1, 0));
  assert.notEqual(terminalFrame(.1, 0), terminalFrame(.1, 1));
  assert.equal(terminalFrame(NaN, 0), 0);
  assert.equal(terminalFrame(-10, 0), 0);
});

for (let variant = 0; variant < 3; variant++) {
  test(`monitor ${variant} animates, caps uploads, seeks deterministically and disposes`, t => {
    const ops = canvasFixture(t);
    const resources = new WorldResources();
    t.after(() => resources.dispose());
    const terminal = createTerminal(resources, variant, variant);
    const version = terminal.texture.version;
    const initial = ops.splice(0);
    terminal.update(.001);
    assert.equal(terminal.texture.version, version);
    assert.equal(ops.length, 0);
    terminal.update(.5);
    assert.equal(terminal.texture.version, version + 1);
    assert.notDeepEqual(ops.splice(0), initial);
    terminal.update(20);
    assert.notDeepEqual(ops.splice(0), initial);
    terminal.update(0);
    assert.deepEqual(ops.splice(0), initial);
    assert.equal(terminal.texture.image.width, 512);
    assert.equal(terminal.texture.image.height, 320);
    assert.equal(terminal.texture.generateMipmaps, false);
    assert.equal(terminal.texture.minFilter, THREE.LinearFilter);
    assert.ok(resources.textures.has(terminal.texture));
    const text = initial.filter(op => op[0] === 'fillText').map(op => op[1]);
    assert.match(text[0], [/EVENT STREAM/, /SYSTEM LOAD/, /PHOSPHOR.TS/][variant]);
    if (variant === 0) assert.ok(text.some(line => /^\d{2}:\d{2}/.test(line)));
    if (variant === 1) assert.ok(text.includes('CPU') && text.includes('MEM'));
    if (variant === 2) assert.ok(text.some(line => line.startsWith('BUILD ')));
    let disposed = false;
    terminal.texture.addEventListener('dispose', () => { disposed = true; });
    resources.dispose();
    assert.ok(disposed);
  });
}

test('workstation has exactly three equal aligned panels with inward side angles and 52 rack LEDs', t => {
  canvasFixture(t);
  const resources = new WorldResources();
  t.after(() => resources.dispose());
  const room = createRoom(resources);
  const monitors = room.group.children.filter(child => child.name.startsWith('workstation monitor'));
  assert.equal(monitors.length, 3);
  assert.deepEqual(monitors.map(m => m.position.y), [2.0235, 2.0235, 2.0235]);
  assert.deepEqual(monitors.map(m => m.rotation.y), [.21, 0, -.21]);
  const screens = [...resources.materials].filter(m => m.emissiveMap);
  assert.equal(screens.length, 3);
  const bounds = room.group.children.filter(m => screens.includes(m.material)).map(m => {
    m.geometry.computeBoundingBox();
    const size = m.geometry.boundingBox.getSize(new THREE.Vector3());
    return { height: size.y, width: Math.hypot(size.x, size.z) };
  });
  for (const b of bounds) {
    assert.ok(Math.abs(b.height - 1.25 * .64) < 1e-6);
    assert.ok(Math.abs(b.width - 1.25) < 1e-6);
  }
  const leds = room.group.getObjectByName('asynchronous network link / activity');
  assert.equal(leds.geometry.getAttribute('color').count, 52 * 4);
});
