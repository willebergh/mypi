import { desktopDisplayIds, type DesktopAPI, type DesktopState } from './desktop-screens';

/** One serial request pipeline, at most four unique streams; stale results are stopped before use. */
export function createDesktopCapture(api: DesktopAPI | undefined, capture: () => Promise<MediaStream>, changed: (streams: ReadonlyMap<string, MediaStream>, state: DesktopState | null) => void) {
  let state: DesktopState | null = null, desk = false, disposed = false, generation = 0, busy = false;
  const streams = new Map<string, MediaStream>();
  const tokens = new Map<string, string>();
  const attempted = new Set<string>();
  const notify = () => changed(streams, state);
  const report = (status: 'off' | 'starting' | 'live' | 'unavailable') => { if (api && state) void api.desktopCaptureStatus(status, state.revision).catch(() => {}); };
  const release = (token: string) => { void api?.releaseDesktopCapture(token).catch(() => {}); };
  function clear() {
    generation++;
    for (const stream of streams.values()) stream.getTracks().forEach(track => track.stop());
    streams.clear();
    for (const token of tokens.values()) release(token);
    tokens.clear(); attempted.clear(); notify();
  }
  const active = () => !disposed && desk && !!state?.enabled;
  async function pump() {
    if (busy || !api || !active()) return;
    busy = true;
    const epoch = generation, revision = state!.revision;
    try {
      for (const id of desktopDisplayIds(state!.mapping)) {
        if (epoch !== generation || !active()) break;
        if (attempted.has(id)) continue;
        attempted.add(id); report('starting');
        let token: string | undefined, stream: MediaStream | undefined;
        try {
          token = await api.prepareDesktopCapture(id, revision);
          if (epoch !== generation || !active()) { release(token); continue; }
          stream = await capture();
          if (epoch !== generation || !active()) { stream.getTracks().forEach(t => t.stop()); release(token); continue; }
          if (stream.getAudioTracks().length || stream.getVideoTracks().length !== 1 || stream.getVideoTracks()[0].readyState !== 'live') throw new Error('Invalid video stream');
          const track = stream.getVideoTracks()[0];
          streams.set(id, stream); tokens.set(id, token);
          track.addEventListener('ended', () => {
            if (streams.get(id) !== stream) return;
            stream!.getTracks().forEach(t => t.stop()); streams.delete(id); tokens.delete(id); release(token!); notify(); report('unavailable');
          }, { once: true });
          notify();
        } catch {
          stream?.getTracks().forEach(t => t.stop());
          if (token) release(token);
        }
      }
      if (epoch === generation && active()) report(streams.size === desktopDisplayIds(state!.mapping).length && streams.size > 0 ? 'live' : 'unavailable');
    } finally { busy = false; if (epoch !== generation) void pump(); }
  }
  function accept(next: DesktopState) {
    if (disposed || (state && next.revision < state.revision)) return;
    if (!state || next.revision !== state.revision) { state = next; clear(); void pump(); }
  }
  const unsubscribe = api?.onDesktopState(accept);
  void api?.getDesktopState().then(accept).catch(() => {});
  return {
    setScene(id: string) { const next = id === 'desk'; if (desk === next) return; desk = next; clear(); if (desk) void pump(); else report('off'); },
    dispose() { if (disposed) return; disposed = true; unsubscribe?.(); clear(); report('off'); },
  };
}
