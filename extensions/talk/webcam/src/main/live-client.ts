import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { LIVE_HUD_MAX_BYTES, LIVE_HUD_STALE_MS, type LiveHudState } from '../shared/live-protocol.ts';
import { parseLiveHudSnapshot } from '../shared/live-validation.ts';
import { activeLiveHudSnapshot, LIVE_HUD_MULTI_MAX_BYTES, parseLiveHudMultisession, type LiveHudMultisession } from '../shared/multisession-protocol.ts';

export function liveHudSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const expand = (value: string) => value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
  return env.PI_TALK_HUD_SOCKET ? expand(env.PI_TALK_HUD_SOCKET)
    : path.join(expand(env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent')), 'webcam', 'hud.sock');
}
/** A transient Talk-launched instance can retarget the existing app, not control calls/audio. */
export function talkLaunchSocket(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  return data.source === 'talk' && typeof data.socketPath === 'string'
    && data.socketPath.length <= 4096 && path.isAbsolute(data.socketPath)
    && !/[\u0000-\u001f\u007f]/u.test(data.socketPath) ? data.socketPath : null;
}
export interface LiveHudClientOptions {
  socketPath?: string;
  onState(state: LiveHudState): void;
  heartbeatMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
}
/** Receive-only private NDJSON socket. There is deliberately no send/request API. */
export function createLiveHudClient(options: LiveHudClientOptions) {
  const heartbeatMs = options.heartbeatMs ?? 500;
  const minMs = options.reconnectMinMs ?? 250, maxMs = options.reconnectMaxMs ?? 5000;
  for (const value of [heartbeatMs, minMs, maxMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('Invalid HUD timer');
  }
  if (heartbeatMs > 1000 || minMs > maxMs) throw new Error('Invalid HUD timer bounds');
  const now = options.now ?? Date.now;
  let state: LiveHudState = { mode: 'live', connection: 'offline', snapshot: null };
  let socket: Socket | null = null, started = false, closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let backoff = minMs, generation = 0;
  // Retain sequence fences across reconnects, with bounded generation history.
  const watermarks = new Map<string, number>();
  let currentKey: string | null = null;
  const publish = (connection: LiveHudState['connection'], snapshot: LiveHudState['snapshot'] = null, multisession?: LiveHudMultisession) => {
    state = { mode: 'live', connection, snapshot, ...(multisession ? { multisession } : {}) };
    try { options.onState(state); } catch { /* Consumer cannot break cleanup/reconnect. */ }
  };
  function freshSessions(value: LiveHudMultisession): LiveHudMultisession {
    return { ...value, sessions: value.sessions.map(row => ({ ...row, snapshot: row.snapshot
      && now() - row.snapshot.timestamp < LIVE_HUD_STALE_MS && row.snapshot.timestamp - now() <= 1000 ? row.snapshot : null })) };
  }
  function connect() {
    if (closed) return;
    const token = ++generation;
    let buffer = Buffer.alloc(0), lastAccepted = now();
    let ended = false;
    publish('connecting');
    if (closed) return;
    const peer = createConnection(options.socketPath ?? liveHudSocketPath());
    socket = peer;
    peer.unref();
    const fail = (connection: 'offline' | 'stale' | 'error') => {
      if (ended || closed || token !== generation) return;
      ended = true;
      buffer = Buffer.alloc(0);
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      peer.destroy();
      socket = null;
      publish(connection);
      if (closed) return;
      retry = setTimeout(connect, backoff);
      retry.unref();
      backoff = Math.min(maxMs, backoff * 2);
    };
    heartbeat = setInterval(() => {
      if (now() - lastAccepted >= LIVE_HUD_STALE_MS
        || (!state.multisession && state.snapshot && now() - state.snapshot.timestamp >= LIVE_HUD_STALE_MS)) { fail('stale'); return; }
      // Expire each conversation independently, even if the owner is still live.
      if (state.multisession) {
        const next = freshSessions(state.multisession);
        if (next.sessions.some((row, index) => row.snapshot !== state.multisession!.sessions[index]!.snapshot)) {
          publish('live', activeLiveHudSnapshot(next, now()), next);
        }
      }
    }, heartbeatMs);
    heartbeat.unref();
    peer.on('error', () => fail('offline'));
    peer.on('end', () => fail(buffer.length ? 'error' : 'offline'));
    peer.on('close', () => fail('offline'));
    peer.on('data', chunk => {
      if (ended || closed || token !== generation) return;
      // Process one bounded frame at a time; never concatenate an unbounded chunk.
      let offset = 0;
      while (offset < chunk.length && !ended && !closed && token === generation) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (buffer.length + end - offset > LIVE_HUD_MULTI_MAX_BYTES) { fail('error'); return; }
        buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
        offset = end + 1;
        if (newline < 0) return;
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
        catch { fail('error'); return; }
        const frameBytes = buffer.length;
        buffer = Buffer.alloc(0);
        const multi = parseLiveHudMultisession(value);
        if (!multi && frameBytes > LIVE_HUD_MAX_BYTES) { fail('error'); return; }
        const snapshot = multi ? null : parseLiveHudSnapshot(value);
        const clock = multi ?? snapshot;
        if (!clock) { fail('error'); return; }
        const key = multi ? JSON.stringify(['multi', multi.streamId])
          : JSON.stringify([snapshot!.streamId, snapshot!.sessionId]);
        const watermark = watermarks.get(key);
        // A retired generation may not resurrect, even with a higher sequence.
        if ((watermark !== undefined && key !== currentKey) || (watermark !== undefined && clock.sequence <= watermark)) continue;
        if (now() - clock.timestamp >= LIVE_HUD_STALE_MS) { fail('stale'); return; }
        if (clock.timestamp - now() > 1000) { fail('error'); return; }
        // Fail closed rather than evicting a fence and allowing an old generation to replay.
        if (!watermarks.has(key) && watermarks.size >= 128) { fail('error'); return; }
        watermarks.set(key, clock.sequence);
        currentKey = key;
        lastAccepted = now();
        backoff = minMs;
        if (multi) { const next = freshSessions(multi); publish('live', activeLiveHudSnapshot(next, now()), next); }
        else publish('live', snapshot);
      }
    });
  }
  return {
    getState: () => state,
    start() { if (started || closed) return; started = true; connect(); },
    close() {
      if (closed) return;
      closed = true; generation++;
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      retry = heartbeat = undefined;
      socket?.destroy(); socket = null;
      watermarks.clear(); currentKey = null;
      publish('offline');
    },
  };
}
