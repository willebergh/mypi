import './logging';
import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, screen } from 'electron';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { OffscreenRenderer } from './offscreen';
import { SpeechAudio } from './speech-audio';
import { OutputView } from './output-view';
import { SettingsStore } from './settings-store';
import { validateEditorPreferences, type EditorBootstrap } from '../shared/settings';
import { verify } from './verify';
import { cameraStatus } from './camera';
import { FaceTimeAspectSync } from './facetime-aspect';
import { createFaceTimeTransport } from './facetime-transport';
import { createLiveHudClient, liveHudSocketPath, talkLaunchSocket } from './live-client';
import { captionCallActive, LIVE_HUD_STALE_MS, type LiveHudState } from '../shared/live-protocol';
import { createPresentationPreparer } from './presentation-images';
import { createDemoHudController } from './demo-hud';
import { parsePresentation, presentationRevision } from '../shared/presentation-protocol';
import { DEFAULT_SCENE_CONFIG, outputSize, validateSceneConfig, type SceneConfig, type SceneState } from '../shared/scene-config';

declare const APP_VITE_DEV_SERVER_URL: string;
declare const APP_VITE_NAME: string;
// Duplicate packaged launches (including /talk facetime's parent launcher) reuse this app.
const verificationMode = process.argv.includes('--verify');
const syntheticFixture = process.env.PI_TALK_SYNTHETIC_FIXTURE === '1';
// package.json name/productName already agree. Pin the same default identity in
// Forge development and packaged launches, before the single-instance lock.
app.setName('pi-talk-webcam');
if (!verificationMode && !syntheticFixture) app.setPath('userData', path.join(app.getPath('appData'), 'pi-talk-webcam'));
let settings: SettingsStore | undefined;
let settingsLoaded = false;
let talkLaunchRequested = process.env.PI_TALK_LAUNCH_SOURCE === 'talk';
// Verification/fixtures are isolated processes, never a handoff to a live editor.
const hasInstanceLock = verificationMode || syntheticFixture || app.requestSingleInstanceLock({
  source: process.env.PI_TALK_LAUNCH_SOURCE === 'talk' ? 'talk' : 'manual', socketPath: liveHudSocketPath(),
});
if (!hasInstanceLock) app.quit();
let editor: BrowserWindow;
app.on('second-instance', (_event, _argv, _cwd, data) => {
  const target = talkLaunchSocket(data);
  if (target) {
    if (verificationMode || syntheticFixture || quitting) return;
    if (target !== liveHudSocket) {
      clearPresentation(); // Invalidate pending decode BEFORE retarget/client callbacks.
      liveHud.close();
      liveHudSocket = target;
      liveHud = createLiveHudClient({ socketPath: target, onState: () => broadcastLiveHud() });
      liveHud.start();
    }
    liveHudMode = 'live';
    talkLaunchRequested = true;
    if (settingsLoaded) settings!.update({ hudSource: 'live' });
    demoHud.setActive(false);
    broadcastLiveHud();
    return; // A Talk launch does not steal focus from an existing editor.
  }
  if (editor && !editor.isDestroyed()) { editor.restore(); editor.show(); editor.focus(); }
});
let quitting = false;
let tray: Tray;
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(operation: () => Promise<T> | T): Promise<T> => {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
};
async function load(window: BrowserWindow, page: string) {
  if (APP_VITE_DEV_SERVER_URL) await window.loadURL(new URL(`${page}.html`, APP_VITE_DEV_SERVER_URL).href);
  else await window.loadFile(path.join(__dirname, `../renderer/${APP_VITE_NAME}/${page}.html`));
}
const outputView = new OutputView((state, includeEditor) => {
  for (const win of includeEditor ? [editor, output.window] : [output.window]) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send('output:view', state); } catch { /* Output may be navigating/restarting. */ }
    }
  }
});
let sceneState: SceneState = { config: { ...DEFAULT_SCENE_CONFIG }, revision: 0, outputRevision: null };
function broadcastScene() {
  for (const win of [editor, output.window]) {
    if (win && !win.isDestroyed()) win.webContents.send('scene:state', sceneState);
  }
}
const output = new OffscreenRenderer(win => load(win, 'output'), () => {
  if (output.status.state !== 'running' && sceneState.outputRevision !== null) {
    sceneState = { ...sceneState, outputRevision: null };
    broadcastScene();
  }
  publishRendererStatus();
});

