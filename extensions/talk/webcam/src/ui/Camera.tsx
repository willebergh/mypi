import { useEffect, useState } from 'react';
import type { CameraStatus } from '../shared/types';

export default function Camera() {
  const [camera, setCamera] = useState<CameraStatus | null>(null);
  const [error, setError] = useState('');
  async function action(operation: () => Promise<CameraStatus>) {
    try { setCamera(await operation()); setError(''); }
    catch (failure) { setError(String(failure)); }
  }
  useEffect(() => {
    let live = true;
    const update = () => window.webcam.cameraStatus().then(status => { if (live) setCamera(status); })
      .catch(failure => { if (live) setError(String(failure)); });
    void update();
    const timer = setInterval(update, 1000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const pending = ['activating', 'deactivating', 'awaiting-approval'].includes(camera?.requestState ?? '');
  return <section>
    <h2>Pi Talk Webcam · virtual camera</h2>
    <dl>
      <dt>Extension bundled</dt><dd>{camera ? camera.bundled ? 'Yes' : 'No' : 'Checking…'}</dd>
      <dt>Installation</dt><dd>{camera?.installation ?? 'unknown'}</dd>
      <dt>Activation</dt><dd>{camera?.activation ?? 'unknown'}</dd>
      <dt>Request</dt><dd>{camera?.requestState ?? '—'}</dd>
      <dt>Signing team</dt><dd>{camera?.teamID || 'Unsigned / unavailable'}</dd>
    </dl>
    <div className="controls">
      <button disabled={!camera?.canRequest || pending} onClick={() => action(window.webcam.cameraActivate)}>Install / Activate</button>
      <button disabled={!camera?.canRequest || pending} onClick={() => action(window.webcam.cameraDeactivate)}>Deactivate / Remove</button>
      <button onClick={() => action(window.webcam.cameraRefresh)}>Refresh</button>
    </div>
    {camera?.instructions && <p>{camera.instructions}</p>}
    {(camera?.error || error) && <p role="alert">{camera?.error || error}</p>}
    {camera?.activation === 'awaiting-approval' && <p>Keep this app open. In System Settings → General → Login Items &amp; Extensions → Camera Extensions, enable Pi Talk Webcam. Follow any administrator approval prompt, then Refresh.</p>}
    {camera?.requestState === 'reboot-required' && <p>macOS requires a restart to complete this request. Save your work and restart when ready.</p>}
    <p>1280 × 720 · 30 FPS animated test pattern. Camera streaming starts and stops automatically when FaceTime (or another camera client) opens and closes it. Renderer controls above do not control the camera.</p>
    <p>After activation, reopen FaceTime and choose Video → Camera → Pi Talk Webcam (or Pi Talk Webcam directly in Video). No Screen Recording or Accessibility permission is needed.</p>
  </section>;
}
