import { randomBytes, randomUUID } from "node:crypto";
import { constants, chmodSync, closeSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, type Stats } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OutputTokenRate } from "../resource-status/core.ts";
import { OPENAI_USAGE_CHANGED_EVENT, SUBAGENTS_CHANGED_EVENT, TODOS_CHANGED_EVENT } from "../resource-status/protocol.ts";
import { LIVE_HUD_MAX_BYTES, LIVE_HUD_MAX_EVENTS, LIVE_HUD_VERSION, TALK_CAPTIONS_EVENT, TALK_VISUAL_EVENT, captionCallActive, type LiveCaptions, type LiveHudEvent, type LiveHudSnapshot } from "./webcam/src/shared/live-protocol.ts";
import { activityTimestamp, activityToolName, createAgentCompletionRetention, emptyProjection, initialActivity, initialTodos, nonnegative, projectAgents, projectContext, projectTalk, projectTodos, projectUsage } from "./webcam-projection.ts";
import { createWebcamTranscript } from "./webcam-transcript.ts";
import { parseLiveCaptions } from "./webcam/src/shared/live-validation.ts";
import { parsePresentation, type Presentation, type DisplayAuthority } from "./webcam/src/shared/presentation-protocol.ts";

export interface WebcamPresentationHost {
  current(): { sessionKey: string; runId: string } | undefined;
  reset(): void;
  sync(): void;
}

export interface WebcamBridge {
  /** Explicit consent: expose visible conversation, compact tool previews, task labels/text and todos. */
  start(ctx: ExtensionContext): Promise<void>;
  stop(): Promise<void>;
  status(): string;
  updateContext(ctx: ExtensionContext): void;
  /** Optional only for legacy injected bridges; missing APIs deny presentation. */
  presentationReady?(): boolean;
  /** Private authority from the actual opted-in ready publisher, never the visual event bus. */
  presentationAuthority?(): DisplayAuthority | undefined;
  presentationSocketPath?(): string;
  setPresentationHost?(host: WebcamPresentationHost): void;
  publishPresentation?(value: Presentation | null): void;
}
interface Timer { unref?(): unknown }
export interface WebcamBridgeOptions {
  socketPath?: string;
  now?: () => number;
  identity?: () => string;
  setInterval?: (callback: () => void, milliseconds: number) => Timer;
  clearInterval?: (timer: Timer) => void;
  createServer?: () => Server;
  /** Test dependency; defaults to the current OS user. */
  uid?: () => number;
}
const MAX_CLIENTS = 4;
const HEARTBEAT_MS = 500;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function stat(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function removeOwned(path: string, owner: Stats | undefined): void {
  if (!owner) return;
  try {
    const current = stat(path);
    if (current && current.isSocket() && sameFile(current, owner)) unlinkSync(path);
  } catch { /* Never unlink an unverified or replaced pathname. */ }
}
function privateDirectory(path: string, uid: number): Stats {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid) throw new Error("Unsafe webcam directory");
  // chmod the verified descriptor, never a path that could now be a symlink.
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameFile(before, opened) || opened.uid !== uid || !opened.isDirectory()) throw new Error("Unsafe webcam directory");
    fchmodSync(fd, 0o700);
    const after = lstatSync(path);
    if (!sameFile(opened, after) || !after.isDirectory()) throw new Error("Unsafe webcam directory");
    return after;
  } finally { closeSync(fd); }
}
function safeError(collision = false): NodeJS.ErrnoException {
  return Object.assign(new Error(collision ? "Webcam bridge socket is already in use" : "Webcam bridge could not start"),
    { code: collision ? "EADDRINUSE" : "EWEBCAM" });
}

/** Registers observers only. No socket, filesystem work, or timer until start().
 * Wire once in Talk's factory; the parent owns commands and consent/UI. */
