import type { DesktopAPI as importDesktopAPI } from './desktop-screens';
import type { EditorBootstrap, EditorPreferences, SettingsStatus } from './settings';
import type { PresentationRendererAPI } from './presentation-feed';
import type { LiveHudState } from './live-protocol';
import type { DemoHudAction } from './demo-hud';
import type { CameraPose, OutputPreviewFrame, OutputViewRequest, OutputViewState } from './output-view';
import type { SpeechAudioStatus } from './audio';
import type { SceneAspectRatio, SceneConfig, SceneState } from './scene-config';

export interface FaceTimeAspectStatus {
  enabled: boolean;
  connected: boolean;
  available: boolean;
  observedAspect: SceneAspectRatio | null;
  desiredAspect: SceneAspectRatio;
  state: 'disabled' | 'offline' | 'unavailable' | 'following' | 'rotating' | 'error';
  error: string | null;
}

export interface NativeBridgeStatus {
  state: 'disabled' | 'unavailable' | 'idle' | 'running' | 'draining' | 'error';
  device: string;
  framesReceived: number;
  framesProcessed: number;
  droppedFrames: number;
  failedFrames: number;
  inFlight: number;
  maxInFlight: number;
  lastSequence: number;
  orderingErrors: number;
  averageCpuSubmitMs: number;
  averageGpuMs: number | null;
  averageNativeLatencyMs: number;
  averageCompletionMs: number;
  cpuSubmitTotalMs: number;
  gpuTotalMs: number;
  gpuTimedFrames: number;
  completionTotalMs: number;
  error: string | null;
  resources: { inFlight: number; sourceRetains: number; destinationTextures: number; readbackCount: number };
}

export interface RendererStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  mode: 'bitmap' | 'shared-texture';
  sharedTexture: string;
  error: string | null;
  native: NativeBridgeStatus;
  faceTimeAspect?: FaceTimeAspectStatus;
}
export interface CameraStatus {
  bundled: boolean;
  canRequest: boolean;
  installation: string;
  activation: string;
  requestState: string;
  teamID: string;
  error: string;
  instructions: string;
}

export interface WebcamAPI extends PresentationRendererAPI, importDesktopAPI {
  /** Editor-only bootstrap. Main has already loaded preferences before page creation. */
  getEditorSettings(): Promise<EditorBootstrap>;
  updateEditorPreferences(patch: Partial<EditorPreferences>): Promise<EditorPreferences>;
  onSettingsStatus(callback: (status: SettingsStatus) => void): () => void;
  getLiveHudState(): Promise<LiveHudState>;
  setLiveHudMode(mode: 'live' | 'demo'): Promise<LiveHudState>;
  /** Optional for renderer HMR against an older preload/main. Editor-only. */
  updateDemoHud?(action: DemoHudAction): Promise<LiveHudState>;
  onLiveHudState(callback: (state: LiveHudState) => void): () => void;
  getOutputPreview(): Promise<OutputPreviewFrame | null>;
  getOutputView(): Promise<OutputViewState>;
  setOutputView(request: OutputViewRequest): Promise<OutputViewState>;
  updateEditorPose(pose: CameraPose): Promise<void>;
  onOutputView(callback: (state: OutputViewState) => void): () => void;
  getSpeechAudioStatus(): Promise<SpeechAudioStatus>;
  onSpeechAudio(callback: (state: SpeechAudioStatus) => void): () => void;
  getStatus(): Promise<RendererStatus>;
  getSceneState(): Promise<SceneState>;
  setSceneConfig(config: SceneConfig, intent?: { aspectChange: boolean }): Promise<SceneState>;
  onSceneState(callback: (state: SceneState) => void): () => void;
  sceneApplied(revision: number): Promise<void>;
  cameraStatus(): Promise<CameraStatus>;
  cameraRefresh(): Promise<CameraStatus>;
  cameraActivate(): Promise<CameraStatus>;
  cameraDeactivate(): Promise<CameraStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  capture(): Promise<string | null>;
  quit(): Promise<void>;
  onStatus(callback: (status: RendererStatus) => void): () => void;
}
declare global { interface Window { webcam: WebcamAPI } }
