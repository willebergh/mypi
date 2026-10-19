import type { RendererStatus } from '../shared/types';
import { outputSize, type SceneConfig } from '../shared/scene-config';

interface Props {
  status: RendererStatus | null;
  aspectRatio: SceneConfig['aspectRatio'];
  synchronized: boolean;
  busy: boolean;
  diagnostics: boolean;
  onToggleOutput: () => void;
  onCapture: () => void;
  onDiagnostics: () => void;
  onQuit: () => void;
}

export default function WorkspaceToolbar({ status, aspectRatio, synchronized, busy, diagnostics, onToggleOutput, onCapture, onDiagnostics, onQuit }: Props) {
  const running = status?.state === 'running';
  const size = running && status && status.width > 0 && status.height > 0 ? status : outputSize(aspectRatio);
  const label = running ? 'Output running' : status?.state === 'starting' ? 'Starting output…' : status?.state === 'stopped' ? 'Output stopped' : status?.state === 'error' ? 'Output error' : 'Connecting…';
  return <header className="app-header">
    <h1 className="brand">Webcam Studio</h1>
    <div className="output-status" role="status">
      <span className={`status-dot ${running ? 'is-running' : ''}`} />
      <div><strong>{label}</strong><span className="output-metrics">{size.width} × {size.height}<i />{running ? status?.fps.toFixed(1) : '—'} FPS{running && !synchronized && <span className="output-applying"> · Applying settings…</span>}</span></div>
    </div>
    <div className="header-actions">
      <button className={running ? 'stop-button' : 'start-button'} disabled={busy || status?.state === 'starting'} onClick={onToggleOutput}>{running ? 'Stop output' : 'Start output'}</button>
      <button className="capture-button" disabled={busy || !running} onClick={onCapture}>Capture output PNG</button>
      <button className="quiet-button" aria-pressed={diagnostics} onClick={onDiagnostics}>Diagnostics</button>
      <button className="quiet-button quit-button" disabled={busy} title="Quit the app and stop output. Closing the window only hides the editor." onClick={onQuit}>Quit</button>
    </div>
  </header>;
}
