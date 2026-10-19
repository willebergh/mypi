import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OffscreenRenderer } from './offscreen';
import type { SceneState } from '../shared/scene-config';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Actual browser input + IPC tests. Does not expose a renderer debug bridge or call camera APIs. */
export async function verifyEditor(output: OffscreenRenderer, editor: BrowserWindow, directory: string,
  waitForScene: (revision?: number) => Promise<SceneState>) {
  editor.show(); app.focus({ steal: true }); editor.focus(); editor.webContents.focus();
  await sleep(400);
  await editor.webContents.executeJavaScript("document.querySelector('[data-testid=reset-camera]').click()");
  await sleep(600);
  const initial = await waitForScene();
  const outputID = output.window!.webContents.id;
  const frames = output.status.frameCount;
  const bounds = await editor.webContents.executeJavaScript("(() => {const r=document.querySelector('[data-testid=scene-preview] canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  assert(bounds.width > 400 && bounds.height > 220, 'Editor preview is not visible');
  const pose = () => editor.webContents.executeJavaScript("document.querySelector('.preview-frame').dataset.cameraPosition.split(',').map(Number)") as Promise<number[]>;
  const initialPose = await pose();
  const previewStats = await editor.webContents.executeJavaScript("(() => {const d=document.querySelector('.preview-frame').dataset;return {fps:Number(d.previewFps),drawCalls:Number(d.drawCalls),triangles:Number(d.triangles)}})()");
  assert(previewStats.fps > 25 && previewStats.drawCalls > 0, 'Preview is not rendering responsively');
  const x = Math.round(bounds.x + bounds.width * 0.52), y = Math.round(bounds.y + bounds.height * 0.5);
  editor.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await sleep(80);
  editor.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 12; step++) {
    editor.webContents.sendInputEvent({ type: 'mouseMove', x: x + step * 7, y: y + step * 2, button: 'left', modifiers: ['leftbuttondown'] });
    await sleep(15);
  }
  editor.webContents.sendInputEvent({ type: 'mouseUp', x: x + 84, y: y + 24, button: 'left', clickCount: 1 });
  await sleep(1400);
  const orbitPose = await pose();
  const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));
  if (distance(initialPose, orbitPose) <= 0.1) console.error('Orbit diagnostic', { initialPose, orbitPose, focused: editor.isFocused(), bounds });
  assert(distance(initialPose, orbitPose) > 0.1, 'Orbit control did not move camera');
  editor.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: 150 });
  await sleep(1200);
  const zoomPose = await pose();
  assert(distance(orbitPose, zoomPose) > 0.05, 'Zoom control did not move camera');
  await editor.webContents.executeJavaScript("document.querySelector('[data-testid=reset-camera]').click()");
  await sleep(1600);
  const resetPose = await pose();
  assert(distance(initialPose, resetPose) < 0.08, 'Reset camera did not restore hero framing');
  assert.equal((await waitForScene()).revision, initial.revision, 'Preview camera motion must not mutate output scene config');

  const slider = await editor.webContents.executeJavaScript("(() => {const r=document.querySelector('#eyeSquint').getBoundingClientRect();return {x:r.x+r.width*.91,y:r.y+r.height*.5}})()");
  editor.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(slider.x), y: Math.round(slider.y), button: 'left', clickCount: 1 });
  editor.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(slider.x), y: Math.round(slider.y), button: 'left', clickCount: 1 });
  const sliderState = await waitForScene(initial.revision + 1);
  assert(sliderState.config.eyeSquint > 0.8, 'Real range input did not synchronize to output');
  await writeFile(path.join(directory, 'output-squint.png'), await output.capturePNG());

  const custom = { ...initial.config, eyeGlowIntensity: 2, eyeGlowColor: '#91ffb1', eyeSquint: 0.35,
    casingTint: '#6c8194', casingWear: 0.25, hoodieColor: '#26384b', idleIntensity: 1,
    roomIntensity: 1.3, warmCoolBalance: 0.15 };
  const applied = await editor.webContents.executeJavaScript(`window.webcam.setSceneConfig(${JSON.stringify(custom)})`) as SceneState;
  const synced = await waitForScene(applied.revision);
  assert.deepEqual(synced.config, custom);
  await sleep(350);
  assert.equal(await editor.webContents.executeJavaScript("document.querySelector('#eyeGlowColor').value"), custom.eyeGlowColor);
  await writeFile(path.join(directory, 'output-custom.png'), await output.capturePNG());
  await writeFile(path.join(directory, 'editor-custom.png'), (await editor.webContents.capturePage()).toPNG());
  assert.equal(output.window!.webContents.id, outputID, 'Settings update restarted output renderer');
  assert(output.status.frameCount > frames, 'Output did not continue while editing');
  await assert.rejects(editor.webContents.executeJavaScript(`window.webcam.setSceneConfig(${JSON.stringify({ ...custom, eyeGlowIntensity: 500 })})`));
  await assert.rejects(editor.webContents.executeJavaScript(`window.webcam.setSceneConfig(${JSON.stringify({ ...custom, unexpected: true })})`));
  await assert.rejects(output.window!.webContents.executeJavaScript(`window.webcam.setSceneConfig(${JSON.stringify(custom)})`));
  await assert.rejects(editor.webContents.executeJavaScript('window.webcam.sceneApplied(0)'));

  const restored = await editor.webContents.executeJavaScript(`window.webcam.setSceneConfig(${JSON.stringify(initial.config)})`) as SceneState;
  await waitForScene(restored.revision);
  await sleep(300);
  assert.equal(output.window!.webContents.id, outputID);
  return { previewBounds: bounds, previewStats, initialPose, orbitPose, zoomPose, resetPose, slider: sliderState,
    synchronized: synced, outputWebContentsID: outputID, restoredRevision: restored.revision,
    checks: 'Real orbit/zoom/reset and squint input; all nine settings acknowledged after output render; no output restart; invalid/sender IPC rejected' };
}