const speechAudio = new SpeechAudio(state => {
  for (const win of [editor, output.window]) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try { win.webContents.send('speech-audio:state', state); } catch { /* Renderer is closing. */ }
  }
}, { captureAllowed: hasInstanceLock && !verificationMode && !syntheticFixture });

// All aspect changes share the same scene revision, offscreen resize and GPU
// drain path. Automatic FaceTime changes preserve every other scene setting.
async function applySceneConfig(config: SceneConfig) {
  if (JSON.stringify(config) !== JSON.stringify(sceneState.config)) {
    const changedAspect = config.aspectRatio !== sceneState.config.aspectRatio;
    if (changedAspect) {
      const size = outputSize(config.aspectRatio);
      await output.setResolution(size.width, size.height);
    }
    sceneState = { ...sceneState, config, revision: sceneState.revision + 1,
      outputRevision: changedAspect ? null : sceneState.outputRevision };
    broadcastScene();
    settings?.update({ scene: config });
  }
  return sceneState;
}
let lastAspectError: string | null = null;
const aspectSync = new FaceTimeAspectSync({
  createTransport: callbacks => createFaceTimeTransport({ ...callbacks, socketPath: process.env.FACETIME_SOCKET_PATH }),
  getAspect: () => sceneState.config.aspectRatio,
  applyAspect: (aspectRatio, current) => serial(async () => {
    if (current() && !quitting) await applySceneConfig({ ...sceneState.config, aspectRatio });
  }),
  onStatus: status => {
    if (status.error && status.error !== lastAspectError) console.warn('[FaceTime aspect]', status.error);
    lastAspectError = status.error;
    publishRendererStatus();
  },
});
function rendererStatus() { return { ...output.refreshStatus(), faceTimeAspect: aspectSync.status() }; }
function publishRendererStatus() {
  if (editor && !editor.isDestroyed()) editor.webContents.send('renderer:status', rendererStatus());
}

let liveHudMode: LiveHudState['mode'] = verificationMode ? 'demo' : 'live';
const demoHud = createDemoHudController(() => broadcastLiveHud());
demoHud.setActive(liveHudMode === 'demo');
let liveHudSocket = liveHudSocketPath();
let liveHud = createLiveHudClient({ socketPath: liveHudSocket, onState: () => broadcastLiveHud() });
function getLiveHudState(): LiveHudState {
  return liveHudMode === 'demo' ? { mode: 'demo', connection: 'offline', snapshot: null, demo: demoHud.read() } : liveHud.getState();
}
function presentationFeedActive(state: LiveHudState): boolean {
  const s = state.snapshot, now = Date.now();
  return !quitting && state.mode === 'live' && state.connection === 'live' && !!s
    && now - s.timestamp < LIVE_HUD_STALE_MS && s.timestamp - now <= 1000
    && !!parsePresentation(s.presentation, {
      displayScopeId: s.displayScopeId,
      callRunId: captionCallActive(s.talk) ? s.talk.runId : undefined,
    });
}
const presentation = createPresentationPreparer({
  socketPath: () => liveHudSocket,
  stillActive: value => {
    const state = getLiveHudState(), current = state.snapshot?.presentation;
    return presentationFeedActive(state) && !!current && presentationRevision(current) === presentationRevision(value);
  },
  publish: value => {
    // Dedicated bounded image channel, never periodic HUD state or unrelated windows.
    for (const win of [editor, output.window]) {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try { win.webContents.send('presentation:state', value); } catch { /* Closing renderer. */ }
    }
  },
});
let presentationScope = '', latestPresentation = '', blockedPresentation = '';
function clearPresentation() {
  if (latestPresentation) blockedPresentation = latestPresentation;
  latestPresentation = presentationScope = '';
  presentation.clear();
}
function syncPresentation(state: LiveHudState) {
  const s = state.snapshot;
  if (!presentationFeedActive(state) || !s?.presentation) { clearPresentation(); return; }
  const scope = JSON.stringify([liveHudSocket, s.streamId, s.sessionId, s.branchId,
    s.presentation.version === 1 ? s.talk.runId : s.displayScopeId]);
  if (presentationScope && presentationScope !== scope) clearPresentation();
  presentationScope = scope;
  const revision = presentationRevision(s.presentation);
  // A short offline/demo/session edge must not revive the same revision from a retained frame.
  if (revision === blockedPresentation) { presentation.clear(); return; }
  latestPresentation = revision;
  presentation.update({ active: true, displayScopeId: s.displayScopeId,
    runId: captionCallActive(s.talk) ? s.talk.runId : undefined, presentation: s.presentation });
}
function broadcastLiveHud() {
  const state = getLiveHudState();
  syncPresentation(state);
  for (const win of [editor, output.window]) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try { win.webContents.send('live-hud:state', state); } catch { /* Renderer may be closing. */ }
  }
}

