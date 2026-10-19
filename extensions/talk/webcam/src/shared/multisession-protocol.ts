import { captionCallActive, idleTalkVisual, LIVE_HUD_MAX_BYTES, LIVE_HUD_STALE_MS, type LiveHudSnapshot } from './live-protocol.ts';
import { parsePresentation } from './presentation-protocol.ts';
import { parseLiveHudSnapshot } from './live-validation.ts';

/** Separate wire envelope: identity NEVER extends the legacy v1 snapshot. */
export const LIVE_HUD_MULTI_VERSION = 2;
/** Main publisher plus Talk's 64 bounded destinations. */
export const LIVE_HUD_MAX_SESSIONS = 65;
export const LIVE_HUD_MULTI_MAX_BYTES = LIVE_HUD_MAX_SESSIONS * LIVE_HUD_MAX_BYTES + 512 * 1024;
export interface LiveHudSession {
  instanceId: string;
  sessionId: string;
  name: string;
  /** Explicitly consented absolute working directory, not inferred from tool data. */
  cwd: string;
  isMain: boolean;
  isActive: boolean;
  /** Full existing bounded projection, or null while unavailable/revoked/stale. */
  snapshot: LiveHudSnapshot | null;
}
export interface LiveHudMultisession {
  version: 2;
  /** The main publisher's generation/clock, independent of conversation switching. */
  streamId: string;
  sequence: number;
  timestamp: number;
  mainSessionId: string;
  /** May be absent from sessions after disconnection; NEVER fall back to main. */
  activeSessionId: string;
  sessions: LiveHudSession[];
}
export interface WebcamMultisession {
  mainSessionId: string;
  activeSessionId: string;
  /** Only explicitly opted-in connected sessions belong here. Full replacement. */
  sessions: Omit<LiveHudSession, 'isActive'>[];
}
const encoder = new TextEncoder();
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string'
  && (empty || v.length > 0) && v.length <= max && encoder.encode(v).byteLength <= max
  && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\p{Cs}]/u.test(v);
const sessionId = (v: unknown): v is string => text(v, 1024) && v.length <= 256;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** Descriptor allowlist: do not invoke getters, accept prototypes or retain input references. */
function record(v: unknown, keys: string[]): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return null;
  const fields = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(fields).length !== keys.length || Reflect.ownKeys(fields).some(k => typeof k !== 'string' || !keys.includes(k))) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = fields[key];
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) return null;
    result[key] = field.value;
  }
  return result;
}
export function parseLiveHudMultisession(value: unknown): LiveHudMultisession | null {
  try {
    const root = record(value, ['version', 'streamId', 'sequence', 'timestamp', 'mainSessionId', 'activeSessionId', 'sessions']);
    if (!root || root.version !== 2 || !text(root.streamId, 128) || !count(root.sequence) || !count(root.timestamp)
      || !sessionId(root.mainSessionId) || !sessionId(root.activeSessionId) || !Array.isArray(root.sessions)
      || root.sessions.length > LIVE_HUD_MAX_SESSIONS) return null;
    const sessions: LiveHudSession[] = [];
    const ids = new Set<string>(), instances = new Set<string>();
    for (const raw of root.sessions) {
      const row = record(raw, ['instanceId', 'sessionId', 'name', 'cwd', 'isMain', 'isActive', 'snapshot']);
      if (!row || !text(row.instanceId, 128) || !sessionId(row.sessionId) || !text(row.name, 256, true)
        || !text(row.cwd, 4096) || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\]+\\)/.test(row.cwd)
        || typeof row.isMain !== 'boolean' || typeof row.isActive !== 'boolean'
        || row.isMain !== (row.sessionId === root.mainSessionId) || row.isActive !== (row.sessionId === root.activeSessionId)
        || ids.has(row.sessionId) || instances.has(row.instanceId)) return null;
      const snapshot = row.snapshot === null ? null : parseLiveHudSnapshot(row.snapshot);
      if (row.snapshot !== null && !snapshot) return null;
      ids.add(row.sessionId); instances.add(row.instanceId);
      sessions.push({ instanceId: row.instanceId, sessionId: row.sessionId, name: row.name, cwd: row.cwd,
        isMain: row.isMain, isActive: row.isActive, snapshot });
    }
    if (sessions.filter(row => row.isMain).length !== 1) return null;
    const parsed: LiveHudMultisession = { version: 2, streamId: root.streamId, sequence: root.sequence, timestamp: root.timestamp,
      mainSessionId: root.mainSessionId, activeSessionId: root.activeSessionId, sessions };
    return encoder.encode(JSON.stringify(parsed)).byteLength <= LIVE_HUD_MULTI_MAX_BYTES ? parsed : null;
  } catch { return null; }
}
/** Input API derives flags rather than accepting a second active-conversation authority. */
export function createLiveHudMultisession(input: WebcamMultisession, clock: Pick<LiveHudMultisession, 'streamId' | 'sequence' | 'timestamp'>): LiveHudMultisession | null {
  try {
    const source = record(input, ['mainSessionId', 'activeSessionId', 'sessions']);
    if (!source || !Array.isArray(source.sessions) || source.sessions.length > LIVE_HUD_MAX_SESSIONS) return null;
    const sessions = [];
    for (const raw of source.sessions) {
      const row = record(raw, ['instanceId', 'sessionId', 'name', 'cwd', 'isMain', 'snapshot']);
      if (!row) return null;
      sessions.push({ ...row, isActive: row.sessionId === source.activeSessionId });
    }
    return parseLiveHudMultisession({ version: 2, ...clock, mainSessionId: source.mainSessionId, activeSessionId: source.activeSessionId, sessions });
  } catch { return null; }
}
/** Derived display only: source rows remain full, distinct and untouched.
 * Conversation data comes from selection; only main can authorize call/display state.
 */
export function activeLiveHudSnapshot(value: LiveHudMultisession, now = Date.now()): LiveHudSnapshot | null {
  const fresh = (s: LiveHudSnapshot | null | undefined): s is LiveHudSnapshot => !!s
    && now - s.timestamp < LIVE_HUD_STALE_MS && s.timestamp - now <= 1000;
  const selected = value.sessions.find(row => row.isActive)?.snapshot;
  if (!fresh(selected)) return null;
  const { talk: _talk, captions: _captions, presentation: _presentation, displayScopeId: _scope, ...base } = selected;
  const main = value.sessions.find(row => row.isMain)?.snapshot;
  if (!fresh(main)) return { ...base, talk: idleTalkVisual() };
  const callActive = captionCallActive(main.talk);
  const presentation = parsePresentation(main.presentation, {
    displayScopeId: main.displayScopeId, callRunId: callActive ? main.talk.runId : undefined,
  });
  return { ...base, timestamp: Math.min(selected.timestamp, main.timestamp), talk: { ...main.talk },
    ...(callActive && main.captions?.runId === main.talk.runId ? { captions: structuredClone(main.captions) } : {}),
    ...(main.displayScopeId ? { displayScopeId: main.displayScopeId } : {}),
    ...(presentation ? { presentation } : {}),
  };
}
