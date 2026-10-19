import { contextBridge, ipcRenderer } from 'electron';
import type { SettingsStatus } from '../shared/settings';
import type { WebcamAPI, RendererStatus } from '../shared/types';
import type { OutputViewState } from '../shared/output-view';
import type { SpeechAudioStatus } from '../shared/audio';
import type { SceneState } from '../shared/scene-config';
import type { LiveHudState } from '../shared/live-protocol';
import type { PreparedPresentation } from '../shared/presentation-protocol';
const api: WebcamAPI = {
  getEditorSettings: () => ipcRenderer.invoke('settings:get'),
  updateEditorPreferences: patch => ipcRenderer.invoke('settings:editor', patch),
  onSettingsStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, status: SettingsStatus) => callback(status);
    ipcRenderer.on('settings:status', listener);
    return () => ipcRenderer.removeListener('settings:status', listener);
  },
  getCallPresentation: () => ipcRenderer.invoke('presentation:get'),
  onCallPresentation(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: PreparedPresentation | null) => callback(value);
    ipcRenderer.on('presentation:state', listener);
    return () => ipcRenderer.removeListener('presentation:state', listener);
  },
  getLiveHudState: () => ipcRenderer.invoke('live-hud:get'),
  setLiveHudMode: mode => ipcRenderer.invoke('live-hud:mode', mode),
  updateDemoHud: action => ipcRenderer.invoke('live-hud:demo-update', action),
  onLiveHudState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: LiveHudState) => callback(state);
    ipcRenderer.on('live-hud:state', listener);
    return () => ipcRenderer.removeListener('live-hud:state', listener);
  },
  getOutputPreview: () => ipcRenderer.invoke('output:preview'),
  getOutputView: () => ipcRenderer.invoke('output:view:get'),
  setOutputView: request => ipcRenderer.invoke('output:view:set', request),
  updateEditorPose: pose => ipcRenderer.invoke('output:editor-pose', pose),
  onOutputView(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: OutputViewState) => callback(state);
    ipcRenderer.on('output:view', listener);
    return () => ipcRenderer.removeListener('output:view', listener);
  },
  getSpeechAudioStatus: () => ipcRenderer.invoke('speech-audio:status'),
  onSpeechAudio(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: SpeechAudioStatus) => callback(state);
    ipcRenderer.on('speech-audio:state', listener);
    return () => ipcRenderer.removeListener('speech-audio:state', listener);
  },
  getStatus: () => ipcRenderer.invoke('renderer:status'),
  getSceneState: () => ipcRenderer.invoke('scene:get'),
  setSceneConfig: (config, intent) => ipcRenderer.invoke('scene:set', config, intent),
  sceneApplied: revision => ipcRenderer.invoke('scene:applied', revision),
  onSceneState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: SceneState) => callback(state);
    ipcRenderer.on('scene:state', listener);
    return () => ipcRenderer.removeListener('scene:state', listener);
  },
  cameraStatus: () => ipcRenderer.invoke('camera:status'),
  cameraRefresh: () => ipcRenderer.invoke('camera:refresh'),
  cameraActivate: () => ipcRenderer.invoke('camera:activate'),
  cameraDeactivate: () => ipcRenderer.invoke('camera:deactivate'),
  start: () => ipcRenderer.invoke('renderer:start'),
  stop: () => ipcRenderer.invoke('renderer:stop'),
  capture: () => ipcRenderer.invoke('renderer:capture'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, status: RendererStatus) => callback(status);
    ipcRenderer.on('renderer:status', listener);
    return () => ipcRenderer.removeListener('renderer:status', listener);
  },
};
contextBridge.exposeInMainWorld('webcam', api);
