import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWebcamBridge, type WebcamBridgeOptions } from "../extensions/talk/webcam-bridge.ts";
import { activityTimestamp, createAgentCompletionRetention, emptyProjection, initialActivity, initialTodos, projectAgents, projectContext, projectTalk, projectTodos, projectUsage } from "../extensions/talk/webcam-projection.ts";
import { LIVE_HUD_MAX_BYTES, TALK_CAPTIONS_EVENT, TALK_VISUAL_EVENT, type LiveHudSnapshot } from "../extensions/talk/webcam/src/shared/live-protocol.ts";
import { OPENAI_USAGE_CHANGED_EVENT, SUBAGENTS_CHANGED_EVENT, TODOS_CHANGED_EVENT } from "../extensions/resource-status/protocol.ts";

const PRIVATE = "DO_NOT_PROJECT_PRIVATE";
function context(session = "session-one", branch: unknown[] = []): ExtensionContext {
  return {
    cwd: `/private/${PRIVATE}`,
    model: { provider: "openai-codex", id: "gpt-test", contextWindow: 128_000, apiKey: PRIVATE },
    sessionManager: {
      getSessionId: () => session,
      getBranch: () => branch,
      getSessionName: () => { throw new Error(PRIVATE); },
      getSessionFile: () => { throw new Error(PRIVATE); },
      getEntries: () => { throw new Error(PRIVATE); },
    },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 128_000 }),
  } as unknown as ExtensionContext;
}
function agent(id = 1) {
  return { id, label: "Review", task: "Check behavior", status: "running", contextTokens: 42,
    contextWindow: 1000, tokensPerSecond: 20, startedAt: 1_700_000_000_000,
    cwd: PRIVATE, activity: PRIVATE, result: PRIVATE, error: PRIVATE, usage: { secret: PRIVATE }, tools: PRIVATE };
}
function todos(text = "Verify bridge") {
  return { state: { nextId: 2, items: [{ id: 1, text, completed: false, path: PRIVATE }], secret: PRIVATE } };
}
function todoEntry(text: string) {
  return { type: "message", message: { role: "toolResult", toolName: "todo", details: todos(text),
    get content() { throw new Error("Must not inspect tool result text"); } } };
}
function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const bus = new Map<string, Array<(data: unknown) => void>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    events: {
      on(name: string, handler: (data: unknown) => void) {
        bus.set(name, [...(bus.get(name) ?? []), handler]);
        return () => {};
      },
      emit(name: string, data: unknown) { for (const handler of bus.get(name) ?? []) handler(data); },
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, emit: pi.events.emit.bind(pi.events),
    async event(name: string, ctx = context(), event: unknown = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    } };
}
function harness(t: TestContext, options: WebcamBridgeOptions = {}) {
  const root = mkdtempSync("/tmp/pi-hud-");
  const directory = join(root, "webcam");
  const path = join(directory, "hud.sock");
  const fake = fakePi();
  const ticks = new Set<() => void>();
  let clock = 1_700_000_000_000, ids = 0, unrefs = 0, intervalMs = 0;
  const bridge = registerWebcamBridge(fake.pi, {
    socketPath: path, now: () => clock, identity: () => `opaque-${++ids}`,
    setInterval(callback, ms) {
      intervalMs = ms;
      ticks.add(callback);
      return { callback, unref() { unrefs++; } };
    },
    clearInterval(timer) { ticks.delete((timer as { callback: () => void }).callback); },
    ...options,
  });
  const sockets = new Set<Socket>();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await bridge.stop();
    rmSync(root, { recursive: true, force: true });
  });
  async function connect() {
    const socket = createConnection(path);
    sockets.add(socket);
    socket.on("error", () => {});
    const queue: LiveHudSnapshot[] = [];
    const waiting: Array<(value: LiveHudSnapshot) => void> = [];
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    socket.on("data", chunk => {
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        assert.ok(Buffer.byteLength(line) + 1 <= LIVE_HUD_MAX_BYTES);
        const value = JSON.parse(line) as LiveHudSnapshot;
        const next = waiting.shift();
        if (next) next(value); else queue.push(value);
      }
    });
    await once(socket, "connect");
    return { socket, queue, next: () => {
      const value = queue.shift();
      if (value) return Promise.resolve(value);
      return new Promise<LiveHudSnapshot>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Missing snapshot")), 2000);
        waiting.push(value => { clearTimeout(timeout); resolve(value); });
      });
    } };
  }
  return { ...fake, bridge, root, directory, path, ticks, connect,
    tick(ms = 500) { clock += ms; for (const tick of ticks) tick(); },
    advance(ms: number) { clock += ms; },
    get unrefs() { return unrefs; }, get intervalMs() { return intervalMs; } };
}

// Source only: not executed for webcam/call presentation decoupling.
test("publisher authority is private and ready/session scoped; v2 survives idle/standby without consumers", async t => {
  const h = harness(t), ctx = context();
  let resets = 0;
  h.bridge.setPresentationHost!({ current: () => undefined, reset: () => { resets++; }, sync() {} });
  assert.equal(h.bridge.presentationAuthority!(), undefined);
  await h.event("session_start", ctx);
  assert.equal(h.bridge.status(), "stopped", "session start does not create resources");
  assert.equal(h.bridge.presentationAuthority!(), undefined);
  await h.bridge.start(ctx);
  const owner = h.bridge.presentationAuthority!()!;
  assert.equal(owner.sessionKey, "session-one");
  h.bridge.publishPresentation!({ version: 2, scopeId: owner.scopeId, id: "revision", text: "Standalone" });
  const peer = await h.connect(), first = await peer.next();
  assert.equal(first.presentation?.version, 2, "store for the first consumer without claiming visibility");
  assert.equal(first.displayScopeId, owner.scopeId);
  assert.doesNotMatch(JSON.stringify(first), /session-one/);
  const beforeIdle = resets;
  for (const phase of ["idle", "standby", "idle"]) {
    h.emit(TALK_VISUAL_EVENT, { phase, mode: phase === "standby" ? "facetime" : "inactive", voiceReady: false, audioEnabled: false });
    h.tick(); assert.equal((await peer.next()).presentation?.id, "revision");
    assert.equal(h.bridge.presentationAuthority!()?.scopeId, owner.scopeId);
  }
  assert.equal(resets, beforeIdle, "normal inactive Talk never resets webcam panels");
  h.bridge.publishPresentation!({ version: 2, scopeId: "foreign", id: "no", text: "No takeover" });
  assert.equal((await peer.next()).presentation, undefined);
  await h.event("session_before_tree", ctx);
  assert.equal(h.bridge.presentationAuthority!(), undefined);
  await h.event("session_tree", ctx);
  assert.notEqual(h.bridge.presentationAuthority!()?.scopeId, owner.scopeId);
  await h.bridge.stop();
  assert.equal(h.bridge.presentationAuthority!(), undefined);
});

