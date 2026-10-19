import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// SOURCE ONLY: not executed for the integration. No WebGL/Electron/app is needed.
async function moduleFromSource(relative, dependencies) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports;
}
const hudPanel = await moduleFromSource('../src/avatar/hud-panel.ts', {});
const presentation = await moduleFromSource('../src/avatar/presentation.ts', {
  three: {}, '../shared/presentation-protocol': {}, './hud-panel': hudPanel,
});
const { withPresentationHudMask } = await moduleFromSource('../src/avatar/presentation-visibility.ts', {
  './presentation': presentation,
});

for (const [width, height, panel] of [
  [1280, 720, { x: 400, y: 32, width: 848, height: 536 }],
  [720, 1280, { x: 24, y: 92, width: 672, height: 1028 }],
]) test(`render-only overlap/CC mask restores exact configured visibility at ${width}x${height}`, () => {
  const layers = [
    { bounds: { x: 30, y: 20, width: 10, height: 10 }, target: { visible: true } },
    { bounds: { ...panel }, target: { visible: true } },
    { bounds: { ...panel }, target: { visible: false } },
    { bounds: { x: 0, y: height - 90, width: 20, height: 80 }, target: { visible: true } },
  ];
  const before = layers.map(layer => layer.target.visible);
  const ccBand = { x: 0, y: height - 120, width, height: 120 };
  withPresentationHudMask(panel, layers, () => {
    assert.deepEqual(layers.map(layer => layer.target.visible), [true, false, false, false]);
  }, ccBand);
  assert.deepEqual(layers.map(layer => layer.target.visible), before);
  assert.throws(() => withPresentationHudMask(panel, layers, () => { throw new Error('render failed'); }, ccBand));
  assert.deepEqual(layers.map(layer => layer.target.visible), before, 'finally restores disabled bits too');
  withPresentationHudMask(null, layers, () => assert.deepEqual(layers.map(layer => layer.target.visible), before), ccBand);
});
