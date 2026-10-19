import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type FaceTimeRecord = Record<string, unknown>;
export interface FaceTimeTransport {
  start(): void;
  request(command: 'video.status' | 'video.rotate', args?: FaceTimeRecord): Promise<unknown>;
  close(): void;
}
export interface FaceTimeTransportOptions {
  socketPath?: string;
  onSnapshot(record: FaceTimeRecord): void;
  onEvent(record: FaceTimeRecord): void;
  onDisconnect(error: Error): void;
  requestTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

const LINE_BYTES = 256 * 1024;
// The Swift server accepts command frames of at most 64 KiB.
const COMMAND_BYTES = 64 * 1024;
const MAX_PENDING = 8;
function object(value: unknown): value is FaceTimeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function notify(callback: () => void): void {
  try { callback(); } catch { /* Consumers cannot break transport state. */ }
}

/** Video-only NDJSON transport. Nothing is queued or replayed across connections. */
export function createFaceTimeTransport(options: FaceTimeTransportOptions): FaceTimeTransport {
  const requestMs = options.requestTimeoutMs ?? 5_000;
  const snapshotMs = options.snapshotTimeoutMs ?? 5_000;
  const minMs = options.reconnectMinMs ?? 200;
  const maxMs = options.reconnectMaxMs ?? 5_000;
  for (const value of [requestMs, snapshotMs, minMs, maxMs]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error('Invalid FaceTime transport timeout');
    }
  }
  if (minMs > maxMs) throw new Error('Invalid FaceTime reconnect bounds');
  const path = options.socketPath ?? '~/.local/share/pi-facetime/control.sock';
  const socketPath = resolve(path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path);
  let started = false;
  let closed = false;
  let ready = false;
  let socket: Socket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = minMs;
  let instance: string | undefined;
  let watermark = -1;
  const prefix = randomUUID();
  let serial = 0;
  const pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function rejectPending(error: Error): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function open(): void {
    if (closed) return;
    reconnectTimer = undefined;
    const current = createConnection(socketPath);
    current.unref();
    socket = current;
    ready = false;
    let failed = false;
    let decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    const active = () => !closed && !failed && socket === current;

    function fail(error: Error): void {
      if (!active()) return;
      failed = true;
      ready = false;
      socket = undefined;
      clearTimeout(snapshotTimer);
      current.destroy();
      rejectPending(error);
      notify(() => options.onDisconnect(error));
      if (closed) return;
      reconnectTimer = setTimeout(open, backoff);
      reconnectTimer.unref();
      backoff = Math.min(maxMs, backoff * 2);
    }

    function record(value: unknown): void {
      if (!object(value)) throw new Error('Invalid FaceTime record');
      if (!ready) {
        if (value.type !== 'snapshot' || value.protocolVersion !== 1
          || typeof value.serviceInstanceId !== 'string' || !value.serviceInstanceId
          || !sequence(value.seq) || !object(value.call) || typeof value.call.phase !== 'string') {
          throw new Error('Invalid FaceTime v1 snapshot');
        }
        if (value.serviceInstanceId === instance && value.seq < watermark) {
          throw new Error('FaceTime snapshot sequence regressed');
        }
        instance = value.serviceInstanceId;
        watermark = value.seq;
        ready = true;
        backoff = minMs;
        clearTimeout(snapshotTimer);
        notify(() => options.onSnapshot(value));
        return;
      }
      if (value.type === 'response') {
        if (value.protocolVersion !== 1 || typeof value.id !== 'string' || typeof value.ok !== 'boolean') {
          throw new Error('Invalid FaceTime v1 response');
        }
        const entry = pending.get(value.id);
        if (!entry) return; // Late or unsolicited response; never affects another request.
        pending.delete(value.id);
        clearTimeout(entry.timer);
        if (value.ok) entry.resolve(value.result);
        else entry.reject(new Error(object(value.error) && typeof value.error.message === 'string'
          ? value.error.message.slice(0, 1024) : 'FaceTime command failed'));
      } else if (value.type === 'event') {
        if (value.protocolVersion !== 1 || value.serviceInstanceId !== instance || !sequence(value.seq)) {
          throw new Error('Invalid FaceTime event metadata');
        }
        if (value.seq <= watermark) return;
        watermark = value.seq;
        notify(() => options.onEvent(value));
      }
      // Diagnostics and unknown record types are intentionally not logged.
    }

    snapshotTimer = setTimeout(() => fail(new Error('FaceTime initial snapshot timed out')), snapshotMs);
    snapshotTimer.unref();
    current.on('data', (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length && active()) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        bytes += end - start;
        if (bytes > LINE_BYTES) { fail(new Error('FaceTime record exceeds size limit')); return; }
        try {
          text += decoder.decode(chunk.subarray(start, end), { stream: true });
          if (newline >= 0) {
            text += decoder.decode();
            if (text.trim()) record(JSON.parse(text));
            text = '';
            bytes = 0;
            decoder = new TextDecoder('utf-8', { fatal: true });
          }
        } catch {
          fail(new Error('Invalid FaceTime NDJSON or protocol record'));
          return;
        }
        start = newline < 0 ? chunk.length : newline + 1;
      }
    });
    current.on('error', () => fail(new Error('FaceTime service unavailable')));
    current.on('end', () => fail(new Error(bytes ? 'Incomplete FaceTime NDJSON record' : 'FaceTime service disconnected')));
    current.on('close', () => fail(new Error('FaceTime service disconnected')));
  }

  return {
    start() {
      if (started || closed) return;
      started = true;
      open();
    },
    request(command, args = {}) {
      if (command !== 'video.status' && command !== 'video.rotate') {
        return Promise.reject(new Error('Only FaceTime video.status and video.rotate are allowed'));
      }
      if (closed || !ready || !socket || socket.destroyed) {
        return Promise.reject(new Error('FaceTime service is not connected'));
      }
      if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending FaceTime requests'));
      if (!Number.isSafeInteger(++serial)) return Promise.reject(new Error('FaceTime request IDs exhausted'));
      const id = `${prefix}:${serial}`;
      let line: string;
      try {
        // Normalize first: an args.toJSON must never replace the command envelope.
        const normalized: unknown = JSON.parse(JSON.stringify(args));
        if (!object(normalized)) throw new Error('Invalid args');
        line = `${JSON.stringify({ ...normalized, type: 'command', id, command })}\n`;
      } catch { return Promise.reject(new Error('Could not encode FaceTime command')); }
      // Serialization can execute consumer code; recheck lifecycle/admission afterward.
      if (closed || !ready || !socket || socket.destroyed) return Promise.reject(new Error('FaceTime service is not connected'));
      if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending FaceTime requests'));
      const size = Buffer.byteLength(line);
      if (size > COMMAND_BYTES || socket.writableLength + size > LINE_BYTES) {
        return Promise.reject(new Error('FaceTime command queue exceeds size limit'));
      }
      const current = socket;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`FaceTime ${command} timed out; outcome unknown, not retried`));
        }, requestMs);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          current.write(line, (error) => {
            if (error && !closed && socket === current) current.destroy(error);
          });
        } catch {
          current.destroy(new Error('FaceTime command write failed; outcome unknown'));
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      ready = false;
      clearTimeout(reconnectTimer);
      clearTimeout(snapshotTimer);
      rejectPending(new Error('FaceTime transport closed'));
      socket?.destroy();
      socket = undefined;
    },
  };
}