test("caption snapshots respect sharing, run/audio fences, expiry and session clearing without Activity injection", async t => {
  const h = harness(t);
  const talk = { phase: "connected", mode: "facetime", runId: "run-one", voiceReady: true, audioEnabled: true };
  const captions = { runId: "run-one", lines: [
    { id: "cc-1", speaker: "user", text: "Fresh spoken words", final: true,
      updatedAt: 1_700_000_000_000, expiresAt: 1_700_000_004_000 },
  ] };
  h.emit(TALK_VISUAL_EVENT, talk);
  h.emit(TALK_CAPTIONS_EVENT, captions); // Off: not cached.
  await h.bridge.start(context());
  const peer = await h.connect();
  assert.equal((await peer.next()).captions, undefined);
  h.emit(TALK_CAPTIONS_EVENT, captions);
  h.tick();
  const live = await peer.next();
  assert.deepEqual(live.captions, captions);
  assert.deepEqual(live.transcript, []);
  h.tick(4000);
  assert.deepEqual((await peer.next()).captions?.lines, []);
  h.emit(TALK_VISUAL_EVENT, { ...talk, runId: "run-two" });
  h.emit(TALK_CAPTIONS_EVENT, captions); // Retired run cannot repopulate.
  h.tick(); assert.equal((await peer.next()).captions, undefined);
  h.emit(TALK_VISUAL_EVENT, { ...talk, phase: "ready", audioEnabled: false });
  h.emit(TALK_CAPTIONS_EVENT, captions);
  h.tick(); assert.equal((await peer.next()).captions, undefined);
  await h.event("session_tree");
  h.tick(); assert.equal((await peer.next()).captions, undefined);
});

test("activity restoration reads only active-branch metadata and does not infer past tool outcomes", () => {
  const entry = (role: string, timestamp: string, toolName?: string) => ({
    type: "message", id: `/private/${PRIVATE}`, timestamp,
    message: { role, toolName,
      get content() { throw new Error("Must never read conversation content"); },
      get details() { throw new Error("Must never read result details"); },
      get isError() { throw new Error("Historical outcome was not approved for inspection"); },
    },
  });
  const branch = [entry("user", "2023-11-14T22:13:18.000Z"), entry("assistant", "2023-11-14T22:13:19.000Z"),
    entry("toolResult", "2023-11-14T22:13:20.000Z", "read"), entry("system", "2023-11-14T22:13:20.000Z"),
    entry("user", "not-a-time")];
  const events = initialActivity(context("main", branch), 1_700_000_000_000);
  assert.deepEqual(events.map(e => [e.role, e.status]), [["user", "received"], ["assistant", "finished"], ["toolResult", "recorded"]]);
  assert.equal(events[2]!.toolName, "read");
  assert.ok(events.every(e => /^[a-zA-Z0-9_-]{1,64}$/.test(e.id) && Number.isSafeInteger(e.timestamp)));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(PRIVATE));
  assert.equal(activityTimestamp("2023-11-14T22:13:20.000Z"), 1_700_000_000_000);
  assert.equal(activityTimestamp(123.9), 123);
  for (const invalid of [NaN, Infinity, -1, 8_640_000_000_000_001, "private"]) assert.equal(activityTimestamp(invalid), undefined);
  assert.equal(initialActivity(context("main", Array(20).fill(branch[0])), 1_700_000_000_000).length, 10);
});

test("main lifecycle activity is bounded, private, branch scoped and independent of subagent announcements", async t => {
  const h = harness(t);
  const ctx = context();
  await h.bridge.start(ctx);
  const peer = await h.connect();
  const first = await peer.next();
  assert.deepEqual(first.events, []);
  await h.event("agent_start", ctx);
  await h.event("message_start", ctx, { message: { role: "user", get content() { throw new Error(PRIVATE); } } });
  await h.event("tool_execution_start", ctx, { toolCallId: PRIVATE, toolName: "read", get args() { throw new Error(PRIVATE); } });
  await h.event("tool_execution_end", ctx, { toolCallId: PRIVATE, toolName: "read", isError: true, get result() { throw new Error(PRIVATE); } });
  await h.event("message_end", ctx, { message: { role: "assistant", usage: { output: 10 }, get content() { throw new Error(PRIVATE); } } });
  await h.event("session_before_compact", ctx);
  await h.event("session_compact_failed", ctx, { aborted: false, get errorMessage() { throw new Error(PRIVATE); } });
  await h.event("agent_end", ctx);
  await h.event("agent_settled", ctx, { aborted: false });
  // Nested execution and child resource events must never populate main history.
  await h.event("tool_execution_start", ctx, { parentToolCallId: "parent", toolName: "CHILD_TOOL" });
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: [agent()] });
  h.tick();
  const current = await peer.next();
  assert.deepEqual(current.events.map(e => `${e.kind}:${e.status}`), ["run:started", "user_turn:received", "tool:started", "tool:failed",
    "assistant_finished:finished", "compaction:started", "compaction:failed", "run:settled"]);
  assert.equal(current.branchId, first.branchId);
  assert.equal(new Set(current.events.map(e => e.id)).size, current.events.length);
  assert.doesNotMatch(JSON.stringify(current.events), new RegExp(`${PRIVATE}|CHILD_TOOL`));
  for (let i = 0; i < 15; i++) await h.event("tool_execution_end", ctx, { toolName: "write", isError: false });
  h.tick();
  assert.equal((await peer.next()).events.length, 10);
  const branchCtx = context("session-one", [{ type: "message", timestamp: "2023-11-14T22:13:20.000Z", message: { role: "user" } }]);
  await h.event("session_tree", branchCtx);
  h.tick();
  const branch = await peer.next();
  assert.notEqual(branch.branchId, first.branchId);
  assert.equal(branch.sessionId, first.sessionId);
  assert.deepEqual(branch.events.map(e => e.kind), ["user_turn"]);
  h.bridge.updateContext(context("another-session"));
  h.tick();
  const replaced = await peer.next();
  assert.notEqual(replaced.sessionId, branch.sessionId);
  assert.notEqual(replaced.branchId, branch.branchId);
  assert.deepEqual(replaced.events, []);
});

