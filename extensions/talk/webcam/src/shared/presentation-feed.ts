import type { PreparedPresentation } from './presentation-protocol';

/** Dedicated main/preload channel, not LiveHudState: image bytes never enter the
 * 128 KiB periodic socket snapshots. Implement later on the allowlisted API. */
export interface PresentationRendererAPI {
  getCallPresentation(): Promise<PreparedPresentation | null>;
  onCallPresentation(callback: (value: PreparedPresentation | null) => void): () => void;
}
/** One feed per scene/renderer. Subscribe BEFORE initial getter and fence that
 * getter against every event, including null, so stale initial images cannot win. */
export function createPresentationFeed(api?: PresentationRendererAPI) {
  let current: PreparedPresentation | null = null, alive = true, version = 0;
  const listeners = new Set<(value: PreparedPresentation | null) => void>();
  function accept(value: PreparedPresentation | null) {
    if (!alive) return;
    current = value; version++;
    for (const listener of listeners) { try { listener(current); } catch { /* Isolate consumers. */ } }
  }
  const unsubscribe = api?.onCallPresentation(accept) ?? (() => {});
  const initialVersion = version;
  if (api) void api.getCallPresentation().then(value => {
    if (alive && version === initialVersion) accept(value);
  }).catch(() => { /* Remain blank; never fall back to demo or a previous image. */ });
  return {
    /** Treat returned DTO as immutable. No copies of multi-MB data URLs each frame. */
    read: () => current,
    subscribe(listener: (value: PreparedPresentation | null) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() { if (!alive) return; alive = false; unsubscribe(); current = null; listeners.clear(); },
  };
}
