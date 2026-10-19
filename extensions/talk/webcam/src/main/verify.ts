import { app, BrowserWindow, nativeImage, type OffscreenSharedTexture } from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { OffscreenRenderer } from './offscreen';
import type { NativeFrameResult } from './native-bridge';
import type { SceneState } from '../shared/scene-config';
import { verifyEditor } from './verify-editor';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export async function verify(output: OffscreenRenderer, editor: BrowserWindow, directory: string) {
  await rm(path.join(directory, 'failure.txt'), { force: true });
  const report: Record<string, unknown> = {
    packaged: app.isPackaged, platform: process.platform, arch: process.arch, versions: process.versions,
    gpu: await app.getGPUInfo('complete'),
    timingNotes: 'CPU import/encode/commit; GPU command start/end timestamps; completion is main-process paint handler to JS callback. No Three.js render-to-consumer latency measurement.',
  };
  // Read-only camera diagnostics: NEVER submit activation/deactivation in automated tests.
  const camera = await editor.webContents.executeJavaScript('window.webcam.cameraStatus()');
  report.camera = camera;
  assert.equal(camera.bundled, app.isPackaged, 'Production bundle must include the real camera extension');
  if (!camera.teamID) assert.equal(camera.canRequest, false, 'Unsigned builds must not offer installation');
  const samples: Record<string, unknown>[] = [];
  async function waitForScene(minRevision?: number): Promise<SceneState> {
    const deadline = performance.now() + 25000;
    while (performance.now() < deadline) {
      const state = await editor.webContents.executeJavaScript('window.webcam.getSceneState()');
      if (state.outputRevision === state.revision && (minRevision === undefined || state.revision >= minRevision)) return state;
      await sleep(50);
    }
    throw new Error('Output scene did not acknowledge its rendered configuration');
  }
  async function sample(label: string, seconds = 5) {
    await waitForScene();
    await sleep(1000);
    const before = output.refreshStatus();
    const time = performance.now();
    app.getAppMetrics(); // Prime CPU deltas; first call can report zero.
    const cpuStart = process.cpuUsage();
    const memoryBefore = process.memoryUsage();
    await sleep(seconds * 1000);
    const elapsed = (performance.now() - time) / 1000;
    const cpuUsed = process.cpuUsage(cpuStart);
    const after = output.refreshStatus();
    const frames = after.frameCount - before.frameCount;
    const processed = after.native.framesProcessed - before.native.framesProcessed;
    const gpuTimed = after.native.gpuTimedFrames - before.native.gpuTimedFrames;
    const result = { label, frames, seconds: elapsed, fps: frames / elapsed,
      mainCpuPercentOneCore: (cpuUsed.user + cpuUsed.system) / (elapsed * 1e6) * 100,
      mainMemoryBefore: memoryBefore, mainMemoryAfter: process.memoryUsage(),
      processed, processedFPS: processed / elapsed,
      cpuSubmitMs: processed ? (after.native.cpuSubmitTotalMs - before.native.cpuSubmitTotalMs) / processed : null,
      gpuMs: gpuTimed ? (after.native.gpuTotalMs - before.native.gpuTotalMs) / gpuTimed : null,
      completionMs: processed ? (after.native.completionTotalMs - before.native.completionTotalMs) / processed : null,
      status: after, windowCount: BrowserWindow.getAllWindows().length, appMetrics: app.getAppMetrics(),
    };
    console.log('MEASURED', label, result.fps.toFixed(2), 'FPS',
      'native', result.processedFPS.toFixed(2), 'CPU/GPU/completion ms', result.cpuSubmitMs, result.gpuMs, result.completionMs);
    assert(result.fps > 25, `${label}: frame delivery below 25 FPS`);
    assert.equal(after.width, 1280);
    assert.equal(after.height, 720);
    assert.equal(output.window?.isVisible(), false);
    if (after.native.state === 'running') {
      assert(result.processedFPS > 25, `${label}: native processing stalled`);
      assert.equal(after.native.failedFrames, 0, after.native.error ?? 'native error');
      assert.equal(after.native.orderingErrors, 0);
      assert(after.native.maxInFlight <= 1);
      assert(after.native.resources.sourceRetains <= 1);
      assert.equal(after.native.resources.destinationTextures, 1);
    }
    samples.push(result);
    return result;
  }
  async function stopAndCheck() {
    await output.stop();
    const s = output.refreshStatus();
    assert.equal(s.native.inFlight, 0);
    assert.equal(s.native.resources.inFlight, 0);
    assert.equal(s.native.resources.sourceRetains, 0);
    assert.equal(s.native.resources.destinationTextures, 0);
    assert.equal(output.sharedFrames, output.releasedTextures, 'Every Electron texture must be released after drain');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(s.native.framesReceived, s.native.framesProcessed + s.native.droppedFrames + s.native.failedFrames);
    return s;
  }
  function saveNative(frame: NativeFrameResult, name: string) {
    assert(frame.outputBGRA);
    assert.equal(frame.sourceMatchesOutput, true, 'GPU destination differs from source readback of the SAME frame');
    assert.equal(frame.outputBGRA.length, 1280 * 720 * 4);
    assert.equal(frame.width, 1280);
    assert.equal(frame.height, 720);
    const image = nativeImage.createFromBitmap(frame.outputBGRA, { width: frame.width, height: frame.height, scaleFactor: 1 });
    return writeFile(path.join(directory, name), image.toPNG());
  }

  // Same scene/window settings, bridge off vs on; no PNG/readback during either measurement.
  await output.start(false, false);
  const baseline = await sample('shared-baseline-no-native', 10);
  await stopAndCheck();
  await output.start(false, true);
  assert.equal(output.refreshStatus().native.state, 'running', output.status.native.error ?? 'Native bridge unavailable');
  const enabled = await sample('native-visible', 10);
  report.overheadComparison = { baseline, enabled,
    note: 'Sequential measurements, not simultaneous or statistically controlled; see per-process CPU and memory samples.' };

  // Exercise native bound with a second submission of a REAL handle while the normal first job owns it.
  const addonFile = app.isPackaged ? path.join(process.resourcesPath, 'bridge.node')
    : path.join(app.getAppPath(), 'native/macos/build/Release/bridge.node');
  const addon = createRequire(__filename)(addonFile);
  report.nativeBound = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No shared paint for native busy test')), 5000);
    output.window!.webContents.once('paint', (event: Electron.Event & { texture?: OffscreenSharedTexture }) => {
      clearTimeout(timer);
      try {
        assert(event.texture);
        assert.equal(addon.diagnostics().inFlight, 1);
        const info = event.texture.textureInfo;
        const unexpected = addon.submit(info.handle.ioSurface, info.codedSize.width, info.codedSize.height, info.pixelFormat, 999999, false);
        Promise.resolve(unexpected).then(() => reject(new Error('Native addon accepted work beyond bound')), error => {
          if (/busy|in.flight/i.test(String(error))) resolve(String(error));
          else reject(error);
        });
      } catch (error) {
        if (/busy|in.flight/i.test(String(error))) resolve(String(error));
        else reject(error);
      }
    });
  });

  const first = await output.bridge.readbackNext();
  await saveNative(first, 'native-metal-1.png');
  await sleep(650);
  const second = await output.bridge.readbackNext();
  await saveNative(second, 'native-metal-2.png');
  assert(first.outputBGRA && second.outputBGRA);
  assert.notEqual(hash(first.outputBGRA), hash(second.outputBGRA), 'Native animation frames must differ');
  assert(second.sequence > first.sequence, 'Native frame order must increase');
  // Content sanity for a deliberately dark portrait: require real luminance range, not a bright center pixel.
  let darkest = 255, brightest = 0;
  for (let y = 30; y < 720; y += 37) for (let x = 20; x < 1280; x += 41) {
    const offset = (y * 1280 + x) * 4;
    const luminance = (first.outputBGRA[offset] + first.outputBGRA[offset + 1] + first.outputBGRA[offset + 2]) / 3;
    darkest = Math.min(darkest, luminance); brightest = Math.max(brightest, luminance);
  }
  assert(brightest - darkest > 40, 'Rendered scene is blank or has no visible content');
  report.nativeFrameVerification = { sequences: [first.sequence, second.sequence],
    hashes: [hash(first.outputBGRA), hash(second.outputBGRA)],
    sourceMatchesOutput: [first.sourceMatchesOutput, second.sourceMatchesOutput],
    bytes: first.outputBGRA.length, darkest, brightest };
  await writeFile(path.join(directory, 'editor.png'), (await editor.webContents.capturePage()).toPNG());
  const previewBounds = await editor.webContents.executeJavaScript("(() => { const r=document.querySelector('[data-testid=scene-preview] canvas').getBoundingClientRect(); return {x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}; })()");
  await writeFile(path.join(directory, 'preview-scene.png'), (await editor.webContents.capturePage(previewBounds)).toPNG());
  report.editor = await verifyEditor(output, editor, directory, waitForScene);
  const png = await output.capturePNG();
  await writeFile(path.join(directory, 'output-hero.png'), png);
  assert.deepEqual(nativeImage.createFromBuffer(png).getSize(), { width: 1280, height: 720 });
  report.sharedTexture = output.textureDescription;

  editor.minimize();
  await sample('native-minimized');
  editor.restore();
  editor.hide();
  await sample('native-hidden');
  editor.show();
  editor.close();
  assert(!editor.isDestroyed());
  assert(!editor.isVisible());
  await sample('native-editor-closed');
  const soakSeconds = Math.max(10, Number(process.env.VERIFY_SOAK_SECONDS ?? 30));
  const soakStart = output.refreshStatus();
  for (let remaining = soakSeconds; remaining > 0; remaining -= 10) {
    await sample(`native-soak-${soakSeconds - remaining}s`, Math.min(10, remaining));
  }
  const soakEnd = output.refreshStatus();
  assert.equal(soakStart.native.resources.readbackCount, soakEnd.native.resources.readbackCount,
    'Continuous operation must not perform debug CPU readbacks');
  report.continuousOperation = { seconds: soakSeconds, before: soakStart.native, after: soakEnd.native };
  report.nativeFinal = (await stopAndCheck()).native;
  const stoppedCount = output.status.frameCount;
  await sleep(400);
  assert.equal(output.status.frameCount, stoppedCount);

  const cycles = [];
  for (let i = 0; i < 8; i++) {
    await output.start(false, true);
    await waitForScene();
    await sleep(200 + (i % 3) * 37);
    assert.equal(output.refreshStatus().native.state, 'running');
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    const final = await stopAndCheck();
    assert(final.native.framesProcessed > 0);
    cycles.push(final.native);
  }
  report.nativeRestartCycles = cycles;
  await Promise.all([output.start(false, true), output.stop(), output.start(false, true)]);
  assert.equal(output.refreshStatus().native.state, 'running');
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  // Stop from the same paint turn as native submission: GPU ownership must drain before destroy.
  report.stopDuringInFlight = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No paint for in-flight stop test')), 5000);
    output.window!.webContents.once('paint', () => {
      clearTimeout(timer);
      try {
        assert.equal(output.refreshStatus().native.inFlight, 1);
        const started = performance.now();
        output.stop().then(() => resolve({ drainMs: performance.now() - started, status: output.refreshStatus() }), reject);
      } catch (error) { reject(error); }
    });
  });
  await stopAndCheck();
  report.concurrentTransitions = 'start/stop/start serialized; stop during native submission drained';
  await output.start(true);
  editor.show();
  await sample('bitmap-visible');
  await writeFile(path.join(directory, 'output-bitmap.png'), await output.capturePNG());
  editor.hide();
  await sample('bitmap-hidden');
  editor.show();
  editor.close();
  await sample('bitmap-editor-closed');
  await output.start(true);
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  const uiStatus = await editor.webContents.executeJavaScript('window.webcam.getStatus()');
  assert.equal(uiStatus.state, 'running');
  await editor.webContents.executeJavaScript('window.webcam.stop()');
  assert.equal(output.status.state, 'stopped');
  await editor.webContents.executeJavaScript('window.webcam.start()');
  assert.equal(output.status.state, 'running');
  assert.equal(output.refreshStatus().native.state, 'running');
  report.preloadIPC = 'getStatus/stop/start passed; Quit exercised after report';
  report.samples = samples;
  report.gpuFeatures = app.getGPUFeatureStatus();
  await stopAndCheck();
  await stopAndCheck();
  await writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2));
  console.log('VERIFICATION PASSED:', directory);
}