test("completion retention confirms producer removal, copies final row data, and never refreshes TTL", () => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    const retention = createAgentCompletionRetention();
    const row = { ...agent(), startedAt: 10 };
    const update = (states: unknown[], at: number) => retention.update(projectAgents({ states })!, at);
    update([row], 10);
    assert.deepEqual(update([{ ...row, status: "completed" }], 20), []); // Provisional agent_settled.
    assert.deepEqual(update([{ ...row, status: "completed", endedAt: 30 }], 30), []); // Before client.stop.
    const final = { ...row, status, endedAt: 40, label: "Final label", model: "final-model", contextTokens: 99, task: PRIVATE };
    assert.deepEqual(update([final], 40), []); // index.ts settle's final publication.
    const completed = update([], 40);
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0], { id: 1, label: "Final label", task: "", model: "final-model", status,
      startedAt: 10, endedAt: 40, contextTokens: 99, contextWindow: 1000, tokensPerSecond: 20 });
    final.label = PRIVATE;
    assert.doesNotMatch(JSON.stringify(retention.snapshot(100)), new RegExp(PRIVATE));
    update([{ ...final, label: "Final label" }], 200);
    update([], 200); // Duplicate terminal -> removed publications cannot refresh 3040 deadline.
    assert.equal(retention.snapshot(3039).length, 1);
    assert.deepEqual(retention.snapshot(3040), []);
    update([{ ...final, label: "Final label" }], 3050);
    assert.deepEqual(update([], 3050), []); // No replay after expiry.
  }
});

test("completion retention suppresses baseline history and unknown disappearance, binds queues and fences ID reuse", () => {
  const retention = createAgentCompletionRetention();
  const update = (states: unknown[], at: number) => retention.update(projectAgents({ states })!, at);
  const row = { ...agent(), startedAt: 10 };
  const baseline = { ...row, status: "completed", endedAt: 100 };
  update([baseline], 100);
  assert.deepEqual(update([], 101), []);
  update([baseline], 102);
  assert.deepEqual(update([], 103), []);
  update([row], 110);
  assert.deepEqual(update([], 111), []); // Missing is not completed.
  update([row], 112);
  update([{ ...row, status: "completed" }], 113);
  assert.deepEqual(update([], 114), []); // Bare terminal status is still provisional.
  const queued = { ...row, status: "queued", startedAt: undefined };
  update([queued], 120);
  update([{ ...queued, status: "aborted", endedAt: 121 }], 121);
  assert.equal(update([], 122)[0]!.status, "aborted");
  assert.equal(update([queued], 123).length, 1); // Replacement evicts same-ID tombstone.
  update([{ ...row, startedAt: 124 }], 124); // Bind the new queued run to its start.
  update([{ ...row, startedAt: 124, status: "failed", endedAt: 125 }], 125);
  assert.equal(update([], 126)[0]!.startedAt, 124);
  update([{ ...row, startedAt: 130 }], 130);
  assert.deepEqual(update([], 131), []); // Old outcome cannot reappear after the replacement leaves.
  update([row], 140);
  update([{ ...row, status: "completed", endedAt: 141 }], 141);
  update([], 142);
  retention.reset(150);
  assert.deepEqual(retention.snapshot(150), []);
  update([baseline], 151);
  assert.deepEqual(update([], 152), []);
  update([row], 160);
  update([{ ...row, status: "completed", endedAt: 161 }], 161);
  update([], 162);
  assert.deepEqual(retention.snapshot(159), []); // Backward clock clears the generation.
});

test("completion tail shares the 24-row budget with active rows and has no hidden backlog", () => {
  const retention = createAgentCompletionRetention();
  const update = (states: unknown[], at: number) => retention.update(projectAgents({ states })!, at);
  const rows = Array.from({ length: 24 }, (_, index) => ({ ...agent(index + 1), startedAt: 10 }));
  update(rows, 10);
  update(rows.map(row => ({ ...row, status: "completed", endedAt: 20 })), 20);
  const tail = update([], 21);
  assert.equal(tail.length, 24);
  assert.ok(Buffer.byteLength(JSON.stringify(tail)) < LIVE_HUD_MAX_BYTES);
  const next = update(rows.map(row => ({ ...row, id: row.id + 24, startedAt: 30 })), 30);
  assert.equal(next.length, 24);
  assert.ok(next.every(row => row.status === "running"));
  assert.deepEqual(update([], 31), []);
  update(rows.map(row => ({ ...row, status: "completed", endedAt: 20 })), 32);
  assert.deepEqual(update([], 33), []); // Eviction cannot restart a fresh duplicate's TTL.
});

