/** GPU check with explicitly injected numeric fixtures. Never loads the audio addon,
 * opens a stream, requests permission, or changes a device/default route. */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCENE_CONFIG } from '../../src/shared/scene-config';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 720, height: 1280, useContentSize: true, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(30);
  const errors: string[] = [];
  win.webContents.on('console-message', value => { if (value.level === 'error') errors.push(value.message); });
  const js = (source: string) => win.webContents.executeJavaScript(source);
  const destination = path.resolve('artifacts/speech-mouth');
  try {
    mkdirSync(destination, { recursive: true });
    await win.loadFile(path.resolve('artifacts/artifact-checks/hud-capture.html'));
    const deadline = Date.now() + 10000;
    while (!await js('!!window.sceneForCapture')) { if (Date.now() > deadline) throw Error('Scene timeout'); await wait(50); }
    await js(`window.sceneForCapture.setConfig(${JSON.stringify({ ...DEFAULT_SCENE_CONFIG, aspectRatio: '9:16', hudMode: 'off', idleIntensity: 0 })});window.setCaptureClockOffset(20)`);
    await wait(1300);
    const rest = await win.webContents.capturePage();
    writeFileSync(path.join(destination, 'mouth-rest.png'), rest.toPNG());
    await js(`window.setCaptureSpeechFixture('voice')`); await wait(350);
    const voice = await win.webContents.capturePage();
    writeFileSync(path.join(destination, 'mouth-spectrum-fixture.png'), voice.toPNG());
    await js(`window.setCaptureSpeechFixture('stale')`); await wait(1600);
    const stale = await win.webContents.capturePage();
    writeFileSync(path.join(destination, 'mouth-stale.png'), stale.toPNG());
    const rect = { x: 230, y: 575, width: 260, height: 120 };
    const a = rest.crop(rect).toBitmap(), b = voice.crop(rect).toBitmap(), c = stale.crop(rect).toBitmap();
    const difference = (x: Buffer, y: Buffer) => x.reduce((n, value, i) => n + (Math.abs(value - y[i]) > 3 ? 1 : 0), 0);
    const changed = difference(a, b), returned = difference(a, c);
    if (changed < 100) throw Error(`Mouth fixture did not change face pixels: ${changed}`);
    if (returned > changed * .1) throw Error(`Stale audio did not return to rest: ${returned}/${changed}`);
    if (errors.length) throw Error(errors.join('\n'));
    const result = { syntheticFixtureOnly: true, audioCaptureAttempted: false, speakingChangedBytes: changed, staleRestDifferenceBytes: returned, shaderErrors: errors.length };
    writeFileSync(path.join(destination, 'checks.json'), JSON.stringify(result, null, 2));
    console.log(result);
    await js('window.sceneForCapture.dispose()'); win.destroy(); app.quit();
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