export function registerWebcamBridge(pi: ExtensionAPI, options: WebcamBridgeOptions = {}): WebcamBridge {
  const now = options.now ?? Date.now;
  const identity = options.identity ?? randomUUID;
  const schedule = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const cancel = options.clearInterval ?? (timer => clearInterval(timer as ReturnType<typeof setInterval>));
  const transcript = createWebcamTranscript(pi);
  const rate = new OutputTokenRate();
  const agentCompletions = createAgentCompletionRetention();
  agentCompletions.reset(now());
  let ctx: ExtensionContext | undefined;
  let sourceSession: string | undefined;
  let sessionId = "";
  let branchId = "";
  let startedAt = 0;
  let projection = emptyProjection();
  let captions: LiveCaptions | undefined;
  let presentation: Presentation | undefined;
  let displayScopeId = randomUUID();
  let presentationSuspended = false;
  let presentationHost: WebcamPresentationHost | undefined;
  const socketPath = options.socketPath ?? join(getAgentDir(), "webcam", "hud.sock");
  function resetPresentation() {
    displayScopeId = randomUUID();
    presentation = undefined;
    presentationHost?.reset();
  }
  function presentationAuthority(): DisplayAuthority | undefined {
    if (!ready || !accepting || presentationSuspended || !ctx || !sourceSession || !streamId || !branchId) return undefined;
    try {
      if (ctx.sessionManager.getSessionId() !== sourceSession) return undefined;
    } catch { return undefined; }
    return { sessionKey: sourceSession, scopeId: displayScopeId };
  }
  function presentationGate(value: Presentation): boolean {
    const publisher = presentationAuthority();
    if (!publisher) return false;
    if (value.version === 2) return value.scopeId === publisher.scopeId;
    const call = presentationHost?.current();
    return !!call && call.sessionKey === publisher.sessionKey && call.runId === value.runId
      && captionCallActive(projection.talk) && projection.talk.runId === value.runId;
  }
  function publishPresentation(value: Presentation | null): void {
    presentation = value && presentationGate(value) ? parsePresentation(value, {
      displayScopeId, callRunId: captionCallActive(projection.talk) ? projection.talk.runId : undefined,
    }) : undefined;
    tick(); // Full replacement/clear reaches current clients immediately; never reenter controller.
  }
  let todosKnown = false;
  let accepting = true; // Cache initial resource announcements before session_start.
  let phase: LiveHudSnapshot["session"]["status"] = "idle";
  let state = "stopped";
  let streamId = "";
  let sequence = 0;
  let server: Server | undefined;
  let timer: Timer | undefined;
  let ready = false;
  let publishedPath: string | undefined;
  let stagingPath: string | undefined;
  let owned: Stats | undefined;
  const clients = new Set<Socket>();
  let transition = Promise.resolve();

  function serialized(operation: () => Promise<void>): Promise<void> {
    const result = transition.then(operation);
    transition = result.catch(() => {});
    return result;
  }
  function clearSession(): void {
    resetPresentation();
    captions = undefined;
    transcript.reset();
    ctx = undefined;
    sourceSession = undefined;
    sessionId = branchId = "";
    startedAt = 0;
    phase = "idle";
    projection = emptyProjection();
    agentCompletions.reset(now());
    todosKnown = false;
    rate.reset();
  }
  function updateContext(next: ExtensionContext): void {
    let source: string;
    try { source = next.sessionManager.getSessionId(); } catch { transcript.reset(); return; }
    if (ctx && source !== sourceSession) clearSession();
    if (!ctx) {
      sessionId = identity(); // Never expose a custom session ID/name/path.
      startedAt = activityTimestamp(now()) ?? 0;
      resetActivity(next);
      // Prefer an early authoritative todo event; otherwise restore details.
      if (!todosKnown) {
        const todos = initialTodos(next);
        projection = { ...projection, todos: todos.items, todoCounts: todos.counts };
        todosKnown = true;
      }
      try { phase = next.isIdle() ? "idle" : "running"; } catch { phase = "idle"; }
    }
    ctx = next;
    sourceSession = source;
    accepting = true;
  }
  function resetActivity(next: ExtensionContext): void {
    resetPresentation();
    captions = undefined;
    transcript.reset(next);
    branchId = randomUUID();
    projection.events = initialActivity(next, activityTimestamp(now()) ?? 0);
  }
  function addActivity(event: Omit<LiveHudEvent, "id" | "timestamp" | "toolName">, rawToolName?: string): void {
    if (!ctx || !branchId) return;
    const toolName = activityToolName(rawToolName);
    const timestamp = Math.max(projection.events.at(-1)?.timestamp ?? 0, activityTimestamp(now()) ?? 0);
    projection.events.push({ id: randomUUID(), timestamp, ...event, ...(toolName ? { toolName } : {}) });
    projection.events = projection.events.slice(-LIVE_HUD_MAX_EVENTS);
  }
  function snapshot(): LiveHudSnapshot {
    projection.agents = agentCompletions.snapshot(now());
    const at = Math.max(startedAt, projection.events.at(-1)?.timestamp ?? 0, activityTimestamp(now()) ?? 0);
    const current = projectContext(ctx, rate.value);
    return {
      version: LIVE_HUD_VERSION, streamId, sessionId, branchId, sequence: ++sequence, timestamp: at,
      events: projection.events, transcript: transcript.snapshot(ctx),
      ...(presentation && presentationGate(presentation) ? {
        ...(presentation.version === 2 ? { displayScopeId } : {}), presentation: structuredClone(presentation),
      } : {}),
      ...(captions && captionCallActive(projection.talk) && captions.runId === projection.talk.runId
        ? { captions: { runId: captions.runId, lines: captions.lines.filter(line => line.expiresAt > at) } } : {}),
      session: { provider: current.provider, model: current.model, status: phase, startedAt, elapsedMs: Math.max(0, at - startedAt) },
      context: current.context,
      agents: projection.agents, todos: projection.todos, todoCounts: projection.todoCounts, usage: projection.usage, talk: projection.talk,
    };
  }
  function send(client: Socket, frame: string): void {
    // No queues, drains, or retries: a slow client reconnects for a full snapshot.
    if (client.destroyed || client.writableLength > 0) { client.destroy(); return; }
    // A single bounded frame may exceed Node's high-water mark even for a fast
    // reader. Give that frame one heartbeat to drain; never queue another behind it.
    try { client.write(frame); } catch { transcript.reset(); client.destroy(); }
  }
  function frame(): string | undefined {
    if (!ctx || !sessionId) return undefined;
    const value = JSON.stringify(snapshot()) + "\n";
    return Buffer.byteLength(value) <= LIVE_HUD_MAX_BYTES ? value : undefined;
  }
  function tick(): void {
    // Expire completion payloads even with no connected HUD; no extra timer.
    projection.agents = agentCompletions.snapshot(now());
    if (!ready || clients.size === 0) return;
    try {
      const value = frame();
      for (const client of clients) {
        if (value) send(client, value);
        else client.destroy();
      }
    } catch { for (const client of clients) client.destroy(); }
  }
  function observe<T>(project: (payload: unknown) => T | undefined, apply: (value: T) => void) {
    return (payload: unknown) => {
      if (!accepting) return;
      try { const value = project(payload); if (value !== undefined) apply(value); } catch { /* Invalid bus data is ignored. */ }
    };
  }
  pi.events.on(SUBAGENTS_CHANGED_EVENT, observe(projectAgents, value => { projection.agents = agentCompletions.update(value, now()); }));
  pi.events.on(TODOS_CHANGED_EVENT, observe(projectTodos, value => {
    projection = { ...projection, todos: value.items, todoCounts: value.counts };
    todosKnown = true;
  }));
  pi.events.on(OPENAI_USAGE_CHANGED_EVENT, observe(projectUsage, value => { projection.usage = value; }));
  pi.events.on(TALK_VISUAL_EVENT, observe(projectTalk, value => {
    if (!captionCallActive(value) || value.runId !== projection.talk.runId) {
      captions = undefined;
      // Legacy call panels end with their call. Standalone webcam panels do not.
      if (presentation?.version === 1) resetPresentation();
    }
    projection.talk = value;
  }));
  pi.events.on(TALK_CAPTIONS_EVENT, payload => {
    if (!accepting || !ready) return; // Sharing opt-in is unchanged; never cache while off.
    const value = parseLiveCaptions(payload, projection.talk, now());
    if (value) captions = value;
  });

  pi.on("session_start", async (_event, next) => { presentationSuspended = false; updateContext(next); transcript.reset(next); });
  const suspendPresentation = () => { presentationSuspended = true; resetPresentation(); };
  pi.on("session_before_tree", suspendPresentation);
  pi.on("session_before_switch", suspendPresentation);
  pi.on("session_tree", async (_event, next) => {
    if (!accepting) return;
    updateContext(next);
    resetActivity(next);
    presentationSuspended = false;
    const todos = initialTodos(next);
    projection = { ...projection, todos: todos.items, todoCounts: todos.counts };
    todosKnown = true;
    projection.agents = [];
    agentCompletions.reset(now());
    rate.reset();
  });
  pi.on("model_select", async (_event, next) => { if (!accepting) return; updateContext(next); rate.reset(); });
  pi.on("agent_start", async (_event, next) => {
    if (!accepting) return;
    updateContext(next); phase = "thinking";
    addActivity({ role: "system", kind: "run", status: "started" });
  });
  pi.on("turn_start", async (_event, next) => { if (!accepting) return; updateContext(next); transcript.reconcile(next); phase = "thinking"; rate.start(now()); });
  pi.on("message_start", async (event, next) => {
    if (!accepting) return;
    updateContext(next);
    transcript.messageStart(next, event.message);
    if (event.message.role === "assistant") { phase = "thinking"; rate.start(now()); }
    // Accepted main-session messages, not raw input (which extensions may consume).
    if (event.message.role === "user") addActivity({ role: "user", kind: "user_turn", status: "received" });
  });
  pi.on("message_update", async (event, next) => {
    if (!accepting) return;
    updateContext(next);
    if (event.message.role !== "assistant") return;
    transcript.messageUpdate(event.message);
    // Usage/phase remain separate from the text-only transcript producer.
    const output = nonnegative(event.message.usage?.output);
    if (output !== undefined) rate.update(output, now());
    const kind = event.assistantMessageEvent?.type;
    phase = kind === "thinking_start" || kind === "thinking_delta" ? "thinking" : "running";
  });
  pi.on("message_end", async (event, next) => {
    if (!accepting) return;
    updateContext(next);
    transcript.messageEnd(next, event.message);
    if (event.message.role !== "assistant") return;
    const output = nonnegative(event.message.usage?.output);
    if (output !== undefined) rate.finish(output, now());
    addActivity({ role: "assistant", kind: "assistant_finished", status: "finished" });
  });
  // Main extension lifecycle only. Never ingest child history/resource-bus activity.
  // Nested execution belongs to an orchestration tool, not a main transcript call.
  pi.on("tool_execution_start", async (event, next) => {
    if (!accepting) return;
    updateContext(next); phase = "running";
    if (transcript.reconcile(next)) transcript.toolStart(event.toolCallId, event.parentToolCallId);
    if (!event.parentToolCallId) addActivity({ role: "toolResult", kind: "tool", status: "started" }, event.toolName);
  });
  pi.on("tool_execution_end", async (event, next) => {
    if (!accepting) return;
    updateContext(next);
    if (!event.parentToolCallId) addActivity({ role: "toolResult", kind: "tool", status: event.isError ? "failed" : "completed" }, event.toolName);
  });
  pi.on("session_before_compact", async (_event, next) => {
    if (!accepting) return;
    updateContext(next);
    addActivity({ role: "system", kind: "compaction", status: "started" });
  });
  pi.on("session_compact", async (_event, next) => {
    if (!accepting) return;
    updateContext(next);
    transcript.reconcile(next, true);
    addActivity({ role: "system", kind: "compaction", status: "completed" });
  });
  pi.on("session_compact_failed", async (event, next) => {
    if (!accepting) return;
    updateContext(next);
    addActivity({ role: "system", kind: "compaction", status: event.aborted ? "aborted" : "failed" });
  });
  // agent_end may precede recovery or queued work; only settlement proves idle.
  pi.on("turn_end", async (_event, next) => { if (!accepting) return; updateContext(next); transcript.reconcile(next, true); });
  pi.on("agent_end", async (_event, next) => { if (!accepting) return; updateContext(next); transcript.reconcile(next, true); phase = "running"; });
  pi.on("agent_settled", async (event, next) => {
    if (!accepting) return;
    updateContext(next); transcript.reconcile(next, true); phase = "idle";
    addActivity({ role: "system", kind: "run", status: event.aborted ? "aborted" : "settled" });
  });

  async function dispose(): Promise<void> {
    resetPresentation();
    ready = false;
    presentationHost?.sync();
    if (timer) { cancel(timer); timer = undefined; }
    for (const client of clients) client.destroy();
    clients.clear();
    // Node/libuv unconditionally unlinks its listen pathname on close. Bind a
    // private staging name and publish a hard link atomically instead: a loser
    // never touches hud.sock, and close cannot unlink a replacement hud.sock.
    if (publishedPath) removeOwned(publishedPath, owned);
    const previous = server;
    server = undefined;
    if (previous) await new Promise<void>(resolve => {
      try { previous.close(() => resolve()); } catch { resolve(); }
    });
    if (stagingPath) removeOwned(stagingPath, owned);
    publishedPath = stagingPath = undefined;
    owned = undefined;
  }
  function stop(): Promise<void> {
    transcript.stop();
    accepting = false;
    clearSession();
    ready = false;
    return serialized(async () => {
      transcript.stop();
      accepting = false;
      clearSession();
      await dispose();
      state = "stopped";
    });
  }
  pi.on("session_shutdown", async () => { await stop(); });

  function start(next: ExtensionContext): Promise<void> {
    return serialized(async () => {
      updateContext(next);
      presentationSuspended = false;
      if (ready) return;
      state = "starting";
      try {
        if (server) await dispose();
        const path = socketPath;
        if (!isAbsolute(path)) throw safeError();
        const directory = dirname(path);
        const uid = (options.uid ?? process.getuid)?.();
        if (uid === undefined) throw safeError();
        const directoryOwner = privateDirectory(directory, uid);
        if (stat(path)) throw safeError(true); // Including stale sockets/symlinks.
        stagingPath = join(directory, `.hud-${randomBytes(6).toString("hex")}`);
        const local = (options.createServer ?? createServer)();
        server = local;
        local.on("connection", client => {
          client.on("error", () => { transcript.reset(); client.destroy(); });
          client.on("close", () => {
            clients.delete(client);
            // Never replay pre-disconnect content to a reconnecting renderer.
            resetPresentation();
          });
          client.on("data", () => { client.destroy(); }); // This is not a command channel.
          if (!ready || clients.size >= MAX_CLIENTS) { client.destroy(); return; }
          client.unref();
          clients.add(client);
          try { const value = frame(); if (value) send(client, value); else client.destroy(); }
          catch { client.destroy(); }
        });
        // Keep an error listener even after listen settles and during teardown.
        local.on("error", () => {
          transcript.stop();
          resetPresentation();
          if (ready) { state = "error"; ready = false; presentationHost?.sync(); void serialized(dispose); }
        });
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => { local.off("listening", listening); reject(error); };
          const listening = () => { local.off("error", failed); resolve(); };
          local.once("error", failed);
          local.once("listening", listening);
          local.listen(stagingPath);
        });
        owned = lstatSync(stagingPath);
        if (!owned.isSocket() || owned.uid !== uid || !sameFile(lstatSync(directory), directoryOwner)) throw safeError();
        // Directory is private; lstat above verifies this is our newly bound socket.
        // chmod on a socket descriptor is not portable across supported systems.
        chmodSync(stagingPath, 0o600);
        const secured = lstatSync(stagingPath);
        if (!sameFile(secured, owned) || (secured.mode & 0o777) !== 0o600) throw safeError();
        try { linkSync(stagingPath, path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw safeError(true);
          throw error;
        }
        publishedPath = path;
        removeOwned(stagingPath, owned);
        streamId = identity();
        sequence = 0;
        transcript.start(next);
        ready = true;
        state = "live";
        presentationHost?.sync();
        local.unref();
        timer = schedule(tick, HEARTBEAT_MS);
        timer.unref?.();
      } catch (error) {
        transcript.stop();
        await dispose();
        state = "error";
        throw safeError((error as NodeJS.ErrnoException).code === "EADDRINUSE");
      }
    });
  }
  return { start, stop, status: () => state, updateContext,
    presentationReady: () => ready && accepting && !!ctx,
    presentationAuthority,
    presentationSocketPath: () => socketPath,
    setPresentationHost: host => { resetPresentation(); presentationHost = host; host.sync(); },
    publishPresentation,
  };
}