test("bridge publishes terminal then removed events across a heartbeat and clears retention on branch/session/stop", async t => {
  const h = harness(t);
  const ctx = context();
  await h.bridge.start(ctx);
  const peer = await h.connect();
  await peer.next();
  const finish = () => {
    h.emit(SUBAGENTS_CHANGED_EVENT, { states: [agent()] });
    h.emit(SUBAGENTS_CHANGED_EVENT, { states: [{ ...agent(), status: "failed", endedAt: 1_700_000_000_000 }] });
    h.emit(SUBAGENTS_CHANGED_EVENT, { states: [] });
  };
  finish();
  h.tick();
  const frame = await peer.next();
  assert.equal(frame.agents[0]!.status, "failed");
  assert.equal(frame.agents[0]!.endedAt, 1_700_000_000_000);
  assert.equal(frame.agents[0]!.task, "");
  await h.event("session_tree", ctx);
  h.tick();
  assert.deepEqual((await peer.next()).agents, []);
  finish();
  h.bridge.updateContext(context("replacement"));
  h.tick();
  assert.deepEqual((await peer.next()).agents, []);
  finish();
  await h.bridge.stop();
  await h.bridge.start(context("replacement"));
  const restarted = await h.connect();
  assert.deepEqual((await restarted.next()).agents, []);
});

test("pure projections copy only consented fields, sanitize display controls, and detach source state", () => {
  const source = agent();
  const agents = projectAgents({ states: [source], secret: PRIVATE })!;
  assert.deepEqual(agents, [{ id: 1, label: "Review", task: "Check behavior", status: "running", contextTokens: 42,
    contextWindow: 1000, tokensPerSecond: 20, startedAt: 1_700_000_000_000 }]);
  source.task = PRIVATE;
  const projected = projectTodos(todos())!;
  assert.deepEqual(projected, { items: [{ id: 1, text: "Verify bridge", completed: false }], counts: { total: 1, pending: 1, completed: 0 } });
  assert.doesNotMatch(JSON.stringify({ agents, projected }), new RegExp(PRIVATE));
  assert.equal(projectTodos(todos("a\u001bb\u202ec"))!.items[0]!.text, "a b c");
  assert.deepEqual(emptyProjection().talk, { phase: "idle", mode: "inactive", voiceReady: false, audioEnabled: false });
});

test("unknown/invalid projections never coerce numbers, booleans, statuses, or arbitrary objects", () => {
  for (const value of [null, false, 1, "secret", [], new Date(), { states: "secret" }]) {
    assert.equal(projectAgents(value), undefined);
    assert.equal(projectTodos(value), undefined);
    assert.equal(projectTalk(value), undefined);
    assert.equal(projectUsage(value), undefined);
  }
  assert.deepEqual(projectAgents({ states: [null, { ...agent(), status: PRIVATE }, { ...agent(), id: "1" },
    { ...agent(), label: {} }, agent(), agent(), { ...agent(2), contextTokens: NaN, contextWindow: -1, tokensPerSecond: Infinity }] }),
    [{ id: 1, label: "Review", task: "Check behavior", status: "running", contextTokens: 42,
      contextWindow: 1000, tokensPerSecond: 20, startedAt: 1_700_000_000_000 },
    { id: 2, label: "Review", task: "Check behavior", status: "running", contextTokens: null, startedAt: 1_700_000_000_000 }]);
  const valid = { id: 2, text: "valid", completed: true };
  for (const items of [[null, valid], [{ ...valid, completed: "false" }, valid], [valid, valid],
    [{ ...valid, completedAt: -1 }], [{ ...valid, id: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...valid, get text() { throw new Error("Must not execute accessors"); } }]]) {
    assert.equal(projectTodos({ state: { items } }), undefined, "malformed replacements must not claim full totals");
  }
});

test("usage projects weekly only, preserves reset seconds and timestamp ms, excludes raw errors", () => {
  assert.deepEqual(projectUsage({ status: "ready", snapshot: {
    updatedAt: 1_700_000_000_000, planType: PRIVATE,
    primary: { label: "5h", windowSeconds: 18000, remainingPercent: 80 },
    secondary: { label: "weekly", remainingPercent: 75, usedPercent: 25, resetAt: 1_700_001_000, secret: PRIVATE },
  } }), { status: "ready", updatedAt: 1_700_000_000_000, weekly: { remainingPercent: 75, usedPercent: 25, resetAt: 1_700_001_000 } });
  assert.deepEqual(projectUsage({ status: "ready", snapshot: { primary: { label: "5h" } } }), { status: "ready" });
  assert.deepEqual(projectUsage({ status: "ready", snapshot: { secondary: { windowSeconds: 604800,
    remainingPercent: "75", usedPercent: NaN, resetAt: -2 } } }),
  { status: "ready", weekly: { remainingPercent: null, usedPercent: null } });
  assert.deepEqual(projectUsage({ status: "error", message: PRIVATE, updatedAt: 1234 }), { status: "error", updatedAt: 1234 });
});

test("Talk visual gate is authoritative, and invalid/unknown visual events are rejected", () => {
  const visual = { phase: "connected", mode: "facetime", runId: "voice-attempt-1", voiceReady: true, audioEnabled: false, elapsedMs: 2500 };
  assert.deepEqual(projectTalk({ ...visual, detail: PRIVATE, transcript: PRIVATE }), visual);
  for (const change of [{ phase: "listening" }, { mode: "webcam" }, { runId: "/private/path" }, { runId: "x".repeat(129) },
    { voiceReady: 1 }, { audioEnabled: "true" }, { elapsedMs: NaN }, { elapsedMs: Number.MAX_VALUE }]) {
    assert.equal(projectTalk({ ...visual, ...change }), undefined);
  }
});

test("offline context remains unknown/null; model window is not a token estimate", () => {
  assert.deepEqual(projectContext(undefined), { provider: "unknown", model: "unknown",
    context: { tokens: null, contextWindow: null, percent: null } });
  const ctx = context();
  ctx.getContextUsage = () => undefined;
  assert.deepEqual(projectContext(ctx), { provider: "openai-codex", model: "gpt-test",
    context: { tokens: null, contextWindow: 128000, percent: null } });
  ctx.getContextUsage = () => ({ tokens: NaN, contextWindow: 0, percent: 90 });
  assert.deepEqual(projectContext(ctx).context, { tokens: null, contextWindow: 128000, percent: null });
  ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 100, percent: 0 });
  assert.deepEqual(projectContext(ctx, 0).context, { tokens: 0, contextWindow: 100, percent: 0, tokensPerSecond: 0 });
  assert.equal(projectContext(ctx, 1_000_001).context.tokensPerSecond, undefined);
  ctx.getContextUsage = () => ({ tokens: Number.MAX_VALUE, contextWindow: Number.MAX_VALUE, percent: 101 });
  assert.deepEqual(projectContext(ctx).context, { tokens: null, contextWindow: 128000, percent: null });
});

