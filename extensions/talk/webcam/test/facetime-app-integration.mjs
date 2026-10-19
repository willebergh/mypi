// Run while `pnpm dev` provides the existing Vite renderer build/server.
// Starts a SEPARATE Electron instance with native output disabled and a private
// fake FaceTime socket. Never connects to or rotates the user's real FaceTime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'webcam-aspect-'));
const socketPath = path.join(temp, 'control.sock');
const report = { nativeOutputDisabled: true, fakeService: true, realFaceTimeCommands: 0 };
const peers = new Set(), commands = [];
const electronExecutable = createRequire(import.meta.url)('electron');
let seq = 0, accept = true, remote = '9:16', statusDelay = 0, child, ws, logs = '', debuggerURL, nextID = 0;
const pending = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const view = () => ({ available: true, windowId: '4242:fake-video-window', peer: 'Integration test peer',
  source: 'local_preview_geometry', remoteOrientation: 'unknown', rotationAvailable: true,
  localPreview: remote === '9:16' ? { width: 84, height: 150 } : { width: 150, height: 84 } });
const send = (socket, record) => socket.write(`${JSON.stringify({ protocolVersion: 1, ...record })}\n`);
function layout(aspect) {
  remote = aspect;
  const event = { type: 'event', serviceInstanceId: 'fake-app-service', seq: ++seq,
    event: 'video.layout_changed', source: 'local_preview_geometry', after: view().localPreview };
  for (const socket of peers) send(socket, event);
}
const server = createServer(socket => {
  if (!accept) { socket.destroy(); return; }
  peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
  send(socket, { type: 'snapshot', serviceInstanceId: 'fake-app-service', seq, call: { phase: 'idle' }, video: view() });
  let text = '';
  socket.on('data', chunk => {
    text += chunk;
    let n;
    while ((n = text.indexOf('\n')) >= 0) {
      const command = JSON.parse(text.slice(0, n)); text = text.slice(n + 1); commands.push(command.command);
      if (command.command === 'video.status') setTimeout(() => {
        if (!socket.destroyed) send(socket, { type: 'response', id: command.id, ok: true, result: view() });
      }, statusDelay);
      else if (command.command === 'video.rotate') {
        assert.equal(command.expectedWindowId, '4242:fake-video-window');
        assert.equal(command.expectedPeer, 'Integration test peer');
        const before = view(); layout(remote === '9:16' ? '16:9' : '9:16');
        send(socket, { type: 'response', id: command.id, ok: true,
          result: { attempted: true, verifiedChange: true, before, after: view() } });
      } else throw new Error(`Forbidden command: ${command.command}`);
    }
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
function evaluate(code) {
  const base = `const e=process.mainModule.require('electron');const windows=e.BrowserWindow.getAllWindows();const editor=windows.find(w=>!w.webContents.isOffscreen());const output=windows.find(w=>w.webContents.isOffscreen());`;
  return new Promise((resolve, reject) => {
    const id = ++nextID;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector request timed out')); }, 10000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression: `(async()=>{${base}${code}})()`, awaitPromise: true, returnByValue: true } }));
  });
}
const editorJS = code => evaluate(`return await editor.webContents.executeJavaScript(${JSON.stringify(code)});`);
async function until(predicate, label) {
  for (let i = 0; i < 150; i++) {
    try { const value = await predicate(); if (value) return value; } catch { /* Allow page startup. */ }
    await wait(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function matched(aspect) {
  return until(async () => {
    const state = await editorJS('window.webcam.getSceneState()');
    const status = await editorJS('window.webcam.getStatus()');
    const size = aspect === '9:16' ? [720, 1280] : [1280, 720];
    const previewAspect = await editorJS('document.querySelector(".preview-frame")?.dataset.aspect');
    return state.config.aspectRatio === aspect && previewAspect === aspect && status.width === size[0] && status.height === size[1]
      && state.outputRevision === state.revision && status.faceTimeAspect?.state === 'following'
      && status.frameCount > 5 ? { revision: state.revision, dimensions: size,
        faceTimeAspect: status.faceTimeAspect, nativeState: status.native.state, frameCount: status.frameCount } : null;
  }, `scene/output/FaceTime ${aspect}`);
}
try {
  child = spawn(electronExecutable, ['--inspect=127.0.0.1:0', `--user-data-dir=${path.join(temp, 'electron')}`, '.'], {
    cwd: root, env: { ...process.env, FACETIME_SOCKET_PATH: socketPath, FACETIME_ASPECT_SYNC: '1',
      PI_TALK_SYNTHETIC_FIXTURE: '1', VC4M_OUTPUT: '0', NATIVE_BRIDGE: '0', CAPTURE_MODE: 'shared' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; debuggerURL ??= logs.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0]; });
  await until(() => debuggerURL, 'Electron inspector');
  ws = new WebSocket(debuggerURL);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id);
    if (message.error || message.result?.exceptionDetails) entry.reject(new Error(JSON.stringify(message)));
    else entry.resolve(message.result?.result?.value);
  });
  report.initialPortrait = await matched('9:16');
  assert.equal(report.initialPortrait.nativeState, 'disabled');
  assert.equal(commands.filter(c => c === 'video.rotate').length, 0);
  layout('16:9'); report.eventLandscape = await matched('16:9');
  assert.equal(commands.filter(c => c === 'video.rotate').length, 0);
  await editorJS('(()=>{const button=[...document.querySelectorAll(".aspect-selector button")].find(b=>b.textContent.includes("9:16"));if(!button)throw new Error("Missing studio portrait control");button.click();return true})()');
  report.studioPortrait = await matched('9:16');
  assert.equal(commands.filter(c => c === 'video.rotate').length, 1);
  // A delayed appearance-only submission carries a stale landscape aspect.
  // It must preserve the newer portrait and MUST NOT rotate FaceTime.
  await editorJS('(async()=>{const s=await window.webcam.getSceneState();return window.webcam.setSceneConfig({...s.config,aspectRatio:"16:9",hudOpacity:0.57},{aspectChange:false})})()');
  report.staleAppearanceEdit = await matched('9:16');
  assert.equal((await editorJS('window.webcam.getSceneState()')).config.hudOpacity, 0.57);
  assert.equal(commands.filter(c => c === 'video.rotate').length, 1);
  statusDelay = 100;
  await editorJS('(async()=>{const s=await window.webcam.getSceneState();return Promise.all([window.webcam.setSceneConfig({...s.config,aspectRatio:"16:9"},{aspectChange:true}),window.webcam.setSceneConfig({...s.config,aspectRatio:"9:16"},{aspectChange:true})])})()');
  await wait(350); statusDelay = 0;
  report.rapidOppositeEdits = await matched('9:16');
  assert.equal(commands.filter(c => c === 'video.rotate').length, 1);
  await evaluate('editor.close();return true;'); layout('16:9'); report.editorClosed = await matched('16:9');
  assert.equal((await editorJS('window.webcam.getSceneState()')).config.hudOpacity, 0.57);
  accept = false; for (const socket of peers) socket.destroy();
  await until(async () => (await editorJS('window.webcam.getStatus()')).faceTimeAspect.state === 'offline', 'offline');
  await editorJS('(async()=>{const s=await window.webcam.getSceneState();return window.webcam.setSceneConfig({...s.config,aspectRatio:"9:16"},{aspectChange:true})})()');
  assert.equal(commands.filter(c => c === 'video.rotate').length, 1);
  accept = true; report.reconnected = await matched('16:9');
  assert.equal(commands.filter(c => c === 'video.rotate').length, 1);
  report.rotationCount = 1; report.commands = commands;
  console.log(JSON.stringify(report, null, 2));
} catch (error) { report.error = String(error); console.error(logs); throw error; }
finally {
  const destination = path.join(root, 'native/macos/vc4m/results'); await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'facetime-app-integration.json'), JSON.stringify(report, null, 2));
  if (ws?.readyState === 1) { try { await evaluate('setTimeout(()=>e.app.quit(),20);return true;'); } catch {} ws.close(); }
  for (const entry of pending.values()) entry.reject(new Error('Test closed')); pending.clear();
  if (child) { await wait(1500); if (child.exitCode === null) child.kill('SIGTERM'); }
  for (const socket of peers) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
