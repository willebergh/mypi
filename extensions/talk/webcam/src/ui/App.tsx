import { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererStatus } from '../shared/types';
import type { EditorBootstrap, EditorPreferences } from '../shared/settings';
import type { SceneConfig } from '../shared/scene-config';
import type { SceneStats } from '../avatar/scene';
import ScenePreview, { type PreviewHandle } from './ScenePreview';
import { useSceneConfig } from './useSceneConfig';
import SpeechAudio from './SpeechAudio';
import OutputMonitor from './OutputMonitor';
import OutputViewControls from './OutputViewControls';
import InspectorSections from './InspectorSections';
import WorkspaceToolbar from './WorkspaceToolbar';
import SessionList from './SessionList';
import { acquireLiveHudFeed } from '../shared/live-feed';
import { OFFLINE_LIVE_HUD } from '../shared/live-projection';

export default function App({ initial }: { initial: EditorBootstrap }) {
  const [settingsStatus, setSettingsStatus] = useState(initial.settings);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.webcam.onSettingsStatus(status => { if (live) setSettingsStatus(status); });
    // Subscribe then read: include a save failure between initial bootstrap and mount.
    void window.webcam.getEditorSettings().then(value => { if (live) setSettingsStatus(value.settings); }).catch(failure => {
      if (live) setSettingsStatus(previous => ({ ...previous, warning: `Preferences status unavailable: ${String(failure)}` }));
    });
    return () => { live = false; unsubscribe(); };
  }, []);
  const [liveHud, setLiveHud] = useState(OFFLINE_LIVE_HUD);
  useEffect(() => {
    const feed = acquireLiveHudFeed();
    const unsubscribe = feed.subscribe(setLiveHud);
    setLiveHud(feed.read());
    return () => { unsubscribe(); feed.dispose(); };
  }, []);
  const [status, setStatus] = useState<RendererStatus | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [sceneError, setSceneError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [editorPreferences, setEditorPreferences] = useState(initial.editor);
  const visibleViews = editorPreferences.visibleViews;
  // Event-only writes: mounting/HMR never sends initial UI defaults back to main.
  function updateEditorPreferences(patch: Partial<EditorPreferences>) {
    setEditorPreferences(previous => ({ ...previous, ...patch }));
    void window.webcam.updateEditorPreferences(patch).catch(failure => setMessage(`Workspace preference was not applied: ${String(failure)}`));
  }
  const [outputViewUnavailable, setOutputViewUnavailable] = useState(false);
  const markOutputViewUnavailable = useCallback(() => setOutputViewUnavailable(true), []);
  const { config, state, error, edit } = useSceneConfig(initial.scene);
  const preview = useRef<PreviewHandle>(null);
  const getCameraPose = useCallback(() => preview.current?.getCameraPose?.() ?? null, []);
  useEffect(() => {
    const unsubscribe = window.webcam.onStatus(setStatus);
    window.webcam.getStatus().then(setStatus).catch(failure => setMessage(String(failure)));
    return unsubscribe;
  }, []);
  const change = <K extends keyof SceneConfig>(key: K, value: SceneConfig[K]) => edit({ ...config, [key]: value });
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setMessage('');
    try { await operation(); } catch (failure) { setMessage(String(failure)); }
    finally { setBusy(false); }
  }
  const running = status?.state === 'running';
  const synchronized = !!state && state.outputRevision === state.revision;
  const canChangeAspect = state?.config.aspectRatio === '16:9' || state?.config.aspectRatio === '9:16';
  return <main className="studio">
    <WorkspaceToolbar status={status} aspectRatio={config.aspectRatio} synchronized={synchronized} busy={busy} diagnostics={diagnostics}
      onToggleOutput={() => void action(() => running ? window.webcam.stop() : window.webcam.start())}
      onCapture={() => void action(async () => { const saved = await window.webcam.capture(); if (saved) setMessage(`Output saved: ${saved}`); })}
      onDiagnostics={() => setDiagnostics(!diagnostics)} onQuit={() => void action(() => window.webcam.quit())} />
    <div className="workspace">
      <section className="viewport-panel" aria-label="Preview workspace">
        <div className="workspace-notices" aria-label="Workspace notices">
          {settingsStatus.warning && <p className="status-message" role="alert"><strong>Saved preferences{settingsStatus.readOnly ? ' · read only' : ''}</strong>{settingsStatus.warning}</p>}
          {sceneError && <p className="status-message" role="alert"><strong>Editor renderer</strong>{sceneError}</p>}
          {error && <p className="status-message" role="alert"><strong>Scene settings</strong>{error}</p>}
          {status?.error && <p className="status-message" role="alert"><strong>Output</strong>{status.error}</p>}
          {status?.native.error && <p className="status-message" role="alert"><strong>Camera transport</strong>{status.native.error}</p>}
          {message && <p className="status-message action-message" role="status"><strong>Action</strong>{message}</p>}
          {outputViewUnavailable && <p className="status-message" role="status"><strong>Output monitor & framing</strong>Restart Electron once to enable the camera-source monitor and output framing controls.</p>}
        </div>
        <div className="preview-toolbar">
          <div className="view-selector" role="group" aria-label="Visible views">
            {(['editor', 'output', 'both'] as const).map(view => <button key={view} aria-pressed={visibleViews === view} onClick={() => updateEditorPreferences({ visibleViews: view })}>{view === 'both' ? 'Both' : view === 'editor' ? 'Editor' : 'Output'}</button>)}
          </div>
          <div className="format-control"><span id="format-label">Format</span><div className="aspect-selector" role="group" aria-labelledby="format-label">
            <button disabled={!canChangeAspect} aria-pressed={config.aspectRatio !== '9:16'} onClick={() => change('aspectRatio', '16:9')}>16:9 <span>Landscape</span></button>
            <button disabled={!canChangeAspect} aria-pressed={config.aspectRatio === '9:16'} onClick={() => change('aspectRatio', '9:16')}>9:16 <span>Portrait</span></button>
          </div></div>
        </div>
        <OutputViewControls getCameraPose={getCameraPose} unavailable={outputViewUnavailable} onUnavailable={markOutputViewUnavailable} />
        <div className="viewport-grid" data-view={visibleViews}>
          {/* Keep the renderer and its orbit controls alive in every workspace/inspector mode. */}
          <section className="viewport-card editor-view" hidden={visibleViews === 'output'} aria-label="Editor orbit preview">
            <div className="view-card-heading"><h2>Editor</h2><span>Orbit preview · not the camera feed</span></div>
            <div className="viewport-well">
              <div className="preview-frame" data-aspect={config.aspectRatio} data-camera-position={stats?.cameraPosition.join(',')} data-preview-fps={stats?.fps} data-draw-calls={stats?.drawCalls} data-triangles={stats?.triangles}>
                <ScenePreview ref={preview} config={config} initialPose={initial.editorPose} onStats={setStats} onError={setSceneError} />
              </div>
            </div>
            <div className="viewport-tools"><span className="mouse-hint">Drag to orbit · Scroll to zoom · Shift + drag to pan</span><button className="quiet-button" data-testid="reset-camera" onClick={() => preview.current?.resetCamera()}>↺ Reset camera</button></div>
          </section>
          <OutputMonitor aspectRatio={config.aspectRatio} rendererState={status?.state} visible={visibleViews !== 'editor'} unavailable={outputViewUnavailable} onUnavailable={markOutputViewUnavailable} />
        </div>
        <p className="workspace-lifecycle-note">Closing this window hides only the editor. Output runs independently; Quit stops the app.</p>
      </section>
      <aside className="settings-panel" aria-label="Scene inspector">
        <InspectorSections section={editorPreferences.inspectorSection} onSectionChange={inspectorSection => updateEditorPreferences({ inspectorSection })} config={config} state={state} change={change} edit={edit} liveHud={liveHud} onModeChange={mode => { void action(() => window.webcam.setLiveHudMode(mode)); }} />
        <div className="operational-status" aria-label="Feed and speech health">
          <div className="feed-status" role="status"><span>Pi feed</span><strong className={liveHud.mode === 'live' && liveHud.connection === 'live' ? 'is-live' : ''}>{liveHud.mode === 'demo' ? 'Demo · authored data' : liveHud.connection === 'live' ? 'Live · read only' : liveHud.connection}</strong></div>
          <SessionList state={liveHud} />
          {/* Always mounted: speech owns race guards and a bounded diagnostic lifecycle. */}
          <SpeechAudio />
        </div>
      </aside>
    </div>
    {diagnostics && <div className="diagnostic-backdrop" onClick={() => setDiagnostics(false)}><section className="diagnostic-dialog" role="dialog" aria-modal="true" aria-label="Renderer diagnostics" onClick={event => event.stopPropagation()}>
      <div className="diagnostic-heading"><h2>Diagnostics</h2><button onClick={() => setDiagnostics(false)}>Close</button></div>
      <dl>
        <dt>Output state</dt><dd>{status?.state ?? 'Connecting'}</dd>
        <dt>Output transport</dt><dd>{status?.mode === 'shared-texture' ? 'IOSurface → Metal' : status?.mode ?? '—'}</dd>
        <dt>Output frames</dt><dd>{status?.frameCount.toLocaleString() ?? '—'}</dd>
        <dt>Settings synchronization</dt><dd>{running ? synchronized ? 'Synchronized' : 'Applying to output…' : 'Output stopped · settings retained'}</dd>
        <dt>Scene / output revision</dt><dd>r{state?.revision ?? '—'} / {state?.outputRevision == null ? '—' : `r${state.outputRevision}`}</dd>
        <dt>Editor FPS</dt><dd>{stats?.fps.toFixed(0) ?? '—'}</dd>
        <dt>Draws / triangles</dt><dd>{stats?.drawCalls ?? '—'} / {stats?.triangles.toLocaleString() ?? '—'}</dd>
        <dt>Bridge state</dt><dd>{status?.native.state}</dd><dt>GPU</dt><dd>{status?.native.device}</dd>
        <dt>Received / processed</dt><dd>{status?.native.framesReceived} / {status?.native.framesProcessed}</dd>
        <dt>Dropped / failed</dt><dd>{status?.native.droppedFrames} / {status?.native.failedFrames}</dd>
        <dt>CPU submission</dt><dd>{status?.native.averageCpuSubmitMs.toFixed(3)} ms</dd>
        <dt>GPU blit</dt><dd>{status?.native.averageGpuMs?.toFixed(3) ?? 'unavailable'} ms</dd>
        <dt>Paint → completion</dt><dd>{status?.native.averageCompletionMs.toFixed(3)} ms</dd>
        <dt>In flight / bound</dt><dd>{status?.native.inFlight} / 1</dd>
        <dt>Resources</dt><dd>{status?.native.resources.sourceRetains} source · {status?.native.resources.destinationTextures} destination</dd>
      </dl>
      <p>{status?.sharedTexture}</p>{status?.native.error && <p role="alert">{status.native.error}</p>}
      <p className="panel-note">Completion timing is main-process paint to native callback—not render-to-camera latency. The preview is before camera transport and does not verify a receiving app.</p>
    </section></div>}
  </main>;
}