test("initial todo reconstruction uses only latest valid active-branch tool details", () => {
  const unrelated = { type: "message", message: { role: "user", get content() { throw new Error(PRIVATE); } } };
  const wrongTool = { type: "message", message: { role: "toolResult", toolName: "bash", get details() { throw new Error(PRIVATE); } } };
  const ctx = context("s", [todoEntry("older"), unrelated, wrongTool, todoEntry("latest"),
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { state: "invalid" } } }]);
  assert.deepEqual(initialTodos(ctx), { items: [{ id: 1, text: "latest", completed: false }], counts: { total: 1, pending: 1, completed: 0 } });
  assert.deepEqual(initialTodos(context()), { items: [], counts: { total: 0, pending: 0, completed: 0 } });
});

test("todo producer scans the full state before its 48-row limit, preserving canonical category order", () => {
  const items = Object.freeze(Array.from({ length: 55 }, (_, i) => Object.freeze({
    id: i + 1, text: `Task ${i + 1}`, completed: i < 48, completedAt: i < 48 ? 100 - i : undefined,
  })));
  const projected = projectTodos({ state: { items, nextId: 56 } })!;
  assert.deepEqual(projected.counts, { total: 55, pending: 7, completed: 48 });
  assert.deepEqual(projected.items.map(item => item.id), [49, 50, 51, 52, 53, 54, 55, ...Array.from({ length: 41 }, (_, i) => i + 1)]);
  assert.equal(projected.items.length, 48);
  assert.deepEqual(items.map(item => item.id), Array.from({ length: 55 }, (_, i) => i + 1));
  projected.items[0]!.text = "Detached";
  assert.equal(items[48]!.text, "Task 49");
  const nonascending = [9, 2, 6, 3].map(id => ({ id, text: `Task ${id}`, completed: id === 2 }));
  assert.deepEqual(projectTodos({ state: { items: nonascending } })!.items.map(item => item.id), [9, 6, 3, 2]);
  const pending = Array.from({ length: 60 }, (_, i) => ({ id: 100 - i, text: "Pending", completed: false }));
  assert.deepEqual(projectTodos({ state: { items: pending } })!.items.map(item => item.id), pending.slice(0, 48).map(item => item.id));
  assert.deepEqual(projectTodos({ state: { items: pending } })!.counts, { total: 60, pending: 60, completed: 0 });
  const completed = pending.map(item => ({ ...item, completed: true }));
  assert.deepEqual(projectTodos({ state: { items: completed } })!.items.map(item => item.id), completed.slice(0, 48).map(item => item.id));
  assert.deepEqual(projectTodos({ state: { items: completed } })!.counts, { total: 60, pending: 0, completed: 60 });
  // Invalid data anywhere, including after capacity, invalidates the summary.
  assert.equal(projectTodos({ state: { items: [...pending, pending[0]] } }), undefined);
  const restored = context("s", [todoEntry("older"), { type: "message", message: {
    role: "toolResult", toolName: "todo", details: { state: { items, nextId: 56 } },
    get content() { throw new Error("Never inspect message bodies"); },
  } }]);
  assert.deepEqual(initialTodos(restored), projectTodos({ state: { items, nextId: 56 } }));
});

test("todo rows and full counts replace together through clear, branch, session and stop", async t => {
  const h = harness(t);
  const ctx = context("s");
  const items = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, text: "Task", completed: i < 50 }));
  // An early event wins over restoration, including its full counts.
  h.emit(TODOS_CHANGED_EVENT, { state: { items, nextId: 61 } });
  await h.bridge.start(context("s", [todoEntry("Older")]));
  const peer = await h.connect();
  const initial = await peer.next();
  assert.equal(initial.todos[0]!.id, 51);
  assert.deepEqual(initial.todoCounts, { total: 60, pending: 10, completed: 50 });
  h.emit(TODOS_CHANGED_EVENT, { state: { items: [], nextId: 1 } });
  h.tick();
  const cleared = await peer.next();
  assert.deepEqual(cleared.todos, []);
  assert.deepEqual(cleared.todoCounts, { total: 0, pending: 0, completed: 0 });
  h.emit(TODOS_CHANGED_EVENT, { state: { items, nextId: 61 } });
  await h.event("session_tree", ctx);
  h.tick();
  const branch = await peer.next();
  assert.deepEqual(branch.todos, []);
  assert.deepEqual(branch.todoCounts, { total: 0, pending: 0, completed: 0 });
  h.emit(TODOS_CHANGED_EVENT, { state: { items, nextId: 61 } });
  h.bridge.updateContext(context("replacement"));
  h.tick();
  const replacement = await peer.next();
  assert.deepEqual(replacement.todos, []);
  assert.deepEqual(replacement.todoCounts, { total: 0, pending: 0, completed: 0 });
  h.emit(TODOS_CHANGED_EVENT, { state: { items, nextId: 61 } });
  await h.bridge.stop();
  await h.bridge.start(context("replacement"));
  const restarted = await (await h.connect()).next();
  assert.deepEqual(restarted.todos, []);
  assert.deepEqual(restarted.todoCounts, { total: 0, pending: 0, completed: 0 });
});

test("factory registers lifecycle observers but allocates no resources", async t => {
  const h = harness(t, { createServer() { throw new Error("Factory must not bind"); },
    setInterval() { throw new Error("Factory must not schedule"); } });
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: [agent()] });
  await h.event("session_start");
  assert.equal(existsSync(h.directory), false);
  assert.equal(h.bridge.status(), "stopped");
  assert.ok(h.handlers.has("session_shutdown"));
  assert.ok(h.handlers.has("session_tree"));
});

