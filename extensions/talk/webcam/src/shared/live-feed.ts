import type { LiveHudState } from './live-protocol';
import type { WebcamAPI } from './types';
import { OFFLINE_LIVE_HUD, projectLiveHud } from './live-projection.ts';

type API = Pick<WebcamAPI, 'getLiveHudState' | 'onLiveHudState'>;
/** Subscribe before fetching, and fence the initial promise against ANY intervening event. */
export function createLiveHudFeed(api?: API) {
  let state = OFFLINE_LIVE_HUD, alive = true, version = 0, epoch = 0;
  const listeners = new Set<(state: LiveHudState) => void>();
  const accept = (next: LiveHudState) => {
    if (!alive) return;
    const before = state.snapshot, after = next.snapshot;
    // Preserve brief stop/reconnect/new-call edges even when they occur between animation frames.
    if (next.mode !== state.mode || next.connection !== state.connection
      || before?.streamId !== after?.streamId || before?.sessionId !== after?.sessionId
      || before?.talk.mode !== after?.talk.mode || before?.talk.runId !== after?.talk.runId
      || (before?.talk.voiceReady && !after?.talk.voiceReady)
      || (before && after && ['ready', 'connected'].includes(before.talk.phase) && !['ready', 'connected'].includes(after.talk.phase))
      || (before?.talk.elapsedMs !== undefined && after?.talk.elapsedMs !== undefined && after.talk.elapsedMs < before.talk.elapsedMs)) epoch++;
    state = next; version++;
    for (const listener of listeners) { try { listener(state); } catch { /* Isolate consumers. */ } }
  };
  const unsubscribe = api?.onLiveHudState(accept) ?? (() => {});
  const initialVersion = version;
  if (api) void api.getLiveHudState().then(next => {
    if (alive && initialVersion === version) accept(next);
  }).catch(() => { /* Offline is explicit; never fall back to demo. */ });
  return {
    read: () => state,
    snapshot: (time: number) => {
      const snapshot = projectLiveHud(state, time);
      snapshot.talk.generation = `${snapshot.talk.generation ?? 'demo'}/${epoch}`;
      return snapshot;
    },
    subscribe(listener: (state: LiveHudState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { alive = false; unsubscribe(); listeners.clear(); state = OFFLINE_LIVE_HUD; },
  };
}
let shared: ReturnType<typeof createLiveHudFeed> | undefined;
let users = 0;
/** One event/getter subscription per renderer, shared by UI and scene consumers. */
export function acquireLiveHudFeed() {
  if (!shared) {
    const api = typeof window !== 'undefined' ? window.webcam : undefined;
    shared = createLiveHudFeed(typeof api?.getLiveHudState === 'function' && typeof api.onLiveHudState === 'function' ? api : undefined);
  }
  users++;
  const feed = shared;
  let disposed = false;
  return { read: feed.read, snapshot: feed.snapshot, subscribe: feed.subscribe,
    dispose() { if (disposed) return; disposed = true; if (--users === 0) { feed.dispose(); shared = undefined; } } };
}
