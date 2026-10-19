import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWebcamBridge, type LiveSnapshot, type WebcamMultisession } from "../extensions/talk/webcam-bridge.ts";
import { emptyProjection } from "../extensions/talk/webcam-projection.ts";
import { LIVE_HUD_MAX_BYTES, TALK_CAPTIONS_EVENT, TALK_VISUAL_EVENT } from "../extensions/talk/webcam/src/shared/live-protocol.ts";
import { parseLiveHudSnapshot } from "../extensions/talk/webcam/src/shared/live-validation.ts";
import { activeLiveHudSnapshot, createLiveHudMultisession, LIVE_HUD_MAX_SESSIONS, LIVE_HUD_MULTI_MAX_BYTES, parseLiveHudMultisession } from "../extensions/talk/webcam/src/shared/multisession-protocol.ts";
import { createLiveHudClient } from "../extensions/talk/webcam/src/main/live-client.ts";
import { projectLiveHud } from "../extensions/talk/webcam/src/shared/live-projection.ts";

const AT = 1_700_000_000_000;
function snapshot(label = "one", overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return { version: 1, streamId: `opaque-stream-${label}`, sessionId: `opaque-session-${label}`, branchId: `branch-${label}`,
    sequence: 1, timestamp: AT, session: { provider: "test", model: `model-${label}`, status: "running", startedAt: AT, elapsedMs: 0 },
    context: { tokens: 123, contextWindow: 1000, percent: 12.3 }, ...emptyProjection(),
    transcript: [{ id: `text-${label}`, role: "assistant", text: `Visible ${label}` }],
    todos: [{ id: 1, text: `Todo ${label}`, completed: false }], todoCounts: { total: 1, pending: 1, completed: 0 },
    agents: [{ id: 1, label: `Agent ${label}`, task: `Task ${label}`, status: "running", contextTokens: 30 }],
    usage: { status: "ready", weekly: { remainingPercent: 70, usedPercent: 30 }, updatedAt: AT }, ...overrides };
}
function input(): WebcamMultisession {
  return { mainSessionId: "real-main", activeSessionId: "real-receiver", sessions: [
    { instanceId: "instance-main", sessionId: "real-main", name: "Main name", cwd: "/absolute/main", isMain: true, snapshot: snapshot("main") },
    { instanceId: "instance-receiver", sessionId: "real-receiver", name: "Receiver name", cwd: "/absolute/receiver", isMain: false, snapshot: snapshot("receiver") },
  ] };
}
const clock = { streamId: "owner-generation", sequence: 1, timestamp: AT };
function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const bus = new Map<string, Array<(event: unknown) => unknown>>();
  const pi = { on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {};
  }, events: { on(name: string, handler: (event: unknown) => unknown) {
    bus.set(name, [...(bus.get(name) ?? []), handler]); return () => {};
  }, emit(name: string, event: unknown) { for (const handler of bus.get(name) ?? []) handler(event); } } } as unknown as ExtensionAPI;
  return { pi, async event(name: string, ctx: ExtensionContext, event: unknown = {}) {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  } };
}
function context(session = "real-main", text = "Visible public text"): ExtensionContext {
  return { cwd: "/NEVER_IN_V1/private-cwd", model: { provider: "test", id: "model", contextWindow: 1000 },
    isIdle: () => true, getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 1000 }),
    sessionManager: { getSessionId: () => session, getLeafId: () => "leaf", getSessionName: () => "NEVER_IN_V1 session name",
      getBranch: () => [{ type: "message", id: "entry", timestamp: new Date(AT).toISOString(), message: {
        role: "assistant", content: [{ type: "thinking", thinking: "NEVER_REASONING" }, { type: "text", text }],
      } }] },
  } as unknown as ExtensionContext;
}
async function until(predicate: () => unknown) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); }
  assert.fail("Timed out waiting for data-only webcam test");
}