test("explicit start secures directory/socket before first full snapshot; early caches survive ordering", async t => {
  const h = harness(t);
  mkdirSync(h.directory, { mode: 0o755 });
  chmodSync(h.directory, 0o755);
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: [agent()] });
  h.emit(TODOS_CHANGED_EVENT, todos("Early todo"));
  h.emit(OPENAI_USAGE_CHANGED_EVENT, { status: "error", message: PRIVATE, updatedAt: 100 });
  h.emit(TALK_VISUAL_EVENT, { phase: "standby", mode: "facetime", voiceReady: false, audioEnabled: false });
  const ctx = context(PRIVATE, [todoEntry("Do not override fresh event")]);
  await h.event("session_start", ctx);
  assert.equal(existsSync(h.path), false);
  await h.bridge.start(ctx);
  assert.equal(h.bridge.status(), "live");
  assert.equal(lstatSync(h.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(h.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(h.directory), ["hud.sock"]);
  assert.equal(h.unrefs, 1);
  assert.ok(h.intervalMs > 0 && h.intervalMs <= 1000);
  const peer = await h.connect();
  const first = await peer.next();
  assert.equal(first.version, 1);
  assert.equal(first.timestamp, 1_700_000_000_000);
  assert.equal(first.sequence, 1);
  assert.equal(first.agents.length, 1);
  assert.equal(first.todos[0]!.text, "Early todo");
  assert.equal(first.talk.phase, "standby");
  assert.deepEqual(first.usage, { status: "error", updatedAt: 100 });
  assert.doesNotMatch(JSON.stringify(first), new RegExp(PRIVATE));
  h.tick();
  const heartbeat = await peer.next();
  assert.equal(heartbeat.sequence, 2);
  assert.equal(heartbeat.session.elapsedMs, 500);
  assert.equal(heartbeat.streamId, first.streamId);
  assert.equal(heartbeat.sessionId, first.sessionId);
});

test("resource announcements after session_start but before explicit start are retained", async t => {
  const h = harness(t);
  const ctx = context();
  await h.event("session_start", ctx);
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: [agent()] });
  h.emit(TODOS_CHANGED_EVENT, todos("After lifecycle"));
  h.emit(OPENAI_USAGE_CHANGED_EVENT, { status: "loading" });
  await h.bridge.start(ctx);
  const initial = await (await h.connect()).next();
  assert.equal(initial.agents.length, 1);
  assert.equal(initial.todos[0]!.text, "After lifecycle");
  assert.deepEqual(initial.usage, { status: "loading" });
});

test("authoritative empty todo event is not replaced with old branch data", async t => {
  const h = harness(t);
  h.emit(TODOS_CHANGED_EVENT, { state: { items: [], nextId: 1 } });
  await h.bridge.start(context("s", [todoEntry("Old")]));
  assert.deepEqual((await (await h.connect()).next()).todos, []);
});

test("reconnect gets current complete snapshot; invalid events and getters cannot leak or crash", async t => {
  const h = harness(t);
  const ctx = context("s", [todoEntry("Restored")]);
  await h.bridge.start(ctx);
  const peer = await h.connect();
  const first = await peer.next();
  assert.equal(first.todos[0]!.text, "Restored");
  peer.socket.destroy();
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: [agent()] });
  h.emit(TODOS_CHANGED_EVENT, todos("Changed"));
  h.emit(TALK_VISUAL_EVENT, { phase: "ready", mode: "physical", voiceReady: true, audioEnabled: false });
  for (const value of [null, "secret", { get states() { throw new Error(PRIVATE); } }, new Date()]) h.emit(SUBAGENTS_CHANGED_EVENT, value);
  h.emit(TALK_VISUAL_EVENT, { phase: "connected", audioEnabled: PRIVATE });
  const second = await (await h.connect()).next();
  assert.equal(second.streamId, first.streamId);
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(second.sequence > first.sequence);
  assert.equal(second.todos[0]!.text, "Changed");
  assert.equal(second.agents.length, 1);
  assert.equal(second.talk.voiceReady, true);
  assert.equal(second.talk.audioEnabled, false);
  assert.doesNotMatch(JSON.stringify(second), new RegExp(PRIVATE));
});

test("session replacement clears all session state/rate, changes opaque identity, and tree restores only branch todos", async t => {
  const h = harness(t);
  const old = context("old");
  await h.bridge.start(old);
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: [agent()] });
  h.emit(TODOS_CHANGED_EVENT, todos("old"));
  h.emit(OPENAI_USAGE_CHANGED_EVENT, { status: "ready", snapshot: { secondary: { label: "weekly", usedPercent: 2 } } });
  h.emit(TALK_VISUAL_EVENT, { phase: "connected", mode: "facetime", voiceReady: true, audioEnabled: true });
  const peer = await h.connect();
  const before = await peer.next();
  const next = context("new", [todoEntry("new branch")]);
  h.bridge.updateContext(next);
  h.tick();
  const after = await peer.next();
  assert.notEqual(after.sessionId, before.sessionId);
  assert.equal(after.streamId, before.streamId);
  assert.ok(after.sequence > before.sequence);
  assert.deepEqual(after.agents, []);
  assert.deepEqual(after.usage, { status: "inactive" });
  assert.equal(after.talk.phase, "idle");
  assert.equal(after.todos[0]!.text, "new branch");
  assert.equal(after.context.tokensPerSecond, undefined);
  await h.event("session_tree", context("new", [todoEntry("other branch")]));
  h.tick();
  assert.equal((await peer.next()).todos[0]!.text, "other branch");
});

