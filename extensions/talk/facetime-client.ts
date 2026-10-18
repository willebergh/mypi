import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type FaceTimeRecord = Record<string, unknown>;
export interface FaceTimeSnapshot extends FaceTimeRecord {
  type: "snapshot";
  protocolVersion: 1;
  serviceInstanceId: string;
  seq: number;
  call: FaceTimeRecord & { phase: string };
}
export interface FaceTimeClientCallbacks {
  /** Includes the first snapshot, before connect() resolves. Never replayed events. */
  onSnapshot(snapshot: FaceTimeSnapshot): void;
  onEvent(event: FaceTimeRecord): void;
  onDisconnect(error: Error): void;
}
export interface FaceTimeClient {
  connect(): Promise<FaceTimeSnapshot>;
  request(command: string, args?: FaceTimeRecord): Promise<unknown>;
  close(): void;
}
export interface FaceTimeClientOptions extends FaceTimeClientCallbacks {
  socketPath?: string;
  requestTimeoutMs?: number;
  sharingRequestTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  maxPending?: number;
  maxLineBytes?: number;
}

export function faceTimeSocketPath(path = "~/.local/share/pi-facetime/control.sock"): string {
  return resolve(path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path);
}
export function faceTimeRecord(value: unknown): FaceTimeRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as FaceTimeRecord : {};
}
export function validateFaceTimeSnapshot(value: unknown): FaceTimeSnapshot {
  const record = faceTimeRecord(value);
  if (record.type !== "snapshot" || record.protocolVersion !== 1
    || typeof record.serviceInstanceId !== "string" || !record.serviceInstanceId
    || !Number.isSafeInteger(record.seq) || (record.seq as number) < 0
    || typeof faceTimeRecord(record.call).phase !== "string") {
    throw new Error("Invalid FaceTime service snapshot (requires protocol 1 with serviceInstanceId and seq); update the external service");
  }
  return record as FaceTimeSnapshot;
}
function notify(fn: () => void) { try { fn(); } catch { /* Isolate consumer callbacks. */ } }

// Only semantic notifications cross this boundary, never AX trees/process diagnostics.
const semantic = new Set(["call.incoming", "call.confirmation_attempted", "call.answer_attempted", "call.dialing",
  "call.unknown", "call.connected", "call.ended", "call.failed", "bridge.status", "audio.routing"]);
const eventKeys = ["type", "protocolVersion", "serviceInstanceId", "seq", "timestamp", "event", "callId", "direction",
  "identity", "media", "durationSeconds", "verified", "allowed", "evidence", "status", "ok", "input", "output"];
export function faceTimeSemanticEvent(record: FaceTimeRecord): FaceTimeRecord | undefined {
  if (!semantic.has(String(record.event))) return undefined;
  return Object.fromEntries(eventKeys.filter((key) => key in record).map((key) => [key, record[key]]));
}