test("v2 separates identity and full projections, derives main/active flags, and leaves v1 exact", () => {
  const source = input(), envelope = createLiveHudMultisession(source, clock)!;
  assert.ok(envelope);
  assert.deepEqual(envelope.sessions.map(row => [row.isMain, row.isActive]), [[true, false], [false, true]]);
  assert.equal(envelope.sessions[1]!.name, "Receiver name");
  assert.equal(envelope.sessions[1]!.cwd, "/absolute/receiver");
  assert.deepEqual(envelope.sessions.map(row => row.snapshot), source.sessions.map(row => row.snapshot));
  assert.deepEqual(activeLiveHudSnapshot(envelope, AT), source.sessions[1]!.snapshot);
  assert.notEqual(envelope.sessions[1]!.snapshot, source.sessions[1]!.snapshot);
  assert.equal(parseLiveHudSnapshot(envelope), null);
  for (const row of envelope.sessions) {
    assert.ok(parseLiveHudSnapshot(row.snapshot));
    assert.doesNotMatch(JSON.stringify(row.snapshot), /real-main|real-receiver|absolute|Main name|Receiver name|isActive|isMain|instanceId/);
    assert.equal(parseLiveHudSnapshot({ ...row.snapshot, name: row.name }), null);
  }
  source.sessions[1]!.snapshot!.todos[0]!.text = "Mutation";
  assert.equal(envelope.sessions[1]!.snapshot!.todos[0]!.text, "Todo receiver");
  const absent = createLiveHudMultisession({ ...input(), activeSessionId: "disconnected", sessions: [input().sessions[0]!] }, clock)!;
  assert.equal(activeLiveHudSnapshot(absent, AT), null, "no implicit fallback to main after revocation");
  assert.equal(absent.sessions[0]!.isActive, false);
});

test("derived active display trusts only fresh main authority and never mutates source rows", () => {
  const source = input();
  const main = source.sessions[0]!.snapshot!;
  main.talk = { mode: "facetime", phase: "connected", runId: "main-call", voiceReady: true, audioEnabled: true };
  main.captions = { runId: "main-call", lines: [{ id: "line", speaker: "assistant", text: "Actual main speech", final: true, updatedAt: AT, expiresAt: AT + 4000 }] };
  main.displayScopeId = "main-scope";
  main.presentation = { version: 2, scopeId: "main-scope", id: "main-panel", text: "Actual main display" };
  const remote = source.sessions[1]!.snapshot!;
  remote.displayScopeId = "remote-scope";
  remote.presentation = { version: 2, scopeId: "remote-scope", id: "remote-panel", text: "Never display remote" };
  const value = createLiveHudMultisession(source, clock)!;
  const before = structuredClone(value);
  const active = activeLiveHudSnapshot(value, AT)!;
  for (const field of ["session", "context", "agents", "todos", "transcript", "events"] as const) assert.deepEqual(active[field], remote[field]);
  assert.deepEqual(active.talk, main.talk);
  assert.equal(active.captions!.lines[0]!.text, "Actual main speech");
  assert.equal(active.presentation!.id, "main-panel");
  assert.equal(active.displayScopeId, "main-scope");
  assert.deepEqual(value, before);
  value.sessions[0]!.snapshot!.talk.audioEnabled = false;
  assert.equal(activeLiveHudSnapshot(value, AT)!.captions, undefined, "only main audio gate authorizes captions");
  value.sessions[0]!.snapshot!.talk.audioEnabled = true;
  value.sessions[0]!.snapshot!.captions!.runId = "old-call";
  assert.equal(activeLiveHudSnapshot(value, AT)!.captions, undefined);
  value.sessions[0]!.snapshot!.timestamp = AT - 5000;
  const stale = activeLiveHudSnapshot(value, AT)!;
  assert.equal(stale.talk.mode, "inactive");
  assert.equal(stale.captions, undefined);
  assert.equal(stale.presentation, undefined);
  assert.equal(stale.displayScopeId, undefined);
  value.sessions[0]!.snapshot = null;
  assert.equal(activeLiveHudSnapshot(value, AT)!.presentation, undefined);
  value.sessions[1]!.snapshot = null;
  assert.equal(activeLiveHudSnapshot(value, AT), null);
});