test("main status/token rate uses event tags and counters, never messages/tool inputs", async t => {
  const h = harness(t);
  const ctx = context();
  await h.bridge.start(ctx);
  const peer = await h.connect();
  await peer.next();
  const message = (output: number) => ({ role: "assistant", usage: { output },
    get content() { throw new Error(PRIVATE); }, errorMessage: PRIVATE });
  await h.event("turn_start", ctx);
  await h.event("message_start", ctx, { message: message(0) });
  h.advance(1000);
  await h.event("message_update", ctx, { message: message(40), assistantMessageEvent: { type: "thinking_delta", delta: PRIVATE } });
  h.tick();
  assert.equal((await peer.next()).session.status, "thinking");
  h.advance(500);
  await h.event("message_update", ctx, { message: message(80), assistantMessageEvent: { type: "text_delta", delta: PRIVATE } });
  h.tick();
  const measured = await peer.next();
  assert.equal(measured.session.status, "running");
  assert.equal(measured.context.tokensPerSecond, 40);
  await h.event("tool_execution_start", ctx, { toolName: "public_tool", args: { path: PRIVATE } });
  await h.event("message_end", ctx, { message: message(80) });
  await h.event("agent_settled", ctx);
  h.tick();
  const settled = await peer.next();
  assert.equal(settled.session.status, "idle");
  assert.equal(settled.context.tokensPerSecond, 40);
  assert.ok(settled.events.some(event => event.toolName === "public_tool"), "tool names are public activity; arguments remain private");
  assert.doesNotMatch(JSON.stringify(settled), new RegExp(PRIVATE));
});

test("frames/collections/text are bounded even with huge consented data", async t => {
  const h = harness(t);
  await h.bridge.start(context());
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: Array.from({ length: 1000 }, (_, i) => ({ ...agent(i + 1), task: "😀".repeat(10000), label: "名".repeat(10000) })) });
  h.emit(TODOS_CHANGED_EVENT, { state: { items: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, completed: false, text: "😀".repeat(10000) })) } });
  const frame = await (await h.connect()).next();
  assert.equal(frame.agents.length, 24);
  assert.equal(frame.todos.length, 48);
  assert.deepEqual(frame.todoCounts, { total: 1000, pending: 1000, completed: 0 });
  assert.ok(frame.agents.every(agent => agent.task.length <= 256 && agent.label.length <= 96));
  assert.ok(frame.todos.every(todo => todo.text.length <= 256));
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) < LIVE_HUD_MAX_BYTES);
});

test("read-only socket destroys clients sending data and bounds simultaneous connections", async t => {
  const h = harness(t);
  await h.bridge.start(context());
  const peers = [];
  for (let i = 0; i < 4; i++) { const peer = await h.connect(); await peer.next(); peers.push(peer); }
  const extra = await h.connect();
  const extraClosed = once(extra.socket, "close");
  await extraClosed;
  assert.deepEqual(extra.queue, []);
  const closed = once(peers[0]!.socket, "close");
  peers[0]!.socket.write('{"command":"turn-on-audio"}\n');
  await closed;
  assert.equal(h.bridge.status(), "live");
  const replacement = await h.connect();
  assert.equal((await replacement.next()).talk.audioEnabled, false);
});

test("slow clients get one bounded frame to drain, never accumulating frames or drain listeners", async t => {
  let writes = 0;
  let accepted: Socket | undefined;
  const h = harness(t, { createServer() {
    const server = createServer();
    server.on("connection", socket => {
      accepted = socket;
      Object.defineProperty(socket, "writableLength", { get: () => writes > 0 ? 128 : 0 });
      socket.write = (() => { writes++; return false; }) as Socket["write"];
    });
    return server;
  } });
  await h.bridge.start(context());
  const peer = await h.connect();
  await new Promise(resolve => setImmediate(resolve));
  const closed = once(peer.socket, "close");
  for (let i = 0; i < 20; i++) h.tick();
  await closed;
  assert.equal(writes, 1);
  assert.equal(accepted?.destroyed, true);
  assert.equal(accepted?.listenerCount("drain"), 0);
  assert.equal(peer.queue.length, 0);
});

test("legitimate snapshots larger than Node's default high-water mark still arrive", async t => {
  const h = harness(t);
  h.emit(SUBAGENTS_CHANGED_EVENT, { states: Array.from({ length: 24 }, (_, i) => ({
    ...agent(i + 1), label: "L".repeat(96), task: "T".repeat(256),
  })) });
  h.emit(TODOS_CHANGED_EVENT, { state: { nextId: 49, items: Array.from({ length: 48 }, (_, i) => ({
    id: i + 1, text: "X".repeat(256), completed: false,
  })) } });
  await h.bridge.start(context());
  const peer = await h.connect();
  const initial = await peer.next();
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) > 16384);
  assert.equal(initial.todos.length, 48);
  await new Promise(resolve => setImmediate(resolve));
  h.tick();
  assert.equal((await peer.next()).agents.length, 24);
  assert.equal(peer.socket.destroyed, false);
});

test("preexisting writable backlog disconnects without another write; socket errors stay handled", async t => {
  let accepted: Socket | undefined;
  const h = harness(t, { createServer() {
    const server = createServer();
    server.on("connection", socket => { accepted = socket; });
    return server;
  } });
  await h.bridge.start(context());
  const peer = await h.connect();
  await peer.next();
  Object.defineProperty(accepted!, "writableLength", { value: 1 });
  const closed = once(peer.socket, "close");
  h.tick();
  await closed;
  assert.equal(accepted!.destroyed, true);
  accepted!.emit("error", new Error(PRIVATE));
  assert.equal(h.bridge.status(), "live");
});

test("first owner wins; live, stale, regular-file and symlink collisions are never removed", async t => {
  const h = harness(t);
  await h.bridge.start(context());
  const original = lstatSync(h.path);
  const other = registerWebcamBridge(fakePi().pi, { socketPath: h.path });
  t.after(() => other.stop());
  await assert.rejects(other.start(context()), { code: "EADDRINUSE", message: "Webcam bridge socket is already in use" });
  await other.stop();
  assert.equal(lstatSync(h.path).ino, original.ino);
  assert.equal((await (await h.connect()).next()).version, 1);
  await h.bridge.stop();
  for (const kind of ["file", "symlink", "stale"] as const) {
    if (kind === "file") writeFileSync(h.path, PRIVATE);
    if (kind === "symlink") symlinkSync(join(h.root, "missing"), h.path);
    if (kind === "stale") {
      const stale = createServer();
      const hidden = join(h.directory, "stale");
      await new Promise<void>(resolve => stale.listen(hidden, resolve));
      renameSync(hidden, h.path);
      await new Promise<void>(resolve => stale.close(() => resolve()));
    }
    const before = lstatSync(h.path);
    await assert.rejects(h.bridge.start(context()), { code: "EADDRINUSE" });
    await h.bridge.stop();
    assert.equal(lstatSync(h.path).ino, before.ino);
    unlinkSync(h.path);
  }
});

