import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, chmodSync, linkSync, unlinkSync, type Stats } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  TALK_HANDSHAKE_TIMEOUT_MS, TALK_MAX_FRAME_BYTES, TALK_MAX_PENDING_REQUESTS,
  TALK_MAX_SESSIONS, TALK_MAX_TIMEOUT_MS, parseTalkFrame, sessionIdentity,
  sessionMetadata, text,
  type TalkEventHandler, type TalkFrame, type TalkJson, type TalkRequestHandler,
  type TalkSessionClient, type TalkSessionIdentity, type TalkSessionInput, type TalkSessionPeer,
} from "./multisession-protocol.ts";
export type { TalkJson, TalkSessionMetadata, TalkSessionIdentity, TalkSessionInput,
  TalkSessionPeer, TalkSessionClient, TalkRequestHandler, TalkEventHandler } from "./multisession-protocol.ts";

export interface TalkSessionHubOptions {
  socketPath: string;
  main: TalkSessionInput;
  onSessions?(sessions: TalkSessionIdentity[]): void;
  onPeer?(peer: TalkSessionPeer): void;
  onRequest?(peer: TalkSessionPeer, method: string, payload: TalkJson): TalkJson | void | Promise<TalkJson | void>;
  onEvent?(peer: TalkSessionPeer, event: string, payload: TalkJson): void | Promise<void>;
  onDisconnect?(peer: TalkSessionPeer): void;
}
export interface TalkSessionHub {
  sessions(): TalkSessionIdentity[];
  getPeer(name: string): TalkSessionPeer | undefined;
  broadcast(event: string, payload: TalkJson): void;
  updateMain(metadata: TalkSessionInput): void;
  close(): Promise<void>;
}
export interface ConnectTalkSessionOptions {
  socketPath: string;
  session: TalkSessionInput;
  onRequest?: TalkRequestHandler;
  onEvent?: TalkEventHandler;
  onDisconnect?(): void;
}

export function talkSessionSocketPath(agentDir: string): string {
  return join(resolve(agentDir), "talk-multisession", "hub.sock");
}

// Parents must not be symlinks; the immediate containing directory is always private.
// Existing sockets are never unlinked, even when they appear stale: recovery is explicit.
function privatePath(socketPath: string, create: boolean): void {
  if (!isAbsolute(socketPath) || socketPath.includes("\0") || Buffer.byteLength(socketPath) > 100) {
    throw new Error("Talk requires an absolute Unix socket path of at most 100 bytes");
  }
  const parent = dirname(socketPath);
  const root = parse(parent).root;
  let cursor = root;
  const parts = parent.slice(root.length).split("/").filter(Boolean);
  if (!parts.length) throw new Error("Talk requires a private socket directory");
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(cursor, { mode: 0o700 });
      stat = lstatSync(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid?.())) {
      throw new Error("Unsafe Talk socket directory");
    }
    if (i === parts.length - 1 && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
      throw new Error("Talk socket directory must be owner-only and owned by this user");
    }
    // Writable ancestors permit path replacement unless protected by the sticky bit (e.g. /tmp).
    if (i < parts.length - 1 && (stat.mode & 0o022) && !(stat.mode & 0o1000)) {
      throw new Error("Unsafe writable Talk socket ancestor");
    }
  }
  try {
    const stat = lstatSync(socketPath);
    if (create) throw new Error("Talk socket already exists; refusing to remove it");
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
      throw new Error("Unsafe Talk socket");
    }
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeOwned(path: string, owner: Stats | undefined): void {
  if (!owner) return;
  try {
    const current = lstatSync(path);
    if (current.isSocket() && current.dev === owner.dev && current.ino === owner.ino) unlinkSync(path);
  } catch { /* Missing or replaced paths are not ours to remove. */ }
}

function safely(callback: (() => unknown) | undefined): void {
  try { const result = callback?.(); if (result instanceof Promise) void result.catch(() => {}); } catch { /* observer only */ }
}
function encode(frame: TalkFrame): string {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > TALK_MAX_FRAME_BYTES) throw new Error("Talk frame too large");
  return line + "\n";
}

