import { useEffect, useRef, useState } from 'react';
import type { OutputPreviewFrame } from '../shared/output-view';
import type { SceneConfig } from '../shared/scene-config';
import type { RendererStatus } from '../shared/types';

export function isMissingOutputHandler(error: unknown) {
  return /no handler registered|not a function|unknown (?:ipc|channel|method)/i.test(String(error));
}

interface Props {
  aspectRatio: SceneConfig['aspectRatio'];
  rendererState: RendererStatus['state'] | undefined;
  visible: boolean;
  unavailable: boolean;
  onUnavailable: () => void;
}

export default function OutputMonitor({ aspectRatio, rendererState, visible, unavailable, onUnavailable }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  // Shared across effect restarts: an old IPC request must finish before another begins.
  const inFlight = useRef(false);
  const [frame, setFrame] = useState<OutputPreviewFrame | null>(null);
  const [message, setMessage] = useState('Waiting for camera source…');

  useEffect(() => {
    setFrame(null);
    if (typeof window.webcam.getOutputPreview !== 'function') {
      onUnavailable();
      return;
    }
    if (!visible || unavailable || rendererState !== 'running') return;
    let disposed = false;
    let intersects = false;
    let visibilityGeneration = 0;
    const element = mount.current!;
    const isVisible = () => {
      const rect = element.getBoundingClientRect();
      return !document.hidden && intersects && element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    };
    const clear = () => {
      visibilityGeneration++;
      setFrame(null);
      setMessage('Waiting for camera source…');
    };
    const poll = async () => {
      if (disposed || inFlight.current || !isVisible()) return;
      inFlight.current = true;
      const generation = visibilityGeneration;
      try {
        const next = await window.webcam.getOutputPreview();
        if (disposed || generation !== visibilityGeneration || !isVisible()) return;
        setFrame(next);
        setMessage(next ? '' : 'No output frame · waiting for renderer');
      } catch (error) {
        if (disposed) return;
        setFrame(null);
        setMessage('Monitor disconnected');
        if (isMissingOutputHandler(error)) onUnavailable();
      } finally {
        inFlight.current = false;
      }
    };
    const observer = new IntersectionObserver(entries => {
      intersects = entries.some(entry => entry.isIntersecting);
      if (!intersects) clear();
    });
    observer.observe(element);
    const onVisibility = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', onVisibility);
    // No immediate extra requests on visibility changes; at most four polls per second.
    setMessage('Waiting for camera source…');
    const timer = window.setInterval(() => { void poll(); }, 250);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [aspectRatio, rendererState, visible, unavailable, onUnavailable]);

  const stateMessage = unavailable ? 'Monitor unavailable' : rendererState === 'stopped' ? 'Output stopped'
    : rendererState === 'error' ? 'Output disconnected' : rendererState === 'starting' ? 'Starting output…'
      : rendererState === undefined ? 'Connecting to output…' : message;
  const showFrame = frame && rendererState === 'running' && !unavailable && visible;
  return <section className="viewport-card output-monitor" hidden={!visible} aria-label="Actual camera-source output">
    <div className="view-card-heading"><h2>OUTPUT</h2><span>Camera source · sampled 4 FPS</span></div>
    <div className="viewport-well" ref={mount}>
      <div className="preview-frame output-frame" data-aspect={aspectRatio}>
        {showFrame ? <img src={frame.dataUrl} alt="Actual hidden-renderer camera source" onError={() => {
          setFrame(null); setMessage('Monitor disconnected · image unavailable');
        }} /> : <div className="monitor-placeholder" role="status">{stateMessage}</div>}
      </div>
    </div>
    <p className="view-card-note">Before camera transport. FaceTime may crop or process this image.</p>
  </section>;
}
