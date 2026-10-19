// Opt-in standalone hidden GPU fixture. Never launches the actual app or imports its main.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const output = path.join(root, 'artifacts/hoodie-preview');
if (process.env.VC4M_OUTPUT === '1') throw new Error('Unset VC4M_OUTPUT; this is an asset-only fixture.');
if (!process.versions.electron) {
  const { build } = await import('vite');
  mkdirSync(output, { recursive: true });
  await build({ configFile: false, root, logLevel: 'warn', build: {
    outDir: output, emptyOutDir: false, minify: false,
    lib: { entry: path.join(here, 'hoodie-capture-renderer.ts'), name: 'HoodieCapture',
      formats: ['iife'], fileName: () => 'renderer.js' },
  } });
  writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Standalone hoodie fixture</title></head><body><script src="renderer.js"></script></body></html>');
  if (!process.argv.includes('--build-only')) {
    const { createRequire } = await import('node:module');
    const { spawn } = await import('node:child_process');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url)], { cwd: root, env, stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
  }
} else {
  const { app, BrowserWindow, session } = await import('electron');
  // Separate user data and no app single-instance lock: leave running user processes alone.
  app.setPath('userData', path.join(output, 'electron-fixture-data'));
  app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({ show: false, width: 1000, height: 900, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  try {
    await win.loadFile(path.join(output, 'index.html'));
    const deadline = Date.now() + 15000;
    while (!await win.webContents.executeJavaScript('!!window.hoodieCapture')) {
      if (Date.now() > deadline) throw new Error('Standalone renderer initialization timed out');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const metrics = {};
    for (const [name, state, yaw] of [['boot', 'boot', 0], ['front', 'ready', 0],
      ['three-quarter', 'ready', .65], ['back', 'ready', Math.PI], ['blink', 'blink', 0], ['mouth', 'mouth', 0]]) {
      metrics[name] = await win.webContents.executeJavaScript(`window.hoodieCapture.render(${JSON.stringify(state)}, ${yaw})`);
      await new Promise(resolve => setTimeout(resolve, 150));
      writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript('window.hoodieCapture.dispose()');
    if (errors.length) throw new Error(errors.join('\n'));
    writeFileSync(path.join(output, 'capture.json'), JSON.stringify({ camera: false, audio: false, errors, metrics }, null, 2));
    win.destroy(); app.quit();
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
  }).catch(error => { console.error(error); app.exit(1); });
}