/** One connection, no reconnect/replay. Timeout means the remote outcome may be unknown. */
class Peer implements TalkSessionPeer {
  onRequest?: TalkRequestHandler;
  onEvent?: TalkEventHandler;
  controlRequest?: TalkRequestHandler;
  identity!: Readonly<TalkSessionIdentity>;
  connected = false;
  private ended = false;
  private buffer = Buffer.alloc(0);
  private utf8 = new TextDecoder("utf-8", { fatal: true });
  private nextId = 0;
  private lastReceivedId = 0;
  private incoming = 0;
  private eventRunning = false;
  private events: Extract<TalkFrame, { type: "event" }>[] = [];
  private inboundTimers = new Set<NodeJS.Timeout>();
  private pending = new Map<number, { resolve(value: TalkJson): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private handshakeTimer: NodeJS.Timeout;
  private socket: Socket;
  private handshake: (frame: TalkFrame) => void;
  private disconnected: () => void;
  constructor(socket: Socket, handshake: (frame: TalkFrame) => void, disconnected: () => void) {
    this.socket = socket;
    this.handshake = handshake;
    this.disconnected = disconnected;
    this.handshakeTimer = setTimeout(() => this.close(), TALK_HANDSHAKE_TIMEOUT_MS);
    socket.on("data", (chunk: Buffer) => this.data(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }
  ready(identity: TalkSessionIdentity): void {
    this.identity = Object.freeze({ ...identity });
    this.connected = true;
    clearTimeout(this.handshakeTimer);
  }
  send(frame: TalkFrame): void {
    if (this.ended || this.socket.destroyed) throw new Error("Talk peer disconnected");
    const line = encode(frame);
    if (this.socket.writableLength + Buffer.byteLength(line) > TALK_MAX_FRAME_BYTES * 2) {
      this.close(); throw new Error("Talk peer backpressure limit");
    }
    this.socket.write(line);
  }
  request(method: string, payload: TalkJson, timeoutMs = TALK_MAX_TIMEOUT_MS): Promise<TalkJson> {
    if (!this.connected || !text(method)) return Promise.reject(new Error("Talk peer unavailable or invalid method"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Invalid Talk timeout"));
    if (this.pending.size >= TALK_MAX_PENDING_REQUESTS) return Promise.reject(new Error("Too many Talk requests"));
    const timeout = Math.max(1, Math.ceil(Math.min(timeoutMs, TALK_MAX_TIMEOUT_MS)));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Talk request timed out; outcome may be unknown (not retried)"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ v: 1, type: "request", id, method, payload, deadline: Date.now() + timeout }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(event: string, payload: TalkJson): void {
    if (!this.connected || !text(event)) throw new Error("Talk peer unavailable or invalid event");
    this.send({ v: 1, type: "event", event, payload });
  }
  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.connected = false;
    clearTimeout(this.handshakeTimer);
    this.socket.destroy();
    this.buffer = Buffer.alloc(0);
    this.events = [];
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Talk peer disconnected; outcome may be unknown (not retried)"));
    }
    this.pending.clear();
    for (const timer of this.inboundTimers) clearTimeout(timer);
    this.inboundTimers.clear();
    safely(this.disconnected);
  }
  private data(chunk: Buffer): void {
    // Consume complete frames individually, keeping even a burst of frames bounded.
    let start = 0;
    while (start < chunk.length && !this.ended) {
      const end = chunk.indexOf(10, start);
      const stop = end < 0 ? chunk.length : end;
      if (this.buffer.length + stop - start > TALK_MAX_FRAME_BYTES) { this.close(); return; }
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, stop)]);
      if (end < 0) return;
      try {
        const line = this.utf8.decode(this.buffer);
        this.buffer = Buffer.alloc(0);
        const frame = parseTalkFrame(line);
        if (!this.connected) this.handshake(frame);
        else this.receive(frame);
      } catch { this.close(); return; }
      start = end + 1;
    }
  }
  private receive(frame: TalkFrame): void {
    if (frame.type === "response") {
      const pending = this.pending.get(frame.id);
      // Late replies to timed-out requests are harmless; never reinterpret as a new request.
      if (!pending) {
        if (frame.id > this.nextId) throw new Error("Unknown response");
        return;
      }
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.payload);
      else pending.reject(new Error("Talk remote request failed"));
    } else if (frame.type === "event") {
      // Preserve FIFO snapshots without coalescing arbitrary application events.
      // One handler runs at a time, with a bounded queue independent of RPC slots.
      // Overflow disconnects rather than silently dropping a potentially vital update.
      if (this.events.length >= TALK_MAX_PENDING_REQUESTS) { this.close(); return; }
      this.events.push(frame);
      this.drainEvents();
    } else if (frame.type === "request") {
      if (frame.id <= this.lastReceivedId) throw new Error("Replayed request");
      this.lastReceivedId = frame.id;
      const remaining = Math.min(frame.deadline - Date.now(), TALK_MAX_TIMEOUT_MS);
      if (remaining <= 0 || this.incoming >= TALK_MAX_PENDING_REQUESTS) {
        this.reply(frame.id, false, null); return;
      }
      this.incoming++;
      let done = false;
      const finish = (ok: boolean, payload: TalkJson) => {
        if (done) return;
        done = true; clearTimeout(timer); this.inboundTimers.delete(timer); this.reply(frame.id, ok, payload);
      };
      const timer = setTimeout(() => finish(false, null), remaining);
      this.inboundTimers.add(timer);
      // Slots are held until the handler actually settles, even after the reply deadline.
      // This prevents an uncooperative handler from causing unbounded concurrent execution.
      const work = Promise.resolve().then(() => {
        if (!this.connected || Date.now() >= frame.deadline) throw new Error("Expired request");
        const handler = (frame.method === LIST || frame.method === UPDATE) && this.controlRequest
          ? this.controlRequest : this.onRequest;
        if (!handler) throw new Error("Unsupported method");
        return handler(frame.method, frame.payload);
      });
      // The response timer may expire first; retain the execution slot until settlement.
      void work.then((value) => { this.incoming--; finish(true, value ?? null); },
        () => { this.incoming--; finish(false, null); });
    } else throw new Error("Unexpected handshake frame");
  }
  private drainEvents(): void {
    if (this.eventRunning || this.ended) return;
    const frame = this.events.shift();
    if (!frame) return;
    this.eventRunning = true;
    void Promise.resolve().then(() => {
      if (!this.ended) return this.onEvent?.(frame.event, frame.payload);
    }).catch(() => {}).finally(() => {
      this.eventRunning = false;
      this.drainEvents();
    });
  }
  private reply(id: number, ok: boolean, payload: TalkJson): void {
    if (!this.connected) return;
    try { this.send({ v: 1, type: "response", id, ok, payload }); }
    catch {
      // Never expose exception details, including serialization failures.
      try { this.send({ v: 1, type: "response", id, ok: false, payload: null }); } catch { this.close(); }
    }
  }
}

