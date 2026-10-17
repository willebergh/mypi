import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { types } from "node:util";

export type TalkTraceDirection = "in" | "out" | "local";
export interface TalkTraceSink {
  record(direction: TalkTraceDirection, event: unknown): void;
  addSecrets(values: string[]): void;
}

const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const MAX_RECORD = 64 * 1024;
const secretKey = /^auth$|authorization|cookie|password|passwd|secret|credential|api.?key|account.?id|token/i;
const payloadKey = /^(?:audio|pcm|samples|base64|sdp|ice|candidate|candidates|audio_data|audioData|audio_chunk|audioChunk)$/i;
const payloadType = /(?:audio.*(?:delta|append|chunk)|^(?:(?:input|output)_)?audio$|sdp|ice[._-]candidate)/i;
const own = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

function sanitizer(secrets: Set<string>) {
  function clone(input: unknown): unknown {
    let nodes = 0;
    let stringBytes = 0;
    let inspectedBytes = 0;
    let scannedCharacters = 0;
    const knownSecrets = [...secrets].sort((a, b) => b.length - a.length);

    // Parse embedded JSON rather than guessing where a credential/payload ends.
    // Offset maps preserve surrounding prose and support one/two escaped layers.
    function embedded(source: string, depth: number): string {
      if (!source.includes("{") && !source.includes("[")) return source;
      for (let layer = 0; layer <= 2; layer++) {
        let view = source;
        let offsets = Array.from({ length: source.length + 1 }, (_, i) => i);
        for (let n = 0; n < layer; n++) {
          const next: string[] = [], mapped: number[] = [0];
          for (let i = 0; i < view.length;) {
            const escape = /^\\(?:["\\/bfnrt]|u[0-9a-f]{4})/i.exec(view.slice(i, i + 6));
            const length = escape ? escape[0].length : 1;
            next.push(escape ? JSON.parse(`"${escape[0]}"`) : view[i]);
            i += length;
            mapped.push(offsets[i]);
          }
          view = next.join("");
          offsets = mapped;
        }
        const replacements: { start: number; end: number; value: string }[] = [];
        for (let i = 0; i < view.length; i++) {
          if (view[i] !== "{" && view[i] !== "[") continue;
          const start = i;
          let nesting = 0, quoted = false, escaped = false;
          for (; i < view.length; i++) {
            if (++scannedCharacters > 512 * 1024) return REDACTED;
            const char = view[i];
            if (quoted) {
              if (escaped) escaped = false;
              else if (char === "\\") escaped = true;
              else if (char === '"') quoted = false;
            } else if (char === '"') quoted = true;
            else if (char === "{" || char === "[") nesting++;
            else if ((char === "}" || char === "]") && --nesting === 0) break;
          }
          if (i === view.length) { i = start; continue; }
          const candidate = view.slice(start, i + 1);
          let parsed: unknown;
          try { parsed = JSON.parse(candidate); } catch { i = start; continue; }
          // Avoid changing ordinary text merely because it contains benign JSON.
          const clean = visit(parsed, depth + 1);
          if (JSON.stringify(clean) === JSON.stringify(parsed)) continue;
          let replacement = JSON.stringify(clean);
          for (let n = 0; n < layer; n++) replacement = JSON.stringify(replacement).slice(1, -1);
          replacements.push({ start: offsets[start], end: offsets[i + 1], value: replacement });
        }
        for (const replacement of replacements.reverse()) {
          source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
        }
      }
      return source;
    }
    function leaf(value: string, depth = 0): string {
      // Oversized/uninspectable input fails closed, never retaining a raw prefix.
      inspectedBytes += value.length;
      if (value.length > 128 * 1024 || inspectedBytes > 512 * 1024 || depth > 12) return REDACTED;
      let clean = embedded(value, depth);
      for (const secret of knownSecrets) clean = clean.split(secret).join(REDACTED);
      clean = clean
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
        // Non-JSON assignments (headers, query strings, etc.) use the same keys.
        .replace(/\b([\w-]+)\s*[:=]\s*("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\]]+)/g,
          (match, key: string) => secretKey.test(key) || payloadKey.test(key) ? `${key}=${REDACTED}` : match)
        .replace(/(?:v=0(?:\r?\n|\\r\\n|\\n)|a=(?:ice-ufrag|ice-pwd|candidate):)[\s\S]*/gi, REDACTED);
      // All redaction, including embedded JSON, precedes every output limit.
      if (Buffer.byteLength(clean) > 16 * 1024) clean = Buffer.from(clean).subarray(0, 16 * 1024).toString("utf8") + TRUNCATED;
      stringBytes += Buffer.byteLength(clean);
      return stringBytes > MAX_RECORD ? TRUNCATED : clean;
    }
    const seen = new WeakSet<object>();
    function visit(value: unknown, depth: number): unknown {
      if (++nodes > 2048 || depth > 12) return TRUNCATED;
      if (typeof value === "string") return leaf(value, depth);
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value !== "object") return "[unsupported]";
      try {
        // Detect proxies without invoking any of their traps, even revoked ones.
        if (types.isProxy(value)) return "[uninspectable]";
        if (ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value)) return "[binary redacted]";
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return "[uninspectable]";
        if (seen.has(value)) return "[circular]";
        seen.add(value);
        const type = own(value, "type");
        if (type === "Buffer" && Array.isArray(own(value, "data"))) return "[binary redacted]";
        const binary = typeof type === "string" && payloadType.test(type);
        const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
        // for-in is bounded without building another array of all object keys.
        for (const key in value) {
          if (++nodes >= 2048) {
            if (Array.isArray(result)) result.push(TRUNCATED);
            else result["[truncated]"] = true;
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor) continue;
          const safeKey = leaf(key, depth);
          const entry = secretKey.test(key) || payloadKey.test(key) ||
            (binary && /^(?:delta|data|payload|text)$/i.test(key)) ? REDACTED :
            !("value" in descriptor) ? "[accessor omitted]" : visit(descriptor.value, depth + 1);
          // defineProperty avoids __proto__ and inherited setters.
          if (Array.isArray(result)) result.push(entry);
          else Object.defineProperty(result, safeKey, { value: entry, enumerable: true, configurable: true, writable: true });
        }
        return result;
      } catch {
        return "[uninspectable]";
      }
    }
    return visit(input, 0);
  }
  return { clone, bounded: (value: string) => clone(value) as string };
}

/** Opt-in local JSONL tracing. Construction and disabled sinks perform no I/O. */
export function createTalkTrace(options: {
  path: string;
  onError?(): void;
  maxBytes?: number;
  maxQueuedBytes?: number;
}): {
  enable(): Promise<void>;
  disable(): Promise<void>;
  reset(): Promise<void>;
  status(): { enabled: boolean; path: string; dropped: number };
  session(callId: string): TalkTraceSink;
} {
  const path = resolve(options.path);
  // A minimum frame budget keeps metadata and truncation/drop markers valid JSON.
  const limit = (n: number | undefined, fallback: number) =>
    n === undefined || !Number.isFinite(n) ? fallback : Math.max(512, Math.floor(n));
  const maxBytes = limit(options.maxBytes, 5 * 1024 * 1024);
  const maxQueuedBytes = limit(options.maxQueuedBytes, 1024 * 1024);
  let enabled = false;
  let requestedEnabled = false;
  let resetPending = false;
  let generation = 0;
  let file: FileHandle | undefined;
  let size = 0;
  let seq = 0;
  let dropped = 0;
  let pendingDrops = 0;
  let queuedBytes = 0; // Includes the write currently in flight.
  const queue: string[] = [];
  let worker: Promise<void> | undefined;
  let lifecycle = Promise.resolve();
  let epoch = 0;
  let reported = false;

  async function fail() {
    enabled = false;
    requestedEnabled = false;
    queue.length = 0;
    queuedBytes = 0;
    pendingDrops = 0;
    const old = file;
    file = undefined;
    try { await old?.close(); } catch { /* logging must never affect the call */ }
    if (!reported) {
      reported = true;
      try { options.onError?.(); } catch { /* no raw errors escape */ }
    }
  }
  async function regular(name: string) {
    try {
      const stat = await lstat(name);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe trace file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async function prepare(create = true) {
    const parent = dirname(path);
    const root = parse(parent).root;
    let current = root;
    for (const part of parent.slice(root.length).split("/").filter(Boolean)) {
      current = resolve(current, part);
      if (create) {
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (!create && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe trace directory");
    }
    const dir = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { await dir.chmod(0o700); } finally { await dir.close(); }
    await regular(path);
    await regular(path + ".1");
    try {
      const backup = await open(path + ".1", constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await backup.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe trace backup");
        await backup.chmod(0o600);
      } finally { await backup.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | (create ? constants.O_CREAT : 0) |
      constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (!create && error.code === "ENOENT") return undefined;
        throw error;
      });
    if (!handle) return;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe trace file");
      await handle.chmod(0o600);
      size = stat.size;
      file = handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async function resetFile() {
    start();
    while (worker) await worker;
    // Reset existing files even while logging is off, but never create a log
    // or its directories unless logging was explicitly enabled.
    if (!file) await prepare(requestedEnabled);
    if (file) {
      const current = await lstat(path);
      const opened = await file.stat();
      if (!current.isFile() || current.ino !== opened.ino || current.dev !== opened.dev || opened.nlink !== 1) {
        throw new Error("Trace replaced");
      }
    }
    try {
      const backup = await lstat(path + ".1");
      if (!backup.isFile() || backup.isSymbolicLink() || backup.nlink !== 1) throw new Error("Unsafe trace backup");
      await unlink(path + ".1");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Keep the active inode so tail -F continues following the same pathname.
    await file?.truncate(0);
    if (!requestedEnabled) {
      const old = file;
      file = undefined;
      await old?.close();
    }
    size = 0;
    seq = 0;
    dropped = 0;
    pendingDrops = 0;
    resetPending = false;
  }
  function frame(callId: string, direction: TalkTraceDirection, event: unknown, type: string) {
    const base = { time: new Date().toISOString(), seq: ++seq, callId, direction, type, event };
    let line = JSON.stringify(base) + "\n";
    const budget = Math.min(MAX_RECORD, maxBytes, maxQueuedBytes);
    if (Buffer.byteLength(line) > budget) {
      // Keep a bounded prefix as useful context, rather than slicing JSON mid-record.
      base.callId = base.callId.slice(0, 80);
      base.type = base.type.slice(0, 80);
      base.event = { truncated: true, preview: line.slice(0, Math.max(0, Math.floor((budget - 400) / 6))) };
      line = JSON.stringify(base) + "\n";
      if (Buffer.byteLength(line) > budget) {
        base.callId = "[truncated]";
        base.type = "[truncated]";
        base.event = { truncated: true };
        line = JSON.stringify(base) + "\n";
      }
    }
    return line;
  }
  function marker() {
    if (!pendingDrops) return;
    const line = frame("", "local", { type: "trace.dropped", count: pendingDrops }, "trace.dropped");
    if (queuedBytes + Buffer.byteLength(line) <= maxQueuedBytes) {
      queue.push(line);
      queuedBytes += Buffer.byteLength(line);
      pendingDrops = 0;
    }
  }
  async function drain() {
    try {
      while (file) {
        marker();
        const line = queue.shift();
        if (!line) break;
        const bytes = Buffer.byteLength(line);
        if (size && size + bytes > maxBytes) {
          await regular(path + ".1");
          const stat = await lstat(path);
          const opened = await file.stat();
          if (!stat.isFile() || stat.ino !== opened.ino || stat.dev !== opened.dev) throw new Error("Trace replaced");
          await file.close();
          file = undefined;
          await rename(path, path + ".1");
          await prepare();
        }
        // writeFile handles partial writes; no record is split by rotation.
        await file!.writeFile(line, "utf8");
        size += bytes;
        queuedBytes -= bytes;
      }
    } catch { await fail(); }
  }
  function start() {
    if (!worker) {
      worker = Promise.resolve().then(drain).finally(() => {
        worker = undefined;
        if (file && queue.length) start();
      });
    }
  }
  function schedule(action: () => Promise<void>) {
    lifecycle = lifecycle.then(action).catch(fail);
    return lifecycle;
  }
  return {
    enable() {
      requestedEnabled = true;
      const request = ++epoch;
      return schedule(async () => {
        if (!file) await prepare();
        if (resetPending) await resetFile();
        if (request === epoch && requestedEnabled) enabled = true;
      });
    },
    disable() {
      ++epoch;
      requestedEnabled = false;
      enabled = false;
      return schedule(async () => {
        if (file) {
          start();
          while (worker) await worker;
          const old = file;
          file = undefined;
          await old?.close();
        }
      });
    },
    reset() {
      const request = ++epoch;
      generation++;
      resetPending = true;
      enabled = false;
      return schedule(async () => {
        // Clearing old logs does not opt into recording the new call.
        await resetFile();
        if (request === epoch && requestedEnabled) enabled = true;
      });
    },
    status: () => ({ enabled, path, dropped }),
    session(callId) {
      const sinkGeneration = generation;
      const secrets = new Set<string>();
      const safe = sanitizer(secrets);
      return {
        addSecrets(values) {
          for (const value of values) {
            if (secrets.size >= 64) break;
            if (typeof value !== "string") continue;
            const secret = value.trim().replace(/^Bearer\s+/i, "").trim();
            // Ignore oversized values instead of retaining an unbounded secret store.
            if (secret && secret.length <= 16 * 1024 && secrets.size < 64) secrets.add(secret);
          }
        },
        record(direction, event) {
          if (!enabled || sinkGeneration !== generation) return;
          try {
            const clean = safe.clone(event);
            const type = clean && typeof clean === "object" ? own(clean, "type") : undefined;
            marker();
            const line = frame(safe.bounded(callId), direction, clean, typeof type === "string" ? type : "unknown");
            const bytes = Buffer.byteLength(line);
            if (queuedBytes + bytes > maxQueuedBytes) {
              dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
              pendingDrops = Math.min(Number.MAX_SAFE_INTEGER, pendingDrops + 1);
            } else {
              queue.push(line);
              queuedBytes += bytes;
            }
            start();
          } catch {
            // Malicious values must not throw into realtime/audio hooks.
          }
        },
      };
    },
  };
}
