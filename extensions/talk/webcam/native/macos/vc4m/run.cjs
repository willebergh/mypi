'use strict';
// Separate Electron main entrypoint; does not start or modify the editor.
const { app, BrowserWindow } = require('electron');
const { VirtualCameraOutput } = require('./output.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const seconds = Number(option('--seconds', '0'));
if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--seconds must be a nonnegative number (0 = continuous)');
const verify = args.includes('--verify');
const portrait = args.includes('--portrait');
const sourceSize = portrait ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
app.setPath('userData', path.join(__dirname, 'build', 'electron-data'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
let output, win, heartbeat, quitting = false, frameCount = 0, summary;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const metrics = values => {
  values = values.filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? { mean: values.reduce((a,b) => a+b,0)/values.length,
    p95: values[Math.floor((values.length-1)*0.95)], max: values.at(-1) } : null;
};
async function finish(code = 0) {
  if (quitting) return;
  quitting = true;
  clearInterval(heartbeat);
  const attempt = async fn => { try { return await fn(); } catch (error) { console.error(error); code = 1; } };
  await attempt(() => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.stopPainting(); });
  if (output) {
    await attempt(() => output.stop());
    const status = await attempt(() => output.status());
    await attempt(() => output.native.disconnect());
    if (status) {
      const disconnected = await attempt(() => output.status());
      if (disconnected?.error) status.error = disconnected.error;
      await attempt(() => {
      const timing = { cpuSubmitMs: metrics(output.samples.map(s => s.cpuSubmitMs)),
        gpuMs: metrics(output.samples.map(s => s.gpuMs)), nativeLatencyMs: metrics(output.samples.map(s => s.nativeLatencyMs)) };
      console.log(JSON.stringify({ final: status, timing }));
      if (summary) {
        const report = { ...summary(), final: status, timing, frameCount,
          processMetrics: app.getAppMetrics(), faceTimeVerified: false };
        fs.writeFileSync(path.join(__dirname, 'build', 'last-run.json'), JSON.stringify(report, null, 2));
      }
      if (status.error || status.errors.length || (seconds > 0 && status.accepted === 0)) code = 1;
      });
    }
  }
  await attempt(() => { if (win && !win.isDestroyed()) win.destroy(); });
  app.exit(code);
}
app.on('window-all-closed', () => {}); // Hidden source lives independently of editor windows.
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void finish(); } });
process.on('SIGINT', () => void finish());
process.on('SIGTERM', () => void finish());
app.whenReady().then(async () => {
  output = new VirtualCameraOutput();
  console.log('Discovery', output.discover());
  if (!output.discover().available) throw new Error('VirtualCamera4Mac missing: open installed app → Install / Activate → approve Camera Extensions');
  console.log('Connect', output.connect()); output.start();
  win = new BrowserWindow({ ...sourceSize, useContentSize: true, show: false,
    webPreferences: { offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
      backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setFrameRate(30);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', (_, details) => { console.error(details); void finish(1); });
  win.webContents.on('console-message', details => { if(details.level === 'error') console.error('[cube]',details.message); });
  win.webContents.on('paint', event => {
    if (!event.texture) return;
    frameCount++;
    output.consume(event.texture, frameCount);
  });
  await win.loadFile(path.join(__dirname, 'build', 'source', 'fixture.html'));
  win.webContents.startPainting();
  const started = performance.now(), cpu = process.cpuUsage();
  summary = () => {
    const elapsedSeconds = (performance.now() - started) / 1000;
    const used = process.cpuUsage(cpu);
    return { elapsedSeconds, mainCpuPercent: (used.user + used.system) / (elapsedSeconds * 10000),
      source: 'existing src/avatar/cube.ts, isolated verification fixture',
      dimensions: [1280, 720], sourceDimensions: [sourceSize.width, sourceSize.height],
      scaleMode: 'aspect-fit', targetFps: 30, producerCpuReadbacks: 0,
      acceptedFps: output.status().accepted / elapsedSeconds,
      note: 'mainCpuPercent includes native workers, excludes renderer/GPU helper CPU; GPU timing is copy only' };
  };
  let previous = 0;
  heartbeat = setInterval(() => {
    const status = output.status();
    console.log(JSON.stringify({ ...status, acceptedLastSecond: status.accepted - previous }));
    previous = status.accepted;
    if (status.errors.length || !status.connected) void finish(1);
  }, 1000);
  if (verify) {
    await wait(4000);
    win.webContents.stopPainting(); await output.stop();
    const stopped = output.status().accepted;
    await wait(500);
    if (output.status().accepted !== stopped) throw new Error('Frames admitted after stop');
    output.native.disconnect(); output.connect(); output.start(); win.webContents.startPainting();
    console.log('STOP / DISCONNECT / RECONNECT / RESTART passed');
    // Receiver performs a bounded, diagnostic CPU hash. Producer remains GPU-only.
    const receiver = path.join(__dirname, 'build', 'receive');
    if (fs.existsSync(receiver)) {
      const child = spawn(receiver, ['5', ...(portrait ? ['--portrait-fit'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
      let text = ''; child.stdout.on('data', chunk => { text += chunk; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      fs.writeFileSync(path.join(__dirname, 'build', 'receiver-last.json'), text);
      console.log('Receiver:', text.trim());
      if (code !== 0) throw new Error(`Receiver did not verify animated camera frames (exit ${code})`);
    } else throw new Error('Build receive.mm as documented before --verify');
  }
  const remaining = seconds * 1000 - (performance.now() - started);
  if (seconds > 0) { if (remaining > 0) await wait(remaining); await finish(); }
}).catch(error => { console.error(error); void finish(1); });
