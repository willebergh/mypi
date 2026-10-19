/** Private, versioned local Talk protocol. No authentication against malicious same-UID processes. */
import { isAbsolute } from "node:path";

export type TalkJson = null | boolean | number | string | TalkJson[] | { [key: string]: TalkJson };
export interface TalkSessionMetadata {
  sessionId: string;
  name: string;
  cwd: string;
  state: "idle" | "working" | "unavailable";
  activity: string;
}
export interface TalkSessionIdentity extends TalkSessionMetadata {
  readonly instanceId: string;
  readonly isMain: boolean;
}
/** cwd may be omitted: the transport supplies the local process's absolute cwd. */
export type TalkSessionInput = Omit<TalkSessionMetadata, "cwd"> & { cwd?: string };
export type TalkRequestHandler = (method: string, payload: TalkJson) => TalkJson | void | Promise<TalkJson | void>;
/** Events run FIFO, one async handler per peer, with at most 64 queued frames.
 * Overflow disconnects (no silent snapshot drops); RPC/metadata work stays independent.
 * A stalled handler retains its slot until settlement, including after disconnect.
 */
export type TalkEventHandler = (event: string, payload: TalkJson) => void | Promise<void>;
export interface TalkSessionPeer {
  /** Immutable connection identity; on a client this is its own hub-assigned identity. */
  readonly identity: Readonly<TalkSessionIdentity>;
  readonly connected: boolean;
  request(method: string, payload: TalkJson, timeoutMs?: number): Promise<TalkJson>;
  notify(event: string, payload: TalkJson): void;
  close(): void;
  onRequest?: TalkRequestHandler;
  onEvent?: TalkEventHandler;
}
export interface TalkSessionClient extends TalkSessionPeer {
  update(metadata: TalkSessionInput): Promise<void>;
  sessions(): Promise<TalkSessionIdentity[]>;
}
export const TALK_PROTOCOL_VERSION = 1;
export const TALK_MAX_FRAME_BYTES = 256 * 1024;
export const TALK_MAX_PENDING_REQUESTS = 64;
export const TALK_MAX_TIMEOUT_MS = 30_000;
export const TALK_HANDSHAKE_TIMEOUT_MS = 5_000;
/** Connected destinations; main is additional (at most 65 discovery rows). */
export const TALK_MAX_SESSIONS = 64;

export function sessionMetadata(value: unknown, defaultCwd?: string): TalkSessionMetadata {
  if (!record(value)) throw new Error("Invalid session metadata");
  const { sessionId, name, state, activity } = value;
  const cwd = value.cwd ?? defaultCwd;
  // Match the aggregate HUD identity boundary BEFORE publishing a registration.
  // A valid attachment must never poison the entire all-session envelope.
  const displayText = (v: unknown, maxBytes: number): v is string => typeof v === "string" && v.length > 0
    && Buffer.byteLength(v, "utf8") <= maxBytes
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\p{Cs}]/u.test(v);
  if (!displayText(name, 256) || name.length > 128 || name.trim() !== name) {
    throw new Error("Invalid session name: use 1–128 display characters (at most 256 UTF-8 bytes), without control/format characters");
  }
  if (!displayText(cwd, 4096) || !isAbsolute(cwd)) {
    throw new Error("Invalid session project directory: requires an absolute display-safe path of at most 4096 UTF-8 bytes");
  }
  if (!text(sessionId, 256) || !displayText(sessionId, 1024) ||
      !["idle", "working", "unavailable"].includes(state as string) ||
      typeof activity !== "string" || activity.length > 512 || /[\x00-\x1f\x7f]/.test(activity)) {
    throw new Error("Invalid session metadata");
  }
  return { sessionId, name, cwd, state: state as TalkSessionMetadata["state"], activity };
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function sessionIdentity(value: unknown): TalkSessionIdentity {
  const metadata = sessionMetadata(value);
  if (!record(value) || !text(value.instanceId) || typeof value.isMain !== "boolean") throw new Error("Invalid identity");
  return Object.freeze({ ...metadata, instanceId: value.instanceId, isMain: value.isMain });
}

export type TalkFrame =
  | { v: 1; type: "hello"; session: TalkSessionMetadata }
  | { v: 1; type: "welcome"; identity: TalkSessionIdentity }
  | { v: 1; type: "reject"; reason: string }
  | { v: 1; type: "request"; id: number; method: string; payload: TalkJson; deadline: number }
  | { v: 1; type: "response"; id: number; ok: boolean; payload: TalkJson }
  | { v: 1; type: "event"; event: string; payload: TalkJson };

export function parseTalkFrame(line: string): TalkFrame {
  const f: unknown = JSON.parse(line);
  if (!record(f) || f.v !== TALK_PROTOCOL_VERSION) throw new Error("Invalid protocol");
  const id = () => Number.isSafeInteger(f.id) && (f.id as number) > 0;
  switch (f.type) {
    case "hello": sessionMetadata(f.session); break;
    case "welcome": sessionIdentity(f.identity); break;
    case "reject": if (!text(f.reason)) throw new Error("Invalid rejection"); break;
    case "request":
      if (!id() || !text(f.method) || !Number.isSafeInteger(f.deadline) || !Object.hasOwn(f, "payload")) throw new Error("Invalid request");
      break;
    case "response":
      if (!id() || typeof f.ok !== "boolean" || !Object.hasOwn(f, "payload")) throw new Error("Invalid response");
      break;
    case "event": if (!text(f.event) || !Object.hasOwn(f, "payload")) throw new Error("Invalid event"); break;
    default: throw new Error("Unknown frame");
  }
  return f as TalkFrame;
}