let drainedForQuit = false;
let quitPending = false;
function saveWindowBounds() {
  if (editor && !editor.isDestroyed()) settings?.update({ windowBounds: editor.getNormalBounds() });
}
app.on('before-quit', event => {
  quitting = true;
  clearPresentation();
  presentation.dispose();
  aspectSync.close();
  speechAudio.close();
  liveHud.close();
  demoHud.dispose();
  if (drainedForQuit) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  saveWindowBounds();
  // Drain first on the existing output queue. Disk I/O never blocks the GPU
  // event loop, and flush sees every successfully committed queued scene edit.
  void serial(() => output.stop()).then(() => settings?.flush()).then(() => {
    drainedForQuit = true;
    app.quit();
  }).catch(error => { console.error('Native drain failed during quit:', error); app.exit(1); });
});
app.on('window-all-closed', () => {});
app.on('activate', () => { if (editor && !editor.isDestroyed()) editor.show(); });

app.whenReady().then(async () => {
  if (!hasInstanceLock || quitting) return;
  settings = new SettingsStore(app.getPath('userData'), status => {
    if (editor && !editor.isDestroyed() && !editor.webContents.isDestroyed()) editor.webContents.send('settings:status', status);
  }, !verificationMode && !syntheticFixture);
  const saved = await settings.load();
  settingsLoaded = true;
  if (quitting) return;
  sceneState = { config: saved.scene, revision: 0, outputRevision: null };
  outputView.restore(saved.outputView);
  liveHudMode = verificationMode ? 'demo' : talkLaunchRequested ? 'live' : saved.hudSource;
  if (talkLaunchRequested && !verificationMode && !syntheticFixture) settings.update({ hudSource: 'live' });
  demoHud.setActive(liveHudMode === 'demo');
  const size = outputSize(saved.scene.aspectRatio);
  await output.setResolution(size.width, size.height);
  if (quitting) return;
  // Keep normal (not maximized/fullscreen) bounds visible after monitor changes.
  let bounds = saved.windowBounds;
  if (bounds) {
    const area = screen.getDisplayMatching(bounds).workArea;
    bounds = { width: Math.max(1000, Math.min(bounds.width, area.width)), height: Math.max(720, Math.min(bounds.height, area.height)),
      x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
      y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)) };
  }
  editor = new BrowserWindow({
    width: 1440, height: 920, ...bounds, minWidth: 1000, minHeight: 720,
    backgroundColor: '#0d1116', title: 'Pi Talk Webcam — Scene Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  editor.on('close', event => { if (!quitting) { saveWindowBounds(); event.preventDefault(); editor.hide(); } });
  editor.on('resize', () => { if (!quitting) saveWindowBounds(); });
  editor.on('move', () => { if (!quitting) saveWindowBounds(); });
  editor.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editor.webContents.on('will-navigate', event => {
    if (event.url !== editor.webContents.getURL()) event.preventDefault();
  });
  editor.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  editor.webContents.on('preload-error', (_event, _file, error) => console.error('Preload:', error));
  editor.webContents.on('console-message', details => {
    if (details.level === 'error') console.error('[editor]', details.message);
  });
  const actions = [
    { label: 'Show Editor', click: () => editor.show() },
    { label: 'Quit', click: () => app.quit() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: actions },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  // Text tray keeps Show/Quit reachable when the editor is closed, including Windows/Linux.
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==');
  tray = new Tray(icon);
  tray.setTitle('◈');
  tray.setToolTip('pi-talk-webcam');
  tray.setContextMenu(Menu.buildFromTemplate(actions));
  tray.on('double-click', () => editor.show());

  const handle = (channel: string, operation: () => unknown) => {
    ipcMain.handle(channel, (event) => {
      if (event.sender !== editor.webContents || event.senderFrame !== editor.webContents.mainFrame) {
        throw new Error('Unauthorized IPC sender');
      }
      return operation();
    });
  };
  // Scene configuration is shared; mutations are editor-only, acknowledgements output-only.
  const sceneSender = (event: Electron.IpcMainInvokeEvent, role: 'either' | 'editor' | 'output') => {
    const isEditor = event.sender === editor.webContents;
    const isOutput = !!output.window && event.sender === output.window.webContents;
    if (event.senderFrame !== event.sender.mainFrame || !(role === 'either' ? isEditor || isOutput : role === 'editor' ? isEditor : isOutput)) {
      throw new Error('Unauthorized scene IPC sender');
    }
  };
  const editorMutation = (event: Electron.IpcMainInvokeEvent) => {
    sceneSender(event, 'editor');
    if (quitting) throw new Error('App is quitting; preference edits are closed');
  };
  const editorBootstrap = (): EditorBootstrap => {
    const current = settings!.get();
    return { scene: sceneState, editor: current.editor,
      editorPose: current.editorPose ?? (current.outputView.mode === 'follow-editor' ? current.outputView.pose ?? null : null),
      settings: settings!.status() };
  };
  ipcMain.handle('settings:get', (event, ...args: unknown[]) => {
    sceneSender(event, 'editor');
    if (args.length) throw new Error('Settings getter takes no arguments');
    return editorBootstrap();
  });
  ipcMain.handle('settings:editor', (event, ...args: unknown[]) => {
    editorMutation(event);
    if (args.length !== 1) throw new Error('Editor preference update takes one argument');
    const preferences = validateEditorPreferences(args[0], settings!.get().editor);
    settings!.update({ editor: preferences });
    return preferences;
  });
  ipcMain.handle('live-hud:get', event => { sceneSender(event, 'either'); return getLiveHudState(); });
  ipcMain.handle('presentation:get', (event, ...args: unknown[]) => {
    sceneSender(event, 'either');
    if (args.length) throw new Error('Presentation getter takes no arguments');
    syncPresentation(getLiveHudState());
    return presentation.read();
  });
  ipcMain.handle('live-hud:mode', (event, mode: unknown) => {
    editorMutation(event);
    if (mode !== 'live' && mode !== 'demo') throw new Error('Invalid HUD mode');
    liveHudMode = mode;
    settings!.update({ hudSource: mode });
    demoHud.setActive(mode === 'demo');
    broadcastLiveHud();
    return getLiveHudState();
  });
  ipcMain.handle('live-hud:demo-update', (event, ...args: unknown[]) => {
    sceneSender(event, 'editor');
    if (args.length !== 1) throw new Error('Demo update takes one action');
    demoHud.update(args[0]);
    return getLiveHudState();
  });
  if (!verificationMode && !syntheticFixture) liveHud.start();
  ipcMain.handle('speech-audio:status', event => { sceneSender(event, 'either'); return speechAudio.getStatus(); });
  ipcMain.handle('output:view:get', event => { sceneSender(event, 'either'); return outputView.get(); });
  ipcMain.handle('output:view:set', (event, value: unknown) => {
    editorMutation(event);
    const state = outputView.set(value);
    settings!.update({ outputView: outputView.preferences() });
    return state;
  });
  ipcMain.handle('output:editor-pose', (event, value: unknown) => {
    editorMutation(event);
    const editorPose = outputView.editorPose(value);
    settings!.update({ editorPose, outputView: outputView.preferences() });
  });
  handle('output:preview', () => editor.isVisible() && !editor.isMinimized() ? output.previewFrame() : null);
  ipcMain.handle('scene:get', event => { sceneSender(event, 'either'); return sceneState; });
  ipcMain.handle('scene:set', (event, value: unknown, intent: unknown) => {
    editorMutation(event);
    const config = validateSceneConfig(value);
    if (intent !== undefined && (!intent || typeof intent !== 'object' || Array.isArray(intent)
      || Object.keys(intent).length !== 1 || typeof (intent as { aspectChange?: unknown }).aspectChange !== 'boolean')) {
      throw new Error('Invalid scene edit intent');
    }
    const aspectChange = (intent as { aspectChange: boolean } | undefined)?.aspectChange;
    // Explicit intent, not a comparison against the still-committed scene:
    // rapid portrait -> landscape edits must fence the earlier queued choice.
    if (aspectChange === true) aspectSync.studioAspectChanged(config.aspectRatio);
    return serial(() => applySceneConfig(aspectChange === false
      ? { ...config, aspectRatio: sceneState.config.aspectRatio } : config));
    // Legacy one-argument callers retain local full-config behavior, but cannot
    // trigger FaceTime UI mutations without explicitly declaring aspect intent.
  });
  ipcMain.handle('scene:applied', (event, revision: unknown) => {
    sceneSender(event, 'output');
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision > sceneState.revision) throw new Error('Invalid scene revision');
    if (sceneState.outputRevision === revision || (sceneState.outputRevision !== null && revision < sceneState.outputRevision)) return;
    sceneState = { ...sceneState, outputRevision: revision };
    broadcastScene();
  });
  handle('camera:status', () => cameraStatus());
  handle('camera:refresh', () => cameraStatus('refresh'));
  handle('camera:activate', () => cameraStatus('activate'));
  handle('camera:deactivate', () => cameraStatus('deactivate'));
  handle('renderer:status', () => rendererStatus());
  handle('renderer:start', () => {
    if (quitting) throw new Error('App is quitting');
    return serial(async () => { await output.start(process.env.CAPTURE_MODE === 'bitmap'); settings!.update({ outputStopped: false }); });
  });
  handle('renderer:stop', () => {
    if (quitting) throw new Error('App is quitting');
    return serial(async () => { await output.stop(); settings!.update({ outputStopped: true }); });
  });
  handle('renderer:capture', () => serial(async () => {
    const result = await dialog.showSaveDialog(editor, {
      defaultPath: path.join(app.getPath('pictures'), `pi-talk-scene-${Date.now()}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, await output.capturePNG());
    return result.filePath;
  }));
  handle('app:quit', () => { app.quit(); });
  await load(editor, 'ui');
  if (verificationMode) {
    const directory = path.resolve(process.env.VERIFY_ARTIFACT_DIR || 'artifacts');
    await mkdir(directory, { recursive: true });
    try {
      await verify(output, editor, directory);
      // Exercise the same explicit Quit IPC as the editor button.
      void editor.webContents.executeJavaScript('window.webcam.quit()').catch(() => {});
    } catch (error) {
      console.error('VERIFICATION FAILED', error);
      await writeFile(path.join(directory, 'failure.txt'), String(error));
      app.exit(1);
    }
  } else {
    // Startup uses the same queue as editor Start/Stop, including a stop received
    // during page load. Quit never clears the user's explicit stopped latch.
    if (!quitting) await serial(() => !quitting && !settings!.get().outputStopped ? output.start(process.env.CAPTURE_MODE === 'bitmap') : undefined);
    if (quitting) return;
    if (!syntheticFixture) void speechAudio.enable().catch(() => console.warn('Pi Talk virtual agent-speech input could not start.'));
    if (process.platform === 'darwin' && process.env.FACETIME_ASPECT_SYNC !== '0') aspectSync.start();
  }
}).catch(error => { console.error(error); app.exit(1); });