test("directory symlinks, non-directories and foreign ownership are rejected before chmod/bind", async t => {
  const h = harness(t);
  const target = join(h.root, "target");
  mkdirSync(target, { mode: 0o755 });
  chmodSync(target, 0o755);
  symlinkSync(target, h.directory);
  await assert.rejects(h.bridge.start(context()), { code: "EWEBCAM" });
  assert.equal(lstatSync(target).mode & 0o777, 0o755);
  assert.equal(lstatSync(h.directory).isSymbolicLink(), true);
  unlinkSync(h.directory);
  writeFileSync(h.directory, PRIVATE);
  await assert.rejects(h.bridge.start(context()), { code: "EWEBCAM" });
  assert.equal(readFileSync(h.directory, "utf8"), PRIVATE);
  unlinkSync(h.directory);
  mkdirSync(h.directory, { mode: 0o755 });
  chmodSync(h.directory, 0o755);
  const foreign = registerWebcamBridge(fakePi().pi, { socketPath: h.path, uid: () => process.getuid!() + 1 });
  t.after(() => foreign.stop());
  await assert.rejects(foreign.start(context()), { code: "EWEBCAM" });
  assert.equal(lstatSync(h.directory).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(h.directory), []);
});

test("atomic publication collision does not unlink winner or leave staging files", async t => {
  let path = "";
  const h = harness(t, { createServer() {
    const server = createServer();
    server.once("listening", () => writeFileSync(path, PRIVATE));
    return server;
  } });
  path = h.path;
  await assert.rejects(h.bridge.start(context()), { code: "EADDRINUSE" });
  assert.equal(readFileSync(path, "utf8"), PRIVATE);
  assert.deepEqual(readdirSync(h.directory), ["hud.sock"]);
  assert.equal(h.ticks.size, 0);
});

test("cleanup does not unlink replaced socket paths (including Node's implicit close unlink)", async t => {
  const h = harness(t);
  await h.bridge.start(context());
  renameSync(h.path, join(h.directory, "old.sock"));
  const replacement = createServer();
  await new Promise<void>(resolve => replacement.listen(h.path, resolve));
  t.after(() => new Promise<void>(resolve => replacement.close(() => resolve())));
  const winner = lstatSync(h.path);
  await h.bridge.stop();
  assert.equal(lstatSync(h.path).ino, winner.ino);
  assert.equal(lstatSync(h.path).isSocket(), true);
});

test("stop/shutdown are idempotent, destroy peers, clear timers/state and isolate restarted streams", async t => {
  const h = harness(t);
  const ctx = context();
  await Promise.all([h.bridge.start(ctx), h.bridge.start(ctx)]);
  h.emit(TODOS_CHANGED_EVENT, todos("old"));
  const peer = await h.connect();
  const before = await peer.next();
  const closed = once(peer.socket, "close");
  await h.event("session_shutdown", ctx);
  await closed;
  await h.bridge.stop();
  assert.equal(h.bridge.status(), "stopped");
  assert.equal(h.ticks.size, 0);
  assert.equal(existsSync(h.path), false);
  h.emit(TODOS_CHANGED_EVENT, todos(PRIVATE));
  h.emit(TALK_VISUAL_EVENT, { phase: "connected", mode: "facetime", voiceReady: true, audioEnabled: true });
  await h.event("message_update", ctx, { message: { role: "assistant", usage: { output: 999 } } });
  await h.bridge.start(ctx);
  const after = await (await h.connect()).next();
  assert.notEqual(after.streamId, before.streamId);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.equal(after.sequence, 1);
  assert.deepEqual(after.todos, []);
  assert.equal(after.talk.phase, "idle");
  assert.equal(after.context.tokensPerSecond, undefined);
  assert.doesNotMatch(JSON.stringify(after), new RegExp(PRIVATE));
});

test("runtime server errors are handled, disconnect clients, and clean only owned resources", async t => {
  let server: ReturnType<typeof createServer> | undefined;
  const h = harness(t, { createServer() { server = createServer(); return server; } });
  await h.bridge.start(context());
  const peer = await h.connect();
  await peer.next();
  const closed = once(peer.socket, "close");
  server!.emit("error", new Error(PRIVATE));
  await closed;
  assert.equal(h.bridge.status(), "error");
  assert.equal(h.ticks.size, 0);
  assert.equal(existsSync(h.path), false);
  await h.bridge.start(context());
  assert.equal((await (await h.connect()).next()).version, 1);
});

test("failed timer setup tears down the already published socket safely", async t => {
  const h = harness(t, { setInterval() { throw new Error(PRIVATE); } });
  await assert.rejects(h.bridge.start(context()), { message: "Webcam bridge could not start" });
  assert.equal(existsSync(h.path), false);
  assert.deepEqual(readdirSync(h.directory), []);
  assert.equal(h.bridge.status(), "error");
});

test("overlapping start/stop and bind failures leave no resource leaks or private diagnostics", async t => {
  const h = harness(t);
  const starting = h.bridge.start(context());
  const stopping = h.bridge.stop();
  await Promise.all([starting, stopping]);
  assert.equal(h.bridge.status(), "stopped");
  assert.equal(h.ticks.size, 0);
  assert.equal(existsSync(h.path), false);
  const failing = registerWebcamBridge(fakePi().pi, { socketPath: join(h.root, "missing", "nested", "hud.sock") });
  t.after(() => failing.stop());
  await assert.rejects(failing.start(context()), (error: Error) => {
    assert.equal(error.message, "Webcam bridge could not start");
    assert.doesNotMatch(error.message, /private|missing|pi-hud/);
    return true;
  });
  assert.equal(failing.status(), "error");
});