/** Persistent external-service transport. Requests are NEVER queued or replayed on reconnect. */
export function createFaceTimeClient(options: FaceTimeClientOptions): FaceTimeClient {
  const path = faceTimeSocketPath(options.socketPath);
  const lineLimit = options.maxLineBytes ?? 256 * 1024;
  const pendingLimit = options.maxPending ?? 64;
  const requestMs = options.requestTimeoutMs ?? 5_000;
  const sharingRequestMs = options.sharingRequestTimeoutMs ?? 20_000;
  const snapshotMs = options.snapshotTimeoutMs ?? 5_000;
  const minBackoff = options.reconnectMinMs ?? 200;
  const maxBackoff = options.reconnectMaxMs ?? 5_000;
  for (const n of [lineLimit, pendingLimit, requestMs, sharingRequestMs, snapshotMs, minBackoff, maxBackoff]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid FaceTime transport limit");
  }
  if (minBackoff > maxBackoff) throw new Error("Invalid FaceTime reconnect bounds");
  let stopped = false;
  let socket: Socket | undefined;
  let ready = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = minBackoff;
  let first: Promise<FaceTimeSnapshot> | undefined;
  let resolveFirst: (snapshot: FaceTimeSnapshot) => void = () => {};
  let rejectFirst: (error: Error) => void = () => {};
  let instance: string | undefined;
  let watermark = -1;
  const prefix = randomUUID();
  let nextId = 0;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  function rejectPending(error: Error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function open() {
    if (stopped) return;
    const current = createConnection(path);
    socket = current;
    ready = false;
    let failed = false;
    let decoder = new StringDecoder("utf8");
    let line = "";
    let bytes = 0;
    function fail(error: Error) {
      if (failed || stopped || socket !== current) return;
      failed = true;
      ready = false;
      clearTimeout(startupTimer);
      current.destroy();
      rejectFirst(error);
      rejectPending(error);
      // Mark disconnected before consumer code can attempt any mutation.
      notify(() => options.onDisconnect(error));
      if (!stopped) {
        reconnect = setTimeout(open, backoff);
        backoff = Math.min(maxBackoff, backoff * 2);
      }
    }
    startupTimer = setTimeout(() => fail(new Error("FaceTime initial snapshot timed out; start the external FaceTime service")), snapshotMs);
    function record(value: unknown) {
      const message = faceTimeRecord(value);
      if (!ready) {
        const snapshot = validateFaceTimeSnapshot(message);
        if (snapshot.serviceInstanceId === instance && snapshot.seq < watermark) throw new Error("FaceTime snapshot sequence regressed");
        instance = snapshot.serviceInstanceId;
        watermark = snapshot.seq;
        ready = true;
        backoff = minBackoff;
        clearTimeout(startupTimer);
        notify(() => options.onSnapshot(snapshot));
        resolveFirst(snapshot);
        return;
      }
      if (message.type === "response") {
        if (typeof message.id !== "string") return;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok === true) entry.resolve(message.result);
        else {
          const error = faceTimeRecord(message.error);
          entry.reject(new Error(typeof error.message === "string" ? error.message.slice(0, 1024) : "FaceTime command failed"));
        }
        return;
      }
      if (message.type !== "event") return;
      if (message.protocolVersion !== 1 || message.serviceInstanceId !== instance
        || !Number.isSafeInteger(message.seq) || (message.seq as number) < 0) throw new Error("Invalid FaceTime event metadata");
      if ((message.seq as number) <= watermark) return;
      watermark = message.seq as number;
      const event = faceTimeSemanticEvent(message);
      if (event) notify(() => options.onEvent(event));
    }
    current.on("data", (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length && !failed && !stopped) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const size = end - start;
        if (bytes + size > lineLimit) { fail(new Error("FaceTime record exceeds size limit")); return; }
        bytes += size;
        line += decoder.write(chunk.subarray(start, end));
        if (newline >= 0) {
          line += decoder.end();
          try { if (line.trim()) record(JSON.parse(line)); }
          catch (error) { fail(error instanceof Error && /FaceTime/.test(error.message) ? error : new Error("Invalid FaceTime NDJSON record")); }
          line = "";
          bytes = 0;
          decoder = new StringDecoder("utf8");
        }
        start = newline < 0 ? chunk.length : newline + 1;
      }
    });
    current.on("error", () => fail(new Error("FaceTime service unavailable; start the external service and check its socket path")));
    current.on("end", () => fail(new Error(bytes ? "Incomplete FaceTime NDJSON record" : "FaceTime service disconnected")));
    current.on("close", () => fail(new Error("FaceTime service disconnected")));
  }
  return {
    connect() {
      if (stopped) return Promise.reject(new Error("FaceTime transport closed"));
      if (!first) {
        first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
        open();
      }
      return first;
    },
    request(command, args = {}) {
      if (stopped || !ready || !socket || socket.destroyed) return Promise.reject(new Error("FaceTime service is not connected"));
      if (pending.size >= pendingLimit) return Promise.reject(new Error("Too many pending FaceTime requests"));
      if (!Number.isSafeInteger(++nextId)) return Promise.reject(new Error("FaceTime request IDs exhausted"));
      const id = `${prefix}:${nextId}`;
      let line: string;
      try { line = `${JSON.stringify({ ...args, type: "command", id, command })}\n`; }
      catch { return Promise.reject(new Error("Could not encode FaceTime command")); }
      const size = Buffer.byteLength(line);
      if (size > lineLimit || socket.writableLength + size > lineLimit) return Promise.reject(new Error("FaceTime command queue exceeds size limit"));
      const current = socket;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`FaceTime ${command} timed out; outcome unknown, not retried`));
        }, command === "screen.share" || command === "screen.stop" ? sharingRequestMs : requestMs);
        pending.set(id, { resolve, reject, timer });
        try {
          current.write(line, (error) => {
            if (!error) return;
            const entry = pending.get(id);
            if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.reject(new Error("FaceTime command write failed; outcome unknown")); }
            current.destroy();
          });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("FaceTime command write failed; outcome unknown"));
          current.destroy();
        }
      });
    },
    close() {
      if (stopped) return;
      stopped = true;
      ready = false;
      clearTimeout(startupTimer);
      clearTimeout(reconnect);
      const error = new Error("FaceTime transport closed");
      rejectFirst(error);
      rejectPending(error);
      socket?.destroy();
    },
  };
}