test("envelope rejects invalid flags, identities, nested/unbounded/raw payloads, getters and unknown keys", () => {
  const valid = createLiveHudMultisession(input(), clock)!;
  const invalid: unknown[] = [
    { ...valid, version: 1 }, { ...valid, command: "switch" }, { ...valid, timestamp: -1 }, { ...valid, sequence: 1.5 },
    { ...valid, mainSessionId: "not-in-list" }, { ...valid, activeSessionId: "" },
    ...[
      { isActive: true }, { isMain: false }, { cwd: "relative/path" }, { cwd: "/bad\npath" },
      { name: "x".repeat(257) }, { name: "🙂".repeat(65) }, { name: "bad\u202eidentity" }, { instanceId: "" },
      { snapshot: { ...snapshot(), args: { secret: "raw" } } }, { snapshot: valid }, { extra: "raw result" },
      { snapshot: { ...snapshot(), transcript: [{ id: "x", role: "assistant", text: "x".repeat(2049) }] } },
    ].map(patch => ({ ...valid, sessions: [{ ...valid.sessions[0], ...patch }, valid.sessions[1]] })),
    { ...valid, sessions: [valid.sessions[0], valid.sessions[0]] },
    { ...valid, sessions: [valid.sessions[0], { ...valid.sessions[1], instanceId: valid.sessions[0]!.instanceId }] },
    { ...valid, sessions: Array(LIVE_HUD_MAX_SESSIONS + 1).fill(valid.sessions[0]) },
    { ...valid, sessions: [] },
  ];
  for (const value of invalid) assert.equal(parseLiveHudMultisession(value), null);
  let invoked = false;
  const getter = { ...valid.sessions[0], get name() { invoked = true; throw new Error("never"); } };
  assert.equal(parseLiveHudMultisession({ ...valid, sessions: [getter, valid.sessions[1]] }), null);
  assert.equal(invoked, false);
  const withGetter = { ...input().sessions[0], get name(): string { invoked = true; throw new Error("never"); } };
  assert.equal(createLiveHudMultisession({ ...input(), sessions: [withGetter as WebcamMultisession['sessions'][number]] }, clock), null);
  assert.equal(invoked, false, "the bridge input adapter also avoids accessors");
});

test("all bounded session projections survive concurrently, including envelopes larger than legacy frames", () => {
  const full = snapshot("large", { todos: Array.from({ length: 100 }, (_, id) => ({ id, text: "t".repeat(1000), completed: false })),
    todoCounts: { total: 100, pending: 100, completed: 0 } });
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < LIVE_HUD_MAX_BYTES);
  const value: WebcamMultisession = { mainSessionId: "s-0", activeSessionId: "s-15", sessions: Array.from({ length: LIVE_HUD_MAX_SESSIONS }, (_, id) => ({
    instanceId: `i-${id}`, sessionId: `s-${id}`, name: `Session ${id}`, cwd: `/workspace/${id}`, isMain: id === 0, snapshot: full,
  })) };
  const envelope = createLiveHudMultisession(value, clock)!;
  assert.equal(LIVE_HUD_MAX_SESSIONS, 65, "main plus 64 destinations");
  assert.equal(envelope.sessions.length, LIVE_HUD_MAX_SESSIONS);
  const size = Buffer.byteLength(JSON.stringify(envelope));
  assert.ok(size > LIVE_HUD_MAX_BYTES && size < LIVE_HUD_MULTI_MAX_BYTES);
  assert.ok(envelope.sessions.every(row => row.snapshot!.todos.length === 100));
  assert.equal(activeLiveHudSnapshot(envelope, AT)!.todos.length, 100);
  assert.equal(createLiveHudMultisession({ ...value, sessions: [...value.sessions, { ...value.sessions[0]!, instanceId: "extra", sessionId: "extra" }] }, clock), null);
});