const LIST = "$talk.sessions", UPDATE = "$talk.update";

export async function createTalkSessionHub(options: TalkSessionHubOptions): Promise<TalkSessionHub> {
  privatePath(options.socketPath, true);
  let main = sessionIdentity({ ...sessionMetadata(options.main, process.cwd()), instanceId: randomUUID(), isMain: true });
  const peers = new Map<string, Peer>();
  const connections = new Set<Peer>();
  let closed = false;
  const sessions = () => [main, ...[...peers.values()].map((p) => p.identity)];
  const changed = () => safely(() => options.onSessions?.(sessions()));
  // libuv only ever owns this unique private name, never the published path.
  const stagingPath = join(dirname(options.socketPath), `.${randomBytes(6).toString("base64url")}`);
  const directoryOwner = lstatSync(dirname(options.socketPath));
  let owner: Stats | undefined;
  let published = false;
  const server = createServer((socket) => {
    if (closed || !published || connections.size >= TALK_MAX_SESSIONS) { socket.destroy(); return; }
    let attemptedHandshake = false;
    const peer = new Peer(socket, (frame) => {
      if (attemptedHandshake) throw new Error("Repeated handshake");
      attemptedHandshake = true;
      if (frame.type !== "hello") throw new Error("Expected hello");
      const metadata = sessionMetadata(frame.session);
      if (metadata.name === main.name || peers.has(metadata.name)
        || metadata.sessionId === main.sessionId || [...peers.values()].some(value => value.identity.sessionId === metadata.sessionId)) {
        peer.send({ v: 1, type: "reject", reason: "Session name or identity already connected" });
        // Flush rejection before closing. Peer cleanup still runs from the close event.
        socket.end(); return;
      }
      const identity = sessionIdentity({ ...metadata, instanceId: randomUUID(), isMain: false });
      peer.ready(identity);
      peer.controlRequest = async (method, payload) => {
        if (method === LIST) return sessions() as unknown as TalkJson;
        if (method === UPDATE) {
          const next = sessionMetadata(payload);
          if (next.name !== identity.name || next.sessionId !== identity.sessionId) throw new Error("Immutable identity");
          peer.identity = sessionIdentity({ ...next, instanceId: identity.instanceId, isMain: false });
          changed(); return null;
        }
        throw new Error("Unsupported method");
      };
      peer.onRequest = (method, payload) => {
        if (!options.onRequest) throw new Error("Unsupported method");
        return options.onRequest(peer, method, payload);
      };
      peer.onEvent = (event, payload) => options.onEvent?.(peer, event, payload);
      peers.set(metadata.name, peer);
      peer.send({ v: 1, type: "welcome", identity });
      changed(); safely(() => options.onPeer?.(peer));
    }, () => {
      connections.delete(peer);
      if (peer.identity && peers.get(peer.identity.name) === peer) {
        peers.delete(peer.identity.name);
        changed(); safely(() => options.onDisconnect?.(peer));
      }
    });
    connections.add(peer);
  });
  // Keep an error listener during startup and teardown, too.
  server.on("error", () => { for (const peer of connections) peer.close(); });
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => { server.off("listening", listening); reject(cause); };
      const listening = () => { server.off("error", error); resolve(); };
      server.once("error", error);
      server.once("listening", listening);
      server.listen(stagingPath);
    });
    owner = lstatSync(stagingPath);
    const directory = lstatSync(dirname(options.socketPath));
    if (!owner.isSocket() || owner.uid !== process.getuid?.() ||
        directory.dev !== directoryOwner.dev || directory.ino !== directoryOwner.ino) {
      throw new Error("Unsafe Talk socket publication");
    }
    chmodSync(stagingPath, 0o600);
    const secured = lstatSync(stagingPath);
    if (secured.dev !== owner.dev || secured.ino !== owner.ino || (secured.mode & 0o777) !== 0o600) {
      throw new Error("Unsafe Talk socket publication");
    }
    // Atomic no-replace publication: a precheck/listen race cannot clobber a winner.
    linkSync(stagingPath, options.socketPath);
    published = true;
    removeOwned(stagingPath, owner);
  } catch (error) {
    closed = true;
    for (const peer of connections) peer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeOwned(stagingPath, owner);
    throw error;
  }
  changed();
  let closing: Promise<void> | undefined;
  return {
    sessions,
    getPeer: (name) => peers.get(name),
    broadcast(event, payload) {
      if (!text(event)) throw new Error("Invalid Talk event");
      encode({ v: 1, type: "event", event, payload });
      for (const peer of peers.values()) { try { peer.notify(event, payload); } catch { peer.close(); } }
    },
    updateMain(metadata) {
      if (closed) throw new Error("Talk hub closed");
      const next = sessionMetadata(metadata, process.cwd());
      if (next.name !== main.name || next.sessionId !== main.sessionId) throw new Error("Immutable identity");
      main = sessionIdentity({ ...next, instanceId: main.instanceId, isMain: true }); changed();
    },
    close() {
      if (!closing) {
        closed = true;
        for (const peer of connections) peer.close();
        removeOwned(options.socketPath, owner);
        closing = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      return closing;
    },
  };
}

