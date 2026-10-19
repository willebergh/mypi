import { useEffect, useRef, useState } from 'react';
import type { CameraPose, OutputViewMode, OutputViewState } from '../shared/output-view';
import { isMissingOutputHandler } from './OutputMonitor';

interface Props {
  getCameraPose: () => CameraPose | null;
  unavailable: boolean;
  onUnavailable: () => void;
}

export default function OutputViewControls({ getCameraPose, unavailable, onUnavailable }: Props) {
  const [view, setView] = useState<OutputViewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  const accept = (next: OutputViewState) => setView(current => !current || next.revision >= current.revision ? next : current);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const api = window.webcam;
    if (typeof api.getOutputView !== 'function' || typeof api.setOutputView !== 'function' || typeof api.onOutputView !== 'function') {
      onUnavailable();
    } else {
      try {
        unsubscribe = api.onOutputView(next => { if (!disposed) accept(next); });
        void api.getOutputView().then(next => { if (!disposed) accept(next); }).catch(failure => {
          if (disposed) return;
          if (isMissingOutputHandler(failure)) onUnavailable();
          else setError(`Framing unavailable: ${String(failure)}`);
        });
      } catch (failure) {
        if (isMissingOutputHandler(failure)) onUnavailable();
        else setError(`Framing unavailable: ${String(failure)}`);
      }
    }
    return () => { disposed = true; mounted.current = false; unsubscribe?.(); };
  }, [onUnavailable]);

  async function select(mode: OutputViewMode) {
    if (pending.current || unavailable) return;
    if (typeof window.webcam.setOutputView !== 'function') { onUnavailable(); return; }
    const pose = mode === 'hero' ? null : getCameraPose();
    if (mode !== 'hero' && !pose) { setError('Wait for the editor camera to finish loading.'); return; }
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await window.webcam.setOutputView(mode === 'hero' ? { mode } : { mode, pose: pose! });
      if (mounted.current) accept(next);
    } catch (failure) {
      if (!mounted.current) return;
      if (isMissingOutputHandler(failure)) onUnavailable();
      else setError(String(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const disabled = unavailable || busy || !view;
  return <fieldset className="output-view-settings" aria-busy={busy}>
    <legend>Output framing</legend>
    <div className="framing-options" role="group" aria-label="Camera output framing">
      <button disabled={disabled} aria-pressed={view?.mode === 'hero'} onClick={() => void select('hero')}>Fixed hero</button>
      <button disabled={disabled} aria-pressed={view?.mode === 'follow-editor'} onClick={() => void select('follow-editor')}>Follow editor</button>
      <button className="use-current-view" disabled={disabled} aria-pressed={view?.mode === 'custom'} onClick={() => void select('custom')}>Use current view</button>
    </div>
    <p className="framing-description">{unavailable ? 'Output framing requires the updated app backend.'
      : !view ? 'Connecting to output framing…'
        : view.mode === 'follow-editor' ? 'Camera output follows the editor’s orbit, zoom and pan.'
          : view.mode === 'custom' ? 'Saved editor framing. Orbiting now changes only the editor.'
            : 'Camera output uses the fixed hero view. Orbiting changes only the editor.'}</p>
    <p className="framing-hint">Use current view saves framing, not a still image. Animation continues.</p>
    {error && !unavailable && <p className="framing-error" role="status">{error}</p>}
  </fieldset>;
}