test("app accepts large fragmented envelopes and independently expires only the old conversation", async t => {
  const dir = mkdtempSync("/tmp/pi-webcam-envelope-"), path = join(dir, "hud.sock");
  let now = AT, peer: Socket | undefined;
  const data = input();
  for (const row of data.sessions) {
    row.snapshot = snapshot(row.isMain ? "main" : "receiver", {
      todos: Array.from({ length: 100 }, (_, id) => ({ id, text: "🙂" + "t".repeat(1000), completed: false })),
      todoCounts: { total: 100, pending: 100, completed: 0 }, timestamp: row.isMain ? AT : AT - 4999,
    });
  }
  const envelope = createLiveHudMultisession(data, clock)!;
  const bytes = Buffer.from(JSON.stringify(envelope) + "\n");
  assert.ok(bytes.length > LIVE_HUD_MAX_BYTES);
  const server = createServer(socket => {
    peer = socket; socket.on("error", () => {});
    const split = bytes.indexOf(Buffer.from("🙂")) + 2;
    socket.write(bytes.subarray(0, split)); socket.write(bytes.subarray(split));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const client = createLiveHudClient({ socketPath: path, now: () => now, onState() {}, heartbeatMs: 5 });
  t.after(async () => {
    client.close(); peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  client.start();
  await until(() => client.getState().snapshot?.todos.length === 100);
  assert.equal(client.getState().multisession!.sessions.length, 2);
  assert.ok(client.getState().snapshot!.todos[0]!.text.startsWith("🙂"));
  now++;
  await until(() => client.getState().snapshot === null);
  assert.equal(client.getState().connection, "live", "a stale receiver does not stale a fresh owner envelope");
  assert.ok(client.getState().multisession!.sessions[0]!.snapshot);
  assert.equal(client.getState().multisession!.sessions[1]!.snapshot, null);
});

test("client heartbeat expires main authority without expiring a fresh selected conversation", async t => {
  const dir = mkdtempSync("/tmp/pi-webcam-main-expiry-"), path = join(dir, "hud.sock");
  let now = AT;
  const data = input(), main = data.sessions[0]!.snapshot!;
  main.timestamp = AT - 4999;
  main.talk = { mode: "facetime", phase: "connected", runId: "voice", voiceReady: true, audioEnabled: true };
  main.captions = { runId: "voice", lines: [{ id: "line", speaker: "assistant", text: "Main speech", final: false, updatedAt: main.timestamp, expiresAt: AT + 3000 }] };
  main.displayScopeId = "scope";
  main.presentation = { version: 2, scopeId: "scope", id: "panel", text: "Main display" };
  let peer: Socket | undefined;
  const server = createServer(socket => { peer = socket; socket.on("error", () => {}); socket.write(JSON.stringify(createLiveHudMultisession(data, clock)) + "\n"); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const client = createLiveHudClient({ socketPath: path, now: () => now, heartbeatMs: 5, onState() {} });
  t.after(async () => { client.close(); peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  client.start();
  await until(() => client.getState().snapshot?.captions?.lines.length);
  assert.equal(client.getState().snapshot!.presentation!.id, "panel");
  assert.equal(client.getState().snapshot!.talk.runId, "voice");
  now++;
  await until(() => client.getState().multisession?.sessions[0]?.snapshot === null);
  const state = client.getState();
  assert.equal(state.connection, "live");
  assert.equal(state.snapshot!.session.model, "model-receiver");
  assert.equal(state.snapshot!.talk.mode, "inactive");
  assert.equal(state.snapshot!.captions, undefined);
  assert.equal(state.snapshot!.presentation, undefined);
  assert.equal(state.snapshot!.displayScopeId, undefined);
});

test("multisession backpressure destroys slow peers without queuing frames or drain listeners", async t => {
  const dir = mkdtempSync("/tmp/pi-webcam-slow-"), path = join(dir, "hud.sock");
  const ticks = new Set<() => void>();
  let writes = 0, accepted: Socket | undefined;
  const bridge = registerWebcamBridge(fakePi().pi, { socketPath: path, now: () => AT,
    createServer() {
      const server = createServer();
      server.on("connection", socket => {
        accepted = socket;
        Object.defineProperty(socket, "writableLength", { get: () => writes ? 128 : 0 });
        socket.write = ((bytes: string) => {
          writes++;
          assert.equal(JSON.parse(bytes).version, 2);
          return false;
        }) as Socket["write"];
      });
      return server;
    },
    setInterval(callback) { ticks.add(callback); return { callback, unref() {} }; },
    clearInterval(timer) { ticks.delete((timer as { callback: () => void }).callback); },
  });
  let peer: Socket | undefined;
  t.after(async () => { peer?.destroy(); await bridge.stop(); rmSync(dir, { recursive: true, force: true }); });
  bridge.setMultisession!(input());
  await bridge.start(context());
  peer = createConnection(path); peer.on("error", () => {});
  await until(() => writes === 1);
  for (let i = 0; i < 20; i++) for (const tick of ticks) tick();
  await until(() => accepted?.destroyed);
  assert.equal(writes, 1);
  assert.equal(accepted!.listenerCount("drain"), 0);
});

test("receiver collection is explicitly opted in, reusable, redacted and socket/authority free", async () => {
  const fake = fakePi(), ticks = new Set<() => void>();
  let sockets = 0;
  const bridge = registerWebcamBridge(fake.pi, { now: () => AT, createServer() { sockets++; throw new Error("No socket allowed"); },
    setInterval(callback) { ticks.add(callback); return { callback, unref() {} }; },
    clearInterval(timer) { ticks.delete((timer as { callback: () => void }).callback); } });
  const ctx = context("REAL_SOURCE_ID", "Public text Bearer abcdefghijklmnop");
  await fake.event("session_start", ctx);
  assert.equal(ticks.size, 0);
  const frames: Array<LiveSnapshot | null> = [];
  const dispose = await bridge.startProjection!(ctx, value => frames.push(value));
  assert.equal(sockets, 0);
  assert.equal(ticks.size, 1);
  assert.equal(bridge.status(), "projecting");
  assert.equal(bridge.presentationReady!(), false);
  assert.equal(bridge.presentationAuthority!(), undefined);
  const first = frames.at(-1)!;
  assert.match(first.transcript![0]!.text, /Public text \[redacted authorization\]/);
  assert.doesNotMatch(JSON.stringify(first), /NEVER_REASONING|NEVER_IN_V1|REAL_SOURCE_ID|abcdefghijklmnop/);
  await fake.event("tool_execution_start", ctx, { toolCallId: "private-id", toolName: "read", get args() { throw new Error("raw args"); } });
  await fake.event("tool_execution_end", ctx, { toolCallId: "private-id", toolName: "read", isError: false, get result() { throw new Error("raw result"); } });
  for (const tick of ticks) tick();
  assert.deepEqual(frames.at(-1)!.events.map(row => row.status), ["finished", "started", "completed"]);
  fake.pi.events.emit(TALK_VISUAL_EVENT, { phase: "connected", mode: "facetime", runId: "voice", voiceReady: true, audioEnabled: true });
  fake.pi.events.emit(TALK_CAPTIONS_EVENT, { runId: "voice", lines: [{ id: "caption", speaker: "assistant", text: "Speech", final: true, updatedAt: AT, expiresAt: AT + 4000 }] });
  for (const tick of ticks) tick();
  assert.equal(frames.at(-1)!.captions!.lines[0]!.text, "Speech");
  bridge.publishPresentation!({ version: 2, scopeId: "fake", id: "fake", text: "Cannot gain authority" });
  assert.equal(frames.at(-1)!.presentation, undefined);
  const replacements: Array<LiveSnapshot | null> = [];
  const end = await bridge.startProjection!(ctx, value => {
    replacements.push(value);
    bridge.setMultisession!({ mainSessionId: "REAL_SOURCE_ID", activeSessionId: "REAL_SOURCE_ID", sessions: [{
      instanceId: "local", sessionId: "REAL_SOURCE_ID", name: "Local", cwd: "/local", isMain: true, snapshot: value,
    }] });
  });
  assert.ok(replacements.length < 5, "synchronous coordinator feedback does not recursively collect");
  assert.equal(frames.at(-1), null, "new subscriber revokes the previous one");
  dispose(); assert.equal(ticks.size, 1, "old disposer cannot revoke new subscription");
  await fake.event("session_before_switch", ctx);
  assert.equal(replacements.at(-1), null);
  for (const tick of ticks) tick();
  assert.equal(replacements.at(-1), null, "suspended session never replays content");
  await fake.event("session_start", context("new-source", "New branch only"));
  for (const tick of ticks) tick();
  assert.equal(replacements.at(-1)!.transcript![0]!.text, "New branch only");
  end(); end();
  assert.equal(replacements.at(-1), null);
  assert.equal(ticks.size, 0);
  const count = replacements.length;
  await fake.event("message_update", ctx, { message: { role: "assistant", content: [{ type: "text", text: "Not shared" }] } });
  assert.equal(replacements.length, count);
  await bridge.stop();
  assert.equal(ticks.size, 0); assert.equal(sockets, 0);
  const shutdown: Array<LiveSnapshot | null> = [];
  const pending = bridge.startProjection!(ctx, value => shutdown.push(value));
  await bridge.stop(); // Stop can race a still-queued explicit opt-in.
  const lateDisposer = await pending;
  lateDisposer();
  assert.equal(shutdown.at(-1), null);
  assert.equal(ticks.size, 0);
});

test("main-only socket delivers all sessions while visuals/captions/presentation follow only active; revoke and expiry clear", async t => {
  const dir = mkdtempSync("/tmp/pi-webcam-multi-"), ticks = new Set<() => void>();
  let now = AT;
  const fake = fakePi();
  const bridge = registerWebcamBridge(fake.pi, { socketPath: join(dir, "webcam", "hud.sock"), now: () => now,
    setInterval(callback) { ticks.add(callback); return { callback, unref() {} }; },
    clearInterval(timer) { ticks.delete((timer as { callback: () => void }).callback); } });
  const client = createLiveHudClient({ socketPath: join(dir, "webcam", "hud.sock"), now: () => now,
    onState() {}, heartbeatMs: 5, reconnectMinMs: 100, reconnectMaxMs: 100 });
  t.after(async () => { client.close(); await bridge.stop(); rmSync(dir, { recursive: true, force: true }); });
  const ctx = context();
  const data = input();
  data.sessions[1]!.snapshot = snapshot("receiver", { displayScopeId: "remote-scope",
    presentation: { version: 2, scopeId: "remote-scope", id: "remote-panel", text: "Inactive remote panel" } });
  bridge.setMultisession!(data);
  assert.equal(ticks.size, 0, "envelope setter never opts in or starts resources");
  await bridge.start(ctx);
  fake.pi.events.emit(TALK_VISUAL_EVENT, { phase: "connected", mode: "facetime", runId: "main-call", voiceReady: true, audioEnabled: true });
  fake.pi.events.emit(TALK_CAPTIONS_EVENT, { runId: "main-call", lines: [{ id: "caption", speaker: "assistant", text: "Main speech", final: true, updatedAt: AT, expiresAt: AT + 4000 }] });
  const authority = bridge.presentationAuthority!()!;
  bridge.publishPresentation!({ version: 2, scopeId: authority.scopeId, id: "main-panel", text: "Main only presentation" });
  client.start();
  await until(() => client.getState().multisession);
  const state = client.getState();
  assert.equal(state.snapshot!.session.model, "model-receiver");
  assert.equal(state.multisession!.sessions[0]!.snapshot!.presentation!.id, "main-panel");
  assert.equal(state.snapshot!.presentation!.id, "main-panel");
  assert.equal(state.snapshot!.displayScopeId, authority.scopeId);
  assert.equal(state.snapshot!.talk.runId, "main-call");
  assert.equal(state.multisession!.sessions[1]!.snapshot!.talk.mode, "inactive", "remote source stays idle");
  assert.equal(state.multisession!.sessions[1]!.snapshot!.presentation!.id, "remote-panel", "remote source stays untouched");
  assert.equal(state.multisession!.sessions[0]!.snapshot!.transcript![0]!.text, "Visible public text", "main uses its real projection, not supplied summaries");
  const render = projectLiveHud(state, 0, now);
  assert.equal(render.session.name, "Receiver name"); assert.equal(render.session.cwd, "/absolute/receiver");
  assert.equal(render.captions![0]!.text, "Main speech");
  assert.equal(render.presentation!.id, "main-panel");
  data.activeSessionId = "real-main";
  bridge.setMultisession!(data);
  await until(() => client.getState().multisession?.activeSessionId === "real-main");
  assert.equal(projectLiveHud(client.getState(), 0, now).captions![0]!.text, "Main speech");
  assert.equal(client.getState().multisession!.sessions[1]!.snapshot!.presentation!.id, "remote-panel", "nonactive data stays separated and available");
  data.activeSessionId = "real-receiver";
  bridge.setMultisession!(data);
  await until(() => client.getState().snapshot?.session.model === "model-receiver");
  data.sessions = [data.sessions[0]!]; // IPC disconnected/revoked: full replacement.
  bridge.setMultisession!(data);
  await until(() => client.getState().snapshot === null);
  assert.equal(client.getState().multisession!.sessions.length, 1);
  assert.deepEqual(projectLiveHud(client.getState(), 0, now).captions, []);
  assert.equal(projectLiveHud(client.getState(), 0, now).presentation, undefined);
  const next = input(); bridge.setMultisession!(next);
  await until(() => client.getState().snapshot?.session.model === "model-receiver");
  now += 5000;
  for (const tick of ticks) tick();
  await until(() => client.getState().multisession?.sessions[1]?.snapshot === null);
  assert.equal(client.getState().snapshot, null);
  assert.ok(client.getState().multisession!.sessions[0]!.snapshot, "main heartbeat remains live while receiver expires");
  bridge.setMultisession!(undefined);
  await delay(15); // Respect existing no-backlog socket policy before next full frame.
  for (const tick of ticks) tick();
  await until(() => client.getState().snapshot?.session.model === "model" && !client.getState().multisession);
  assert.doesNotMatch(JSON.stringify(client.getState().snapshot), /Main name|Receiver name|absolute|real-main|NEVER_IN_V1/);
  const again = input(); again.activeSessionId = "real-main";
  bridge.setMultisession!(again);
  await until(() => client.getState().multisession?.activeSessionId === "real-main");
  assert.ok(client.getState().snapshot, "re-enabling v2 rotates generation instead of reviving a retired fence");
  await bridge.stop();
  await until(() => client.getState().connection !== "live");
  assert.equal(client.getState().snapshot, null); assert.equal(client.getState().multisession, undefined);
});