export async function connectTalkSession(options: ConnectTalkSessionOptions): Promise<TalkSessionClient> {
  privatePath(options.socketPath, false);
  const metadata = sessionMetadata(options.session, process.cwd());
  return new Promise((resolve, reject) => {
    let welcomed = false;
    const socket = createConnection(options.socketPath);
    const peer = new Peer(socket, (frame) => {
      if (frame.type === "reject") { reject(new Error(frame.reason)); peer.close(); return; }
      if (frame.type !== "welcome") throw new Error("Expected welcome");
      const identity = sessionIdentity(frame.identity);
      if (identity.name !== metadata.name || identity.sessionId !== metadata.sessionId || identity.isMain) throw new Error("Identity mismatch");
      peer.ready(identity);
      welcomed = true;
      const client: TalkSessionClient = Object.assign(peer, {
        async update(next: TalkSessionInput) {
          const value = sessionMetadata(next, process.cwd());
          if (value.name !== identity.name || value.sessionId !== identity.sessionId) throw new Error("Immutable identity");
          await peer.request(UPDATE, value as unknown as TalkJson);
          peer.identity = sessionIdentity({ ...value, instanceId: identity.instanceId, isMain: false });
        },
        async sessions() {
          const result = await peer.request(LIST, null);
          if (!Array.isArray(result) || result.length > TALK_MAX_SESSIONS + 1) throw new Error("Invalid session list");
          return result.map(sessionIdentity);
        },
      });
      resolve(client);
    }, () => {
      if (!welcomed) reject(new Error("Talk connection closed before handshake"));
      else safely(options.onDisconnect);
    });
    peer.onRequest = options.onRequest;
    peer.onEvent = options.onEvent;
    socket.once("connect", () => {
      try { peer.send({ v: 1, type: "hello", session: metadata }); } catch { peer.close(); }
    });
  });
}
