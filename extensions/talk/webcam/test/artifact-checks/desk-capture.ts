import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_SCENE_CONFIG } from '../../src/shared/scene-config';

// Hidden GPU fixture only: no user app, bridge, audio devices or camera publication.
const destination = path.resolve('artifacts/desk-preview');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  mkdirSync(destination, { recursive: true });
  const win = new BrowserWindow({ width: 1280, height: 720, useContentSize: true, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  const errors: string[] = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  try {
    await win.loadFile(path.resolve('artifacts/artifact-checks/hud-capture.html'));
    const deadline = Date.now() + 15000;
    while (!await win.webContents.executeJavaScript('!!window.sceneForCapture')) {
      if (Date.now() > deadline) throw new Error('Scene initialization timed out');
      await sleep(50);
    }
    for (const aspectRatio of ['16:9', '9:16'] as const) {
      const portrait = aspectRatio === '9:16';
      win.setContentSize(portrait ? 720 : 1280, portrait ? 1280 : 720);
      for (const hudMode of ['off', 'dashboard'] as const) {
        await win.webContents.executeJavaScript(`window.sceneForCapture.setConfig(${JSON.stringify({ ...DEFAULT_SCENE_CONFIG, sceneId: 'desk', aspectRatio, hudMode })})`);
        await sleep(2000);
        writeFileSync(path.join(destination, `${portrait ? 'portrait' : 'landscape'}-${hudMode}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await win.webContents.executeJavaScript('window.sceneForCapture.dispose()');
    if (errors.length) throw new Error(errors.join('\n'));
    writeFileSync(path.join(destination, 'capture.json'), JSON.stringify({ errors, camera: false, audio: false }, null, 2));
    win.destroy(); app.quit();
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});
