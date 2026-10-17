import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTalk } from "../extensions/talk/index.ts";
import { createCodexWire } from "../extensions/talk/codex-wire.ts";
import { TalkSummaryError } from "../extensions/talk/summary.ts";
import type { LiveCallbacks, LiveSession } from "../extensions/talk/live.ts";
import { DICTATION_CHANGED_EVENT, TALK_CHANGED_EVENT, TALK_STATUS_CHANGED_EVENT, SUBAGENTS_CHANGED_EVENT, TODOS_CHANGED_EVENT, type TalkStatusPayload } from "../extensions/resource-status/protocol.ts";
import { normalizeQuestions } from "../extensions/ask-user/core.ts";
import { requestVoiceQuestions } from "../extensions/ask-user/voice.ts";

type Dependencies = NonNullable<Parameters<typeof registerTalk>[1]>;
type Handler = (...args: unknown[]) => unknown;
type Command = { handler(args: string, ctx: ExtensionContext): Promise<void> };
type CloseInfo = Parameters<LiveCallbacks["onClosed"]>[0];
const token = `e30.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
})).toString("base64url")}.signature`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Failure cleanup is deliberately scheduled after the callback/start promise.
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function setup(t: TestContext, audioMode: "pcm" | "browser" | "native" = "pcm") {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const intervalCallbacks: (() => void)[] = [];
  let intervalTicks = 0;
  const scheduleInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
    intervalCallbacks.push(callback);
    return scheduleInterval(() => { intervalTicks++; callback(); }, ms);
  });
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const emitted: [string, unknown][] = [];
  const notices: [string, string][] = [];
  const statuses: [string, string | undefined][] = [];
  const widgets: [string, string[] | undefined][] = [];
  const entries: [string, unknown][] = [];
  const editorCalls: string[] = [];
  const providers: string[] = [];
  const sent: unknown[] = [];
  const customMessages: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const spoken: [string | null, string][] = [];
  const quiet: [string | null, string][] = [];
  const appended: Buffer[] = [];
  const played: Buffer[] = [];
  const order: string[] = [];
  let draft = "Keep this unsent draft";
  let aborts = 0;
  let expectedAborts = 0;
  let piRunController: AbortController | undefined;
  let playerStarts = 0;
  let recorderStarts = 0;
  let playerStops = 0;
  let recorderStops = 0;
  let closeCalls = 0;
  let transportCloses = 0;
  let opens = 0;
  const summaryCalls: Parameters<NonNullable<Dependencies["summarizeContext"]>>[] = [];
  const initialContexts: (string | undefined)[] = [];
  let summarize: NonNullable<Dependencies["summarizeContext"]> = async () => undefined;
  let headers: Record<string, string> | undefined;
  let signal: AbortSignal | undefined;
  let callbacks!: LiveCallbacks;
  let capture!: (pcm: Buffer) => void;
  let recorderError!: (error: Error) => void;
  let playerError!: (error: Error) => void;
  let closed = false;
  let closeInfo: CloseInfo = { confirmed: true, seconds: 12 };
  let authorize = async (): Promise<string | undefined> => token;
  let connect = async (): Promise<LiveSession> => live;
  let startCapture = () => recorder;
  function add(map: Map<string, Handler[]>, name: string, handler: Handler) {
    map.set(name, [...(map.get(name) ?? []), handler]);
  }
  const events = {
    on(name: string, handler: Handler) { add(listeners, name, handler); return () => {}; },
    emit(name: string, value: unknown) {
      emitted.push([name, value]);
      for (const listener of listeners.get(name) ?? []) listener(value);
    },
  };
  const pi = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerMessageRenderer() {},
    on(name: string, handler: Handler) { add(handlers, name, handler); },
    events,
    appendEntry(name: string, value: unknown) { entries.push([name, value]); },
    sendUserMessage(...args: unknown[]) {
      // Pi emits input at submission, inside the sender's async scope, before enqueue.
      const options = args[1] as { deliverAs?: "steer" | "followUp" } | undefined;
      for (const handler of handlers.get("input") ?? []) handler({
        text: args[0], source: "extension", streamingBehavior: ctx.isIdle() ? undefined : options?.deliverAs,
      }, ctx);
      sent.push(args);
    },
    sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>) { customMessages.push(args); },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    model: { provider: "anthropic", id: "some-other-model" },
    isIdle: () => true,
    hasPendingMessages: () => false,
    get signal() { return piRunController?.signal; },
    abort() {
      aborts++;
      piRunController?.abort();
      ctx.isIdle = () => true;
    },
    modelRegistry: {
      getApiKeyForProvider(provider: string) { providers.push(provider); return authorize(); },
    },
    sessionManager: { getSessionId: () => "session-test", getBranch: () => [] },
    ui: {
      notify(message: string, level: string) { notices.push([message, level]); },
      setStatus(key: string, value: string | undefined) { statuses.push([key, value]); },
      setWidget(key: string, value: any) {
        const rendered = typeof value === "function"
          ? value({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }).render(120)
          : value;
        widgets.push([key, rendered]);
      },
      getEditorText() { editorCalls.push("get"); return draft; },
      setEditorText(value: string) { editorCalls.push("set"); draft = value; },
      pasteToEditor(value: string) { editorCalls.push("paste"); draft += value; },
    },
  } as unknown as ExtensionContext;
  function finish(info: CloseInfo) {
    if (closed) return;
    closed = true;
    transportCloses++;
    callbacks.onClosed(info);
  }
  const live: LiveSession = {
    append(pcm) { appended.push(pcm); },
    commentary(id, content) { spoken.push([id, content]); },
    thinking(id, content) { quiet.push([id, content]); },
    async close() {
      closeCalls++;
      order.push("live.close");
      finish(closeInfo); // Synchronously reenter onClosed, just like the transport can.
      return closeInfo;
    },
  };
  const recorder = { async stop() { recorderStops++; order.push("recorder.stop"); } };
  const player = {
    append(pcm: Buffer) { played.push(pcm); },
    async stop() { playerStops++; order.push("player.stop"); },
  };
  const dependencies: Dependencies = {
    audioMode,
    // Controller tests must never reset the user's real trace file. Filesystem
    // reset behavior is exercised separately with private temporary directories.
    createTrace: () => ({
      async enable() {}, async disable() {}, async reset() {},
      status: () => ({ enabled: false, path: "/unused/talk-controller-test.jsonl", dropped: 0 }),
      session: () => ({ record() {}, addSecrets() {} }),
    }),
    ...(audioMode !== "pcm" ? { modelName: "gpt-live-1-codex" } : {}),
    loadAudioDevices: async () => ({}),
    async summarizeContext(...args) {
      summaryCalls.push(args);
      return summarize(...args);
    },
    async openLive(h, s, cb, initialContext) {
      initialContexts.push(initialContext);
      opens++; headers = h; signal = s; callbacks = cb;
      s.addEventListener("abort", () => finish({ confirmed: false }), { once: true });
      return connect();
    },
    startRecorder(append, error) {
      recorderStarts++; capture = append; recorderError = error;
      return startCapture();
    },
    startPlayer(error) { playerStarts++; playerError = error; return player; },
  };
  registerTalk(pi, dependencies);
  const command = (args = "") => commands.get("talk")!.handler(args, ctx);
  const fire = async (name: string, ...args: unknown[]) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(...args));
    // Initial native prompts emit a user message after preparation. Queued
    // follow-ups deliberately skip before_agent_start; tests consume them explicitly.
    const prompt = (args[0] as { prompt?: unknown } | undefined)?.prompt;
    if (name === "before_agent_start" && typeof prompt === "string") {
      for (const handler of handlers.get("message_end") ?? []) await handler({
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      }, ctx);
    }
    return results;
  };
  t.after(async () => {
    try {
      await command("stop");
      await flush();
      assert.equal(aborts, expectedAborts, "only an explicitly verified Stop Pi action may abort the agent");
      assert.deepEqual(editorCalls, [], "Talk must not read or write the dictation editor");
      assert.equal(draft, "Keep this unsent draft");
      assert.ok(statuses.every(([key, value]) => key !== "talk" || value === undefined),
        "Talk progress belongs in the resource dashboard, never Pi's status footer");
    } finally { t.mock.timers.reset(); }
  });
  let replyCount = 0;
  type Control = { type: string; token: string; phase: string; mode: string };
  function latestControl(): Control {
    for (const [id, text] of [...quiet].reverse()) {
      let control: Control;
      try { control = JSON.parse(text); } catch { continue; }
      if (control.type !== "talk.question") continue;
      assert.equal(id, null, "control metadata is quiet session context");
      assert.equal(control.mode, "spoken-reply");
      assert.equal(typeof control.token, "string");
      assert.equal(Object.hasOwn(control, "reply"), false, "normal handoffs use plain spoken text");
      return control;
    }
    assert.fail("Missing question control");
  }
  function finishSpoken() {
    const text = spoken.at(-1)![1];
    callbacks.onTranscript("assistant", text, 0, 0);
    callbacks.onTurn?.("assistant", text);
  }
  function spokenRequest(text: string) {
    const id = `reply_${++replyCount}`;
    callbacks.onTranscript("user", text, 0, replyCount);
    callbacks.onDelegation(id, replyCount, text);
    return id;
  }
  return {
    latestControl, finishSpoken, spokenRequest,
    replyQuestion: spokenRequest,
    pi, ctx, command, fire, events, handlers, notices, statuses, widgets, entries, providers, sent, spoken, quiet,
    summaryCalls, initialContexts, customMessages,
    setSummarize: (fn: typeof summarize) => { summarize = fn; },
    appended, played, order, live,
    states: () => emitted.filter(([name]) => name === TALK_CHANGED_EVENT).map(([, state]) => state),
    dashboard: () => emitted.filter(([name]) => name === TALK_STATUS_CHANGED_EVENT).map(([, status]) => status as TalkStatusPayload),
    callbacks: () => callbacks,
    capture: (pcm: Buffer) => capture(pcm),
    recorderError: (error: Error) => recorderError(error),
    playerError: (error: Error) => playerError(error),
    finish,
    setAuthorize: (fn: typeof authorize) => { authorize = fn; },
    setConnect: (fn: typeof connect) => { connect = fn; },
    setCapture: (fn: typeof startCapture) => { startCapture = fn; },
    setCloseInfo: (info: CloseInfo) => { closeInfo = info; },
    counts: () => ({ opens, playerStarts, recorderStarts, playerStops, recorderStops, closeCalls, transportCloses }),
    startPiWork() {
      piRunController = new AbortController();
      ctx.isIdle = () => false;
      return piRunController.signal;
    },
    expectAborts(value: number) { expectedAborts = value; },
    aborts: () => aborts,
    advance(ms: number) { now += ms; t.mock.timers.tick(ms); },
    intervalCallbacks,
    intervalTicks: () => intervalTicks,
    headers: () => headers,
    signal: () => signal,
  };
}

function trackCustomChat(t: TestContext, h: ReturnType<typeof setup>, queued = false) {
  const manager = SessionManager.inMemory();
  const pending: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
  const original = h.pi.sendMessage.bind(h.pi);
  t.mock.method(h.ctx.sessionManager, "getBranch", () => manager.getBranch());
  const flush = () => {
    for (const message of pending.splice(0)) {
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    }
  };
  t.mock.method(h.pi, "sendMessage", (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
    original(...args);
    pending.push(args[0]);
    if (!queued) flush();
  });
  return { flush };
}

function quietActivity(h: ReturnType<typeof setup>) {
  return h.quiet.filter(([, text]) => {
    try { return JSON.parse(text).type !== "talk.stop"; } catch { return true; }
  });
}

function captionText(h: ReturnType<typeof setup>) {
  return (h.widgets.filter(([key]) => key === "talk").at(-1)?.[1] ?? []).join("\n");
}

function nativeTurns(callbacks: LiveCallbacks) {
  const wire = createCodexWire(callbacks);
  let partialId = 0;
  return {
    start(role: "user" | "assistant", id: string) {
      wire.receive({ type: "turn.created", turn: { role, id } });
    },
    partial(role: "user" | "assistant", text: string) {
      wire.receive({ type: role === "user" ? "input_transcript.added" : "output_transcript.added",
        item: { id: `partial_${++partialId}`, text } });
    },
    final(role: "user" | "assistant", text: string, id?: string, times: { start_ms?: number; end_ms?: number } = {}) {
      wire.receive({ type: "turn.done", turn: { role, transcript: text, ...(id ? { id } : {}), ...times } });
    },
  };
}

test("completed user and assistant captions clear once their custom messages enter chat", async (t) => {
  const h = setup(t, "native");
  trackCustomChat(t, h);
  await h.command();
  for (const role of ["user", "assistant"] as const) {
    const text = `${role} speaking`;
    h.callbacks().onTranscript(role, text, 0, 1, "delta");
    assert.ok(captionText(h).includes(text), "live captions remain visible");
    h.callbacks().onTurn?.(role, text, { id: `${role}_turn` });
    assert.ok(!captionText(h).includes(text), "recorded completed captions are removed");
  }
  assert.equal(h.customMessages.length, 2, "caption cleanup never deletes or replays stored messages");
});

test("queued custom-message captions stay visible until the message actually reaches the branch", async (t) => {
  const h = setup(t, "native");
  const chat = trackCustomChat(t, h, true);
  await h.command();
  h.callbacks().onTurn?.("user", "Queued speech", { id: "queued_user" });
  assert.equal(h.customMessages.length, 1);
  h.advance(1000);
  assert.ok(captionText(h).includes("Queued speech"), "sendMessage returning is not a persistence acknowledgement");
  chat.flush();
  h.advance(1000);
  assert.ok(!captionText(h).includes("Queued speech"));
  assert.equal(h.customMessages.length, 1);
});

test("native accepted prompts hide live ID-linked captions before finalization and absorb later deltas", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const wire = createCodexWire(h.callbacks());
  wire.receive({ type: "input_transcript.added", item: { id: "p1", text: "Inspect tests" } });
  wire.receive({ type: "turn.created", turn: { role: "user", id: "u1" } });
  wire.receive({ type: "delegation.created", item: { type: "delegation", target: "client", id: "task",
    user_bidi_turn_id: "u1", content: [{ type: "input_text", text: "Inspect tests" }] } });
  h.advance(0);
  assert.ok(captionText(h).includes("You …: Inspect tests"), "submission alone does not hide a live caption");
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  assert.equal(captionText(h), "", "do not wait for delayed turn.done after native startup is acknowledged");
  wire.receive({ type: "input_transcript.added", item: { id: "p2", text: " please" } });
  assert.equal(captionText(h), "", "same-turn suffixes cannot recreate the accepted caption");
  wire.receive({ type: "turn.done", turn: { role: "user", id: "u1", transcript: " Inspect tests please" } });
  assert.equal(captionText(h), "");
  assert.equal(h.customMessages.length, 0);
  wire.receive({ type: "input_transcript.added", item: { id: "p3", text: "New speech" } });
  wire.receive({ type: "turn.created", turn: { role: "user", id: "u2" } });
  assert.equal(captionText(h), "You …: New speech", "a different source turn starts a visible caption");
  h.callbacks().onTurn?.("user", "Late old final", { id: "u1" });
  assert.equal(captionText(h), "You …: New speech", "an old final cannot consume a newer identified live caption");
});

test("unidentified live text waits for an authoritative turn ID even if its words match an accepted task", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onTranscript("user", "Inspect tests", 0, 1, "delta");
  h.callbacks().onDelegation("task", 0, "Inspect tests", { userTurnId: "u1" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  assert.equal(captionText(h), "You …: Inspect tests", "no text-based identity guessing");
  h.callbacks().onTurnStart?.("user", "u1");
  assert.equal(captionText(h), "");
});

test("a busy native follow-up keeps its caption until consumed and never returns the earlier run's answer", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.ctx.isIdle = () => false;
  h.callbacks().onTranscript("user", "Inspect tests", 0, 1, "delta");
  h.callbacks().onTurnStart?.("user", "u1");
  h.callbacks().onDelegation("busy", 0, "Inspect tests", { userTurnId: "u1" });
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.deepEqual((h.sent[0] as [string, unknown])[1], { deliverAs: "followUp", expandPromptTemplates: false });
  assert.equal(captionText(h), "You …: Inspect tests");
  h.advance(30_000);
  assert.equal(h.states().at(-1), "listening", "waiting for native consumption has no startup deadline");
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "UNRELATED EARLIER RESULT" }], stopReason: "stop" } });
  assert.equal(h.spoken.length, 0);
  h.callbacks().onTurn?.("user", "Inspect tests", { id: "u1" });
  assert.equal(h.customMessages.length, 0, "queued source final stays reserved");
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: (h.sent[0] as [string])[0] }] } });
  assert.equal(captionText(h), "", "native consumption clears the matching caption without before_agent_start");
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Queued result verified" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  assert.equal(h.customMessages.length, 0);
  assert.equal(h.spoken.at(-1)![1], "Queued result verified");
  assert.ok(h.spoken.every(([, text]) => !text.includes("UNRELATED")));
});

test("native startup acknowledgement clears its held completed caption but not newer live speech", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onDelegation("task", 0, "Inspect tests", { userTurnId: "u1" });
  h.callbacks().onTurn?.("user", "Inspect tests", { id: "u1" });
  assert.ok(captionText(h).includes("Inspect tests"));
  h.advance(0);
  h.callbacks().onTranscript("user", "New live words", 2, 3, "delta");
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  assert.ok(!captionText(h).includes("Inspect tests"));
  assert.ok(captionText(h).includes("New live words"));
  assert.equal(h.customMessages.length, 0);
});

test("unidentified and history-excluded speech is retained in captions", async (t) => {
  const h = setup(t, "native");
  trackCustomChat(t, h);
  await h.command();
  h.callbacks().onTurn?.("user", "Unidentified speech");
  assert.ok(captionText(h).includes("Unidentified speech"));
  h.callbacks().onDelegation("task", 0, "Inspect tests", { userTurnId: "u1" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Pi reply" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  h.callbacks().onTurn?.("assistant", "Unattributed voice speech", { id: "a1" });
  assert.ok(captionText(h).includes("Unattributed voice speech"));
  assert.equal(h.customMessages.length, 0);
});

test("native source-turn linkage leaves one task copy and preserves unrelated conversation", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const wire = createCodexWire(h.callbacks());
  wire.receive({ type: "delegation.created", item: { type: "delegation", target: "client", id: "d1",
    user_bidi_turn_id: "u1", content: [{ type: "input_text", text: "Inspect tests" }] } });
  h.advance(0);
  assert.equal(h.sent.length, 1);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  wire.receive({ type: "turn.done", turn: { role: "user", id: "u1", transcript: " Inspect tests", start_ms: 1, end_ms: 2 } });
  assert.equal(h.customMessages.length, 0, "native task is the sole model/UI copy of this source turn");
  wire.receive({ type: "turn.created", turn: { role: "user", id: "u2" } });
  wire.receive({ type: "turn.done", turn: { role: "user", id: "u2", transcript: "Inspect tests" } });
  wire.receive({ type: "turn.created", turn: { role: "assistant", id: "a1" } });
  wire.receive({ type: "turn.done", turn: { role: "assistant", id: "a1", transcript: "Independent voice reply" } });
  assert.deepEqual(h.customMessages.map(([message]) => message.content), [
    "[talk:user]\nInspect tests", "[talk:assistant]\nIndependent voice reply",
  ], "different source IDs and assistant turns are not text-deduplicated");
  const data = h.entries[0][1] as { userTurnId: string; callId: string };
  assert.equal(data.userTurnId, "u1");
  assert.equal(typeof data.callId, "string");
  h.callbacks().onDelegation("d2", 0, "Inspect tests", { userTurnId: "u1" });
  h.advance(0);
  assert.equal(h.sent.length, 1, "second delegation for an admitted source turn cannot start more work");
  assert.deepEqual(h.spoken, [], "duplicate-source handoffs do not produce busy speech");
});

test("linked final waits for startup acknowledgement instead of entering duplicate context", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onDelegation("pending", 0, "Inspect tests", { userTurnId: "u1" });
  h.callbacks().onTurn?.("user", "Inspect tests", { id: "u1" });
  assert.equal(h.customMessages.length, 0);
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.customMessages.length, 0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  assert.equal(h.customMessages.length, 0);
});

test("busy and became-busy submissions use Pi's queue while reserving their source final", async (t) => {
  for (const mode of ["busy", "delayed"] as const) await t.test(mode, async (sub) => {
    const h = setup(sub, "native");
    await h.command();
    if (mode === "busy") h.ctx.isIdle = () => false;
    h.callbacks().onDelegation(`d_${mode}`, 0, "Inspect tests", { userTurnId: `u_${mode}` });
    h.callbacks().onTurn?.("user", "Inspect tests", { id: `u_${mode}` });
    if (mode === "delayed") h.ctx.isIdle = () => false;
    h.advance(0);
    assert.equal(h.sent.length, 1, mode);
    h.advance(30_000);
    assert.equal(h.states().at(-1), "listening");
    assert.equal(h.customMessages.length, 0, "pending source speech is not duplicated while waiting");
    await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: (h.sent[0] as [string])[0] }] } });
    assert.equal(h.customMessages.length, 0);
    assert.deepEqual(h.spoken, []);
    await h.command("stop");
    assert.equal(h.sent.length, 1, "Talk stop never clears or resubmits native work");
  });
});

test("proven pre-submission failures release held voice history without starting Pi", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const append = h.pi.appendEntry.bind(h.pi);
  t.mock.method(h.pi, "appendEntry", (name: string, value: unknown) => {
    if (name === "talk-delegation") throw new Error("private upstream failure");
    append(name, value);
  });
  h.callbacks().onDelegation("failed", 0, "Inspect tests", { userTurnId: "failed_user" });
  h.callbacks().onTurn?.("user", "Inspect tests", { id: "failed_user" });
  h.advance(0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.customMessages.length, 1);
  assert.equal(h.customMessages[0][0].content, "[talk:user]\nInspect tests");
  assert.deepEqual(h.customMessages[0][1], { triggerTurn: false });
  assert.ok(h.spoken.every(([, text]) => !text.includes("private upstream")));
});

test("stopping Talk detaches an unconsumed native submission without reinserting its source transcript", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.ctx.isIdle = () => false;
  h.callbacks().onDelegation("queued", 0, "Inspect tests", { userTurnId: "queued_user" });
  h.callbacks().onTurn?.("user", "Inspect tests", { id: "queued_user" });
  h.advance(0);
  assert.equal(h.sent.length, 1);
  await h.command("stop");
  assert.equal(h.customMessages.length, 0, "Pi still owns this submitted request after voice closes");
  const updates = h.spoken.length + h.quiet.length;
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: (h.sent[0] as [string])[0] }] } });
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Late native answer" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  assert.equal(h.spoken.length + h.quiet.length, updates, "late native results are not forwarded to a closed call");
});

test("transcript-first late handoff preserves raw history and reports its limitation", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onTurn?.("user", "Inspect tests", { id: "late_user" });
  h.callbacks().onDelegation("late", 0, "Inspect tests", { userTurnId: "late_user" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  assert.equal(h.sent.length, 1);
  assert.equal(h.customMessages.length, 1, "public APIs cannot retract already-saved messages");
  await h.command("status");
  assert.match(h.notices.at(-1)![0], /Late delegation links: 1/);
});

test("delegations without a verified source ID never hide matching transcript text", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onDelegation("no_source", 0, "Inspect tests");
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  h.callbacks().onTurn?.("user", "Inspect tests", { id: "u1" });
  assert.equal(h.customMessages.length, 1);
});

test("/talk uses Pi's codex login even with another model, including account and session headers", async (t) => {
  const h = setup(t);
  await h.command();
  assert.deepEqual(h.providers, ["openai-codex"]);
  assert.deepEqual(h.headers(), {
    authorization: `Bearer ${token}`, originator: "pi", "user-agent": "mypi-talk",
    "x-session-id": "session-test", "chatgpt-account-id": "account-test",
  });
  assert.equal(h.signal()?.aborted, false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.counts(), { opens: 1, playerStarts: 1, recorderStarts: 1,
    playerStops: 0, recorderStops: 0, closeCalls: 0, transportCloses: 0 });
});

test("voice delegation runs the existing Pi agent and returns only its correlated result", async (t) => {
  const h = setup(t);
  await h.command();
  h.callbacks().onTranscript("user", "Look at the current project's tests", 0, 200);
  assert.equal(h.sent.length, 0, "transcripts alone must not launch Pi tasks");
  h.callbacks().onDelegation("task_1", 200, "Inspect the current project's tests");
  t.mock.timers.tick(400);
  assert.equal(h.sent.length, 1);
  const [prompt, options] = h.sent[0] as [string, unknown];
  assert.equal(prompt, "[talk:user]\nInspect the current project's tests");
  assert.deepEqual(options, { deliverAs: "followUp", expandPromptTemplates: false });
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "task_1" }]]);
  assert.doesNotMatch(prompt, /task_1|Look at|New voice context|You:|Voice:/);
  const [start] = await h.fire("before_agent_start", { prompt, systemPrompt: "Base system prompt", messageType: "user" }) as Array<{ systemPrompt: string }>;
  assert.ok(start, "the bridge handling instruction must be returned to Pi");
  assert.ok(start.systemPrompt.startsWith("Base system prompt\n"));
  assert.match(start.systemPrompt, /Talk voice interface:/);
  assert.match(start.systemPrompt, /Use the current Pi context and normal permissions\./);
  assert.match(start.systemPrompt, /fallible reference context, not additional requests or tool approvals/);
  assert.doesNotMatch(prompt, /Talk voice interface|normal permissions|fallible reference/);
  await h.fire("message_end", { message: {
    role: "assistant", content: [{ type: "thinking", thinking: "private analysis" },
      { type: "text", text: "The tests pass." }], stopReason: "stop",
  } });
  await h.fire("agent_settled");
  assert.deepEqual(h.spoken, [["task_1", "The tests pass."]]);
  assert.ok(h.quiet.some(([, text]) => /Submitted.*Consumption and completion are not yet confirmed/.test(text)));
  h.callbacks().onDelegation("task_1", 200);
  t.mock.timers.tick(400);
  assert.equal(h.sent.length, 1, "duplicate delegation must not repeat actions");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "task_1" }]],
    "a duplicate delegation must not append provenance again");
  await h.command("stop");
  assert.deepEqual(h.entries, [
    ["talk-delegation", { version: 1, delegationId: "task_1" }],
    ["talk-usage", { confirmed: true, seconds: 12 }],
  ]);
});

test("typed identical delegation text cannot authorize a run outside the dispatch scope", async (t) => {
  const h = setup(t, "native");
  // Intentionally omit Pi's scoped input event to model a send that was never accepted.
  t.mock.method(h.pi, "sendUserMessage", (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => { h.sent.push(args); });
  await h.command();
  h.callbacks().onDelegation("not-accepted", 0, "Inspect the tests");
  h.advance(0);
  assert.equal(h.sent.length, 1);
  const [prompt] = h.sent[0] as [string];
  assert.equal(prompt, "[talk:user]\nInspect the tests");
  for (const source of ["interactive", "extension"]) {
    await h.fire("input", { text: prompt, source }, h.ctx);
    const starts = await h.fire("before_agent_start", { prompt, systemPrompt: "Base system prompt", messageType: "user" }) as Array<{ systemPrompt: string } | undefined>;
    for (const start of starts) {
      if (start) assert.doesNotMatch(start.systemPrompt, /Talk voice interface:|explicitly delegated by the voice bridge/,
        "unscoped identical text may receive context rules, but never the delegation handling guard");
    }
    await h.fire("message_end", { message: {
      role: "assistant", content: [{ type: "text", text: "Unrelated result" }], stopReason: "stop",
    } });
    await h.fire("agent_settled");
  }
  assert.ok(h.spoken.every(([, text]) => /No result is attributed/.test(text) && !text.includes("Unrelated result")));
  h.advance(10_000);
  await flush();
  assert.ok(h.notices.some(([text, level]) => level === "error" && /did not acknowledge/.test(text)));
  assert.equal(h.states().at(-1), "idle");
  assert.equal(h.sent.length, 1, "unacknowledged work is never retried");
  assert.deepEqual(h.entries, [
    ["talk-delegation", { version: 1, delegationId: "not-accepted" }],
    ["talk-usage", { confirmed: true, seconds: 12 }],
  ]);
});

test("controller input authorization survives an awaited handler during dispatch", async (t) => {
  const h = setup(t, "native");
  t.mock.method(h.pi, "sendUserMessage", async (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => {
    await Promise.resolve();
    for (const handler of h.handlers.get("input") ?? []) {
      await handler({ text: args[0], source: "extension" }, h.ctx);
    }
    h.sent.push(args);
  });
  await h.command();
  h.callbacks().onDelegation("async-input", 0, "Inspect the tests");
  h.advance(0);
  assert.equal(h.sent.length, 0);
  await flush();
  assert.equal(h.sent.length, 1);
  const [prompt] = h.sent[0] as [string];
  const [start] = await h.fire("before_agent_start", { prompt, systemPrompt: "Base system prompt", messageType: "user" }) as Array<{ systemPrompt: string }>;
  assert.ok(start);
  assert.ok(start.systemPrompt.startsWith("Base system prompt\n"));
  assert.match(start.systemPrompt, /Talk voice interface:/);
  h.advance(10_000);
  assert.equal(h.notices.some(([, level]) => level === "error"), false);
  await h.fire("message_end", { message: {
    role: "assistant", content: [{ type: "text", text: "Verified result" }], stopReason: "stop",
  } });
  await h.fire("agent_settled");
  assert.deepEqual(h.spoken, [["async-input", "Verified result"]]);
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "async-input" }]]);
});

test("synchronous recorder failure cleans up without reporting a connected session", async (t) => {
  const h = setup(t);
  let stopped = 0;
  h.setCapture(() => {
    h.recorderError(new Error("Microphone unavailable"));
    return { stop: async () => { stopped++; } };
  });
  await h.command();
  await flush();
  assert.ok(stopped >= 1);
  assert.equal(h.states().at(-1), "idle");
  assert.equal(h.notices.some(([text]) => text.startsWith("Talk connected.")), false);
});

test("Codex browser media skips native audio while preserving the Pi bridge and draft", async (t) => {
  const h = setup(t, "browser");
  await h.command();
  assert.equal(h.counts().playerStarts, 0);
  assert.equal(h.counts().recorderStarts, 0);
  assert.equal(h.states().at(-1), "listening");
  assert.equal(h.dashboard()[0].state, "connecting");
  assert.deepEqual(h.dashboard().at(-1), { state: "listening", elapsedMs: 0 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  h.callbacks().onConnectUrl?.("http://127.0.0.1:43123/#token=ephemeral");
  assert.match(h.notices.at(-1)![0], /Start microphone.*\nhttp:/s);
  // Codex supplies the task itself; it need not wait for public-API transcripts.
  h.callbacks().onDelegation("codex_task", 100, "Run the project's tests");
  t.mock.timers.tick(400);
  assert.equal(h.sent.length, 1);
  const [prompt] = h.sent[0] as [string];
  assert.equal(prompt, "[talk:user]\nRun the project's tests");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "codex_task" }]]);
  await h.fire("before_agent_start", { prompt });
  await h.fire("message_end", { message: {
    role: "assistant", content: [{ type: "text", text: "All tests passed." }], stopReason: "stop",
  } });
  await h.fire("agent_settled");
  assert.deepEqual(h.spoken, [["codex_task", "All tests passed."]]);
  h.setCloseInfo({ confirmed: false, reason: "codex_peer_closed" });
  await h.command("stop");
  assert.equal(h.notices.some(([text]) => /does not expose confirmed final voice usage/.test(text)), false);
});

test("browser link and setup phase remain visible while /talk is pending", async (t) => {
  const h = setup(t, "browser");
  const connection = deferred<LiveSession>();
  h.setConnect(() => connection.promise);
  const starting = h.command();
  await flush();
  const url = "http://127.0.0.1:43123/#token=ephemeral-local-key";
  h.callbacks().onConnectUrl?.(url);
  let widget = h.widgets.at(-1)![1]!.join("\n");
  assert.match(h.dashboard().at(-1)!.detail!, /Waiting for browser.*Start microphone/);
  assert.equal(h.dashboard().at(-1)!.state, "connecting");
  assert.equal(h.dashboard().at(-1)!.elapsedMs, undefined);
  assert.doesNotMatch(widget, /Talk ·|Waiting for browser|Start microphone|Ready|Connecting voice/);
  assert.ok(widget.includes(url));
  await h.command("status");
  assert.ok(h.notices.at(-1)![0].includes(url));
  h.callbacks().onProgress?.("Connecting to Codex voice…");
  widget = h.widgets.at(-1)![1]!.join("\n");
  assert.equal(h.dashboard().at(-1)!.detail, "Connecting to Codex voice…");
  assert.ok(widget.includes(url));
  assert.doesNotMatch(widget, /Connecting to Codex voice/);
  connection.resolve(h.live);
  await starting;
  widget = h.widgets.at(-1)![1]!.join("\n");
  assert.equal(widget, "");
  assert.deepEqual(h.dashboard().at(-1), { state: "listening", elapsedMs: 0 });
});

test("macOS automatically opens only the local browser capability URL", { skip: process.platform !== "darwin" }, async (t) => {
  const h = setup(t, "browser");
  const opened: [string, string[]][] = [];
  h.pi.exec = async (command, args) => {
    opened.push([command, args]);
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  await h.command();
  const url = "http://127.0.0.1:43123/#token=ephemeral-local-key";
  h.callbacks().onConnectUrl?.(url);
  await flush();
  assert.deepEqual(opened, [["open", [url]]]);
  assert.doesNotMatch(JSON.stringify(opened), /account-test|signature|Bearer/);
});

test("native audio mode needs no browser or SoX and keeps the existing agent bridge", async (t) => {
  const h = setup(t, "native");
  let opens = 0;
  h.pi.exec = async () => {
    opens++;
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  await h.command();
  assert.equal(h.counts().playerStarts, 0);
  assert.equal(h.counts().recorderStarts, 0);
  assert.equal(opens, 0);
  assert.deepEqual(h.states(), ["connecting", "listening"]);
  assert.deepEqual(h.dashboard().at(-1), { state: "listening", elapsedMs: 0 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  h.callbacks().onDelegation("native_task", 100, "Inspect the current project");
  t.mock.timers.tick(400);
  assert.equal(h.sent.length, 1);
  const [prompt] = h.sent[0] as [string];
  await h.fire("before_agent_start", { prompt });
  await h.fire("message_end", { message: {
    role: "assistant", content: [{ type: "text", text: "I inspected the project." }], stopReason: "stop",
  } });
  await h.fire("agent_settled");
  assert.deepEqual(h.spoken, [["native_task", "I inspected the project."]]);
});

test("audio routes both ways; readiness requires the first nonempty microphone PCM only", async (t) => {
  const h = setup(t);
  await h.command("start");
  assert.deepEqual(h.states(), ["connecting"]);
  assert.equal(h.dashboard()[0].state, "connecting");
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  const output = Buffer.from([1, 2]);
  h.callbacks().onAudio(output);
  h.callbacks().onTranscript("assistant", "Ready", 0, 10);
  h.capture(Buffer.alloc(0));
  assert.deepEqual(h.states(), ["connecting"]);
  const input = Buffer.from([3, 4]);
  h.capture(input);
  h.capture(input);
  assert.deepEqual(h.states(), ["connecting", "listening"]);
  assert.deepEqual(h.dashboard().at(-1), { state: "listening", elapsedMs: 0 });
  assert.deepEqual(h.appended, [Buffer.alloc(0), input, input]);
  assert.deepEqual(h.played, [output]);
});

test("status reports off, starting and active; duplicate start does not open another session", async (t) => {
  const h = setup(t);
  await h.command("status");
  assert.deepEqual(h.notices.at(-1), ["Talk: off", "info"]);
  const auth = deferred<string>();
  h.setAuthorize(() => auth.promise);
  const starting = h.command();
  await h.command("status");
  assert.match(h.notices.at(-1)![0], /^Talk: starting\n/);
  assert.match(h.notices.at(-1)![0], /Voice context: 0 turn\(s\) submitted to Pi/);
  assert.equal(h.notices.at(-1)![1], "info");
  await h.command("start");
  assert.match(h.notices.at(-1)![0], /already running/);
  auth.resolve(token);
  await starting;
  await h.command("status");
  assert.match(h.notices.at(-1)![0], /^Talk: active\n/);
  assert.match(h.notices.at(-1)![0], /Voice context: 0 turn\(s\) submitted to Pi/);
  assert.equal(h.notices.at(-1)![1], "info");
  assert.equal(h.counts().opens, 1);
  await h.command("stop");
  await h.command("status");
  assert.deepEqual(h.notices.at(-1), ["Talk: off", "info"]);
});

test("graceful stop stops player and recorder before close, records usage, and ignores late callbacks", async (t) => {
  const h = setup(t);
  await h.command();
  const stopping = h.command("stop");
  await h.command("status");
  assert.match(h.notices.at(-1)![0], /^Talk: closing\n/);
  assert.match(h.notices.at(-1)![0], /Voice context: 0 turn\(s\) submitted to Pi/);
  assert.equal(h.notices.at(-1)![1], "info");
  await Promise.all([stopping, h.command("stop")]);
  assert.deepEqual(h.order, ["recorder.stop", "player.stop", "live.close"]);
  assert.deepEqual(h.states(), ["connecting", "closing", "idle"]);
  assert.deepEqual(h.entries, [["talk-usage", { confirmed: true, seconds: 12 }]]);
  assert.equal(h.counts().closeCalls, 1);
  assert.equal(h.counts().transportCloses, 1);
  assert.equal(h.signal()?.aborted, true);
  assert.deepEqual(h.statuses.at(-1), ["talk", undefined]);
  assert.deepEqual(h.widgets.at(-1), ["talk", undefined]);
  assert.deepEqual(h.dashboard().at(-1), { state: "idle" });
  const widgetCount = h.widgets.length;
  const updates = h.dashboard().length;
  h.capture(Buffer.from([1, 2]));
  h.callbacks().onAudio(Buffer.from([1, 2]));
  h.callbacks().onTranscript("user", "late", 0, 1);
  h.callbacks().onTurn?.("user", "late final", { id: "late_final" });
  h.callbacks().onProgress?.("late progress");
  h.callbacks().onDelegation("late-task", 1);
  h.callbacks().onError(new Error("late error"));
  assert.deepEqual(h.appended, []);
  assert.deepEqual(h.played, []);
  assert.deepEqual(h.sent, []);
  assert.equal(h.widgets.length, widgetCount);
  assert.equal(h.dashboard().length, updates);
  assert.deepEqual(h.customMessages, []);
  assert.equal(h.notices.filter(([, level]) => level === "error").length, 0);
});

for (const stage of ["missing auth", "rejected auth", "open", "recorder"] as const) {
  test(`failed startup (${stage}) cleans up after queued microtasks`, async (t) => {
    const h = setup(t);
    if (stage === "missing auth") h.setAuthorize(async () => undefined);
    if (stage === "rejected auth") h.setAuthorize(async () => { throw new Error("auth failed"); });
    if (stage === "open") h.setConnect(async () => { throw new Error("connect failed"); });
    if (stage === "recorder") h.setCapture(() => { throw new Error("capture failed"); });
    await h.command();
    await flush();
    assert.deepEqual(h.states(), ["connecting", "closing", "idle"]);
    assert.equal(h.notices.filter(([, level]) => level === "error").length, 1);
    assert.equal(h.counts().playerStops, stage === "open" || stage === "recorder" ? 1 : 0);
    assert.equal(h.counts().recorderStops, 0);
    if (h.signal()) assert.equal(h.signal()!.aborted, true);
    assert.deepEqual(h.statuses.at(-1), ["talk", undefined]);
    assert.deepEqual(h.widgets.at(-1), ["talk", undefined]);
  });
}

for (const stage of ["auth", "open"] as const) {
  test(`stop during pending ${stage} prevents late startup from opening the recorder`, async (t) => {
    const h = setup(t);
    const auth = deferred<string>();
    const connection = deferred<LiveSession>();
    if (stage === "auth") h.setAuthorize(() => auth.promise);
    else h.setConnect(() => connection.promise);
    const starting = h.command();
    await flush();
    await h.command("stop");
    if (stage === "auth") auth.resolve(token);
    else connection.resolve(h.live);
    await starting;
    await flush();
    assert.equal(h.counts().recorderStarts, 0);
    assert.equal(h.counts().opens, stage === "auth" ? 0 : 1);
    assert.equal(h.counts().playerStops, stage === "auth" ? 0 : 1);
    assert.equal(h.counts().closeCalls, stage === "auth" ? 0 : 1);
    assert.deepEqual(h.states(), ["connecting", "closing", "idle"]);
  });
}

for (const cause of ["network error", "remote close", "player", "recorder"] as const) {
  test(`${cause} callbacks fail closed once and return to idle`, async (t) => {
    const h = setup(t);
    await h.command();
    const error = new Error("connection lost");
    if (cause === "remote close") h.finish({ confirmed: false, reason: "connection_lost" });
    else if (cause === "player") h.playerError(error);
    else if (cause === "recorder") h.recorderError(error);
    else h.callbacks().onError(error);
    h.callbacks().onError(error);
    h.callbacks().onClosed({ confirmed: false });
    await flush();
    assert.deepEqual(h.states(), ["connecting", "closing", "idle"]);
    assert.equal(h.counts().transportCloses, 1);
    assert.equal(h.counts().closeCalls, 0, "failure aborts transport instead of graceful close");
    assert.equal(h.counts().playerStops, 1);
    assert.equal(h.counts().recorderStops, 1);
    assert.equal(h.signal()?.aborted, true);
    assert.equal(h.notices.filter(([, level]) => level === "error").length, cause === "remote close" ? 0 : 1);
    assert.deepEqual(h.entries, [["talk-usage", { confirmed: false }]]);
  });
}

test("ten-minute maximum uses a timer and gracefully stops exactly once", async (t) => {
  const h = setup(t);
  await h.command();
  t.mock.timers.tick(10 * 60_000 - 1);
  assert.equal(h.counts().recorderStops, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.match(h.notices.at(-1)![0], /ten-minute limit/);
  assert.deepEqual(h.states(), ["connecting", "closing", "idle"]);
  assert.equal(h.counts().closeCalls, 1);
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(h.counts().closeCalls, 1);
});

test("session_shutdown gracefully cleans up and cancels the maximum-duration timer", async (t) => {
  const h = setup(t);
  await h.fire("session_start", {}, undefined);
  assert.deepEqual(h.states(), ["idle"]);
  assert.deepEqual(h.dashboard(), [{ state: "idle" }]);
  await h.command();
  await h.fire("session_shutdown", {}, undefined);
  assert.equal(h.counts().playerStops, 1);
  assert.equal(h.counts().recorderStops, 1);
  assert.equal(h.counts().closeCalls, 1);
  const noticeCount = h.notices.length;
  t.mock.timers.tick(20 * 60_000);
  await flush();
  assert.equal(h.notices.length, noticeCount);
  assert.deepEqual(h.states(), ["idle", "connecting", "closing", "idle"]);
});

test("dictation events synchronously stop Talk and prevent starts until dictation is idle", async (t) => {
  const h = setup(t);
  await h.command();
  h.events.emit(DICTATION_CHANGED_EVENT, "connecting");
  assert.equal(h.states().at(-1), "closing");
  await flush();
  assert.equal(h.states().at(-1), "idle");
  assert.equal(h.counts().playerStops, 1);
  assert.equal(h.counts().recorderStops, 1);
  assert.match(h.notices.find(([message]) => message.includes("dictation started"))![0], /Talk stopped/);
  for (const state of ["connecting", "listening", "finishing"]) {
    h.events.emit(DICTATION_CHANGED_EVENT, state);
    await h.command("start");
    assert.match(h.notices.at(-1)![0], /Finish or cancel dictation/);
  }
  assert.equal(h.counts().opens, 1);
  h.events.emit(DICTATION_CHANGED_EVENT, "idle");
  await h.command();
  assert.equal(h.counts().opens, 2);
});

test("captions use separate user/voice widget lines, sanitize controls, and never touch the draft", async (t) => {
  const h = setup(t);
  await h.command();
  h.callbacks().onTranscript("user", "Hello\x00 there", 0, 100);
  h.callbacks().onTranscript("assistant", "Hi\x1b[31m!", 100, 200);
  assert.deepEqual(h.widgets.at(-1), ["talk", [
    "You …: Hello there", "Voice …: Hi!",
  ]]);
  assert.deepEqual(h.sent, []);
});

test("widget keeps separate unidentified final captions and overlapping speech without persisting them", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onTranscript("user", "wrong", 0, 100);
  h.callbacks().onTranscript("assistant", "Hello", 10, 150);
  h.callbacks().onTurn?.("user", "Hello there");
  h.callbacks().onTurn?.("assistant", "Hello!");
  h.callbacks().onTranscript("user", "Second question", 200, 300);
  h.callbacks().onTranscript("assistant", "Let me think", 250, 350);
  const lines = h.widgets.at(-1)![1]!;
  assert.deepEqual(lines, ["You …: Second question", "Voice …: Let me think"]);
  assert.deepEqual(h.entries, [], "captions must not become non-context session entries");
  assert.deepEqual(h.customMessages, [], "final captions without source IDs must not become history");
  assert.deepEqual(h.sent, [], "caption changes must not trigger Pi");
  await h.command("stop");
  const widgets = h.widgets.length;
  h.callbacks().onTurn?.("user", "late final");
  assert.equal(h.widgets.length, widgets);
});

test("terminal prompts and final replies reach Live as quiet reference context only", async (t) => {
  const h = setup(t, "native");
  await h.command();
  await h.fire("input", { text: "Inspect the terminal README", source: "interactive" }, h.ctx);
  assert.equal(h.quiet.filter(([, text]) => text.includes("Inspect the terminal README")).length, 1);
  assert.deepEqual(h.spoken, []);
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "Inspect the terminal README" }] } });
  await h.fire("message_end", { message: { role: "assistant", content: [
    { type: "thinking", thinking: "PRIVATE THOUGHT" },
    { type: "toolCall", id: "tool", name: "bash", arguments: { command: "PRIVATE TOOL" } },
    { type: "text", text: "Checking the README" },
  ], stopReason: "toolUse" } });
  assert.ok(h.quiet.some(([, text]) => text.includes("Checking the README")));
  await h.fire("message_end", { message: { role: "assistant", content: [
    { type: "text", text: "The README is verified" },
  ], stopReason: "stop" } });
  assert.ok(h.quiet.every(([, text]) => !text.includes("The README is verified")), "wait for final settlement");
  await h.fire("agent_settled");
  assert.equal(h.quiet.filter(([, text]) => text.includes("The README is verified")).length, 1);
  assert.ok(h.quiet.every(([, text]) => !/PRIVATE THOUGHT|PRIVATE TOOL/.test(text)));
  assert.deepEqual(h.spoken, [], "terminal conversation is not read aloud");
  assert.deepEqual(h.sent, [], "mirroring cannot start another Pi request");
  assert.deepEqual(h.customMessages, [], "the native terminal messages must not be duplicated in Pi history");
  await h.command("stop");
  const count = h.quiet.length;
  await h.fire("input", { text: "After stop", source: "interactive" }, h.ctx);
  await h.fire("agent_settled");
  assert.equal(h.quiet.length, count);
});

test("a queued voice task preserves the prior terminal reply without mirroring the voice result twice", async (t) => {
  const h = setup(t, "native");
  await h.command();
  await h.fire("input", { text: "Typed work", source: "interactive" }, h.ctx);
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "Typed work" }] } });
  h.ctx.isIdle = () => false;
  h.callbacks().onDelegation("queued_voice", 0, "Inspect voice tests", { userTurnId: "voice_user" });
  h.advance(0);
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Terminal prior reply" }], stopReason: "stop" } });
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: (h.sent[0] as [string])[0] }] } });
  assert.equal(h.quiet.filter(([, text]) => text.includes("Terminal prior reply")).length, 1);
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Queued voice result" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  assert.equal(h.quiet.filter(([, text]) => text.includes("Terminal prior reply")).length, 1);
  assert.ok(h.quiet.every(([, text]) => !text.includes("Queued voice result")));
  assert.equal(h.spoken.at(-1)![1], "Queued voice result");
});

test("a fresh native Stop Pi command requests normal abort once and keeps voice and the bridge connected", async (t) => {
  const h = setup(t, "native");
  const signal = h.startPiWork();
  h.expectAborts(1);
  await h.command();
  const wire = createCodexWire(h.callbacks());
  wire.receive({ type: "input_transcript.added", item: { id: "stop_fragment_1", text: "Stop" } });
  wire.receive({ type: "turn.created", turn: { role: "user", id: "stop_user" } });
  wire.receive({ type: "input_transcript.added", item: { id: "stop_fragment_2", text: " Pi" } });
  wire.receive({ type: "delegation.created", item: { type: "delegation", target: "client", id: "stop_request",
    user_bidi_turn_id: "stop_user", content: [{ type: "input_text", text: "Stop Pi" }] } });
  assert.equal(h.aborts(), 1);
  assert.equal(signal.aborted, true);
  assert.equal(h.states().at(-1), "listening");
  assert.equal(h.counts().closeCalls, 0, "Stop Pi must not stop Talk");
  assert.equal(h.sent.length, 0, "cancellation is local, never queued behind the work it must interrupt");
  assert.ok(h.spoken.some(([, text]) => /Stop requested/i.test(text)));
  h.callbacks().onTranscript("user", "Inspect docs", 0, 1, "delta", { itemId: "next_project_asr" });
  h.callbacks().onDelegation("next_project", 0, "Inspect docs", { userTurnId: "next_user" });
  h.advance(0);
  assert.equal(h.sent.length, 1, "the voice bridge remains usable after interruption");
});

test("Stop Pi rejects negated, final-only, and unidentified speech without queueing a cancellation", async (t) => {
  for (const mode of ["negated", "final", "unidentified"] as const) await t.test(mode, async (sub) => {
    const h = setup(sub, "native");
    h.startPiWork();
    await h.command();
    const wire = createCodexWire(h.callbacks());
    const speech = mode === "negated" ? "Don't stop Pi" : "Stop Pi";
    if (mode === "final") {
      wire.receive({ type: "turn.done", turn: { role: "user", id: "stop_user", transcript: speech } });
    } else {
      wire.receive({ type: "input_transcript.added", item: { ...(mode === "unidentified" ? {} : { id: "fragment" }), text: speech } });
      wire.receive({ type: "turn.created", turn: { role: "user", id: "stop_user" } });
    }
    wire.receive({ type: "delegation.created", item: { type: "delegation", target: "client", id: "unsafe_stop",
      user_bidi_turn_id: "stop_user", content: [{ type: "input_text", text: "Stop Pi" }] } });
    h.advance(0);
    assert.equal(h.aborts(), 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.counts().closeCalls, 0);
  });
});

test("Stop Pi can abort a waiting voice questionnaire without committing its collected speech as an answer", async (t) => {
  const h = setup(t, "native");
  const signal = h.startPiWork();
  h.expectAborts(1);
  await h.command();
  const answer = requestVoiceQuestions(h.events, questions(), signal);
  const wire = createCodexWire(h.callbacks());
  wire.receive({ type: "turn.created", turn: { role: "assistant", id: "question_prompt" } });
  wire.receive({ type: "turn.done", turn: { role: "assistant", id: "question_prompt", transcript: h.spoken.at(-1)![1] } });
  wire.receive({ type: "input_transcript.added", item: { id: "stop_asr", text: "Stop Pi" } });
  wire.receive({ type: "turn.created", turn: { role: "user", id: "stop_user" } });
  wire.receive({ type: "delegation.created", item: { type: "delegation", target: "client", id: "stop_question",
    user_bidi_turn_id: "stop_user", content: [{ type: "input_text", text: "Stop Pi" }] } });
  assert.equal(h.aborts(), 1);
  const cancelled = await answer;
  assert.equal(cancelled?.cancelled, true, "aborting the tool signal is not a questionnaire answer or approval");
  assert.deepEqual(cancelled?.answers, []);
  assert.equal(h.sent.length, 0);
  assert.equal(h.counts().closeCalls, 0);
});

test("descriptive questions about Stop Pi remain normal backend requests rather than control attempts", async (t) => {
  const h = setup(t, "native");
  h.startPiWork();
  await h.command();
  const input = "Explain how Stop Pi works";
  const wire = createCodexWire(h.callbacks());
  wire.receive({ type: "input_transcript.added", item: { id: "question_asr", text: input } });
  wire.receive({ type: "turn.created", turn: { role: "user", id: "question_user" } });
  wire.receive({ type: "delegation.created", item: { type: "delegation", target: "client", id: "question_about_stop",
    user_bidi_turn_id: "question_user", content: [{ type: "input_text", text: input }] } });
  h.advance(0);
  assert.equal(h.aborts(), 0);
  assert.equal(h.sent.length, 1);
});

test("public voice commentary is spoken before tools, with quiet safe tool facts and a separate final result", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onDelegation("commentary", 0, "Inspect voice logs", { userTurnId: "commentary_user" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  const quietBefore = h.quiet.length;
  await h.fire("agent_start");
  h.advance(150);
  assert.ok(h.quiet.slice(quietBefore).every(([, text]) => !text.includes("The Pi coding agent started working")),
    "agent-start no longer adds a redundant generic notice (local control capability updates are separate)");
  const update = "You're right; I'll check the latest trace before proposing a change.";
  await h.fire("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "PRIVATE THOUGHT" }, { type: "text", text: update },
    { type: "toolCall", id: "private_tool", name: "bash", arguments: { token: "PRIVATE ARGUMENT" } },
  ] } });
  assert.deepEqual(h.spoken, [["commentary", `Pi commentary (work in progress):\n${update}`]]);
  await h.fire("tool_execution_start", { toolCallId: "tool-1", toolName: "bash", args: { secret: "PRIVATE ARGUMENT" } });
  await h.fire("tool_execution_update", { toolCallId: "tool-1", toolName: "bash", partialResult: "PRIVATE STREAM" });
  await h.fire("tool_execution_end", { toolCallId: "tool-1", toolName: "bash", isError: false, result: "PRIVATE OUTPUT" });
  h.advance(150);
  assert.ok(h.quiet.some(([, text]) => text === "Tool bash started."));
  assert.ok(h.quiet.some(([, text]) => /Tool bash returned.*task completion unconfirmed/.test(text)));
  assert.ok(!JSON.stringify([...h.quiet, ...h.spoken]).includes("PRIVATE"));
  h.callbacks().onTurnStart?.("assistant", "commentary_readback");
  h.callbacks().onTurn?.("assistant", update, { id: "commentary_readback" });
  assert.equal(h.customMessages.length, 0, "public Pi commentary readback is not duplicated into voice history");
  await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Final trace result" }] } });
  assert.equal(h.spoken.length, 1, "final text still waits for settlement");
  await h.fire("agent_settled");
  assert.equal(h.spoken.length, 2);
  assert.equal(h.spoken[1][1], "Final trace result");
});

test("different requests sharing one server user turn reach Pi, while identical retries are ignored", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onDelegation("inspect", 0, "Inspect the repo", { userTurnId: "shared_user" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  h.ctx.isIdle = () => false;
  h.callbacks().onDelegation("time", 0, "What time is it", { userTurnId: "shared_user" });
  h.callbacks().onDelegation("time_retry", 0, "  What time is it  ", { userTurnId: "shared_user" });
  h.advance(0);
  assert.equal(h.sent.length, 2, "one broad user-speaking turn can contain multiple distinct tasks");
  assert.equal((h.sent[1] as [string])[0], "[talk:user]\nWhat time is it");
  h.callbacks().onTurn?.("user", "Inspect the repo What time is it", { id: "shared_user" });
  assert.equal(h.customMessages.length, 0);
  await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Repo inspected" }] } });
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: (h.sent[1] as [string])[0] }] } });
  await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "It is noon" }] } });
  await h.fire("agent_settled");
  assert.equal(h.sent.length, 2);
  assert.equal(h.spoken.at(-1)![1], "It is noon");
  assert.ok(h.quiet.some(([, text]) => text === "Repo inspected"));
  assert.equal(h.customMessages.length, 0);
});

test("a failed task cannot release a shared-turn transcript while another distinct task is reserved", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.ctx.isIdle = () => false;
  const append = h.pi.appendEntry.bind(h.pi);
  t.mock.method(h.pi, "appendEntry", (name: string, data: unknown) => {
    if (name === "talk-delegation" && (data as { delegationId: string }).delegationId === "fails") throw new Error("submission failed");
    append(name, data);
  });
  h.callbacks().onDelegation("fails", 0, "Inspect tests", { userTurnId: "shared" });
  h.callbacks().onDelegation("survives", 0, "Inspect docs", { userTurnId: "shared" });
  h.callbacks().onTurn?.("user", "Inspect tests Inspect docs", { id: "shared" });
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.customMessages.length, 0, "the remaining reservation must keep the shared final held");
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: (h.sent[0] as [string])[0] }] } });
  assert.equal(h.customMessages.length, 0);
});

test("native all-mode follow-ups can share one spoken result without duplicating source transcripts", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.ctx.isIdle = () => false;
  for (const [id, text] of [["one", "Inspect tests"], ["two", "Inspect docs"]]) {
    h.callbacks().onDelegation(id, 0, text, { userTurnId: `user_${id}` });
    h.callbacks().onTurn?.("user", text, { id: `user_${id}` });
  }
  h.advance(0);
  assert.equal(h.sent.length, 2);
  assert.equal(h.customMessages.length, 0);
  for (const [prompt] of h.sent as Array<[string]>) {
    await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: prompt }] } });
  }
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Tests and docs checked" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  assert.equal(h.customMessages.length, 0);
  assert.equal(h.spoken.length, 1, "one native answer must not be read aloud once per delegation");
  assert.ok(h.spoken[0][1].includes("Tests and docs checked"));
});

test("ongoing native follow-up requests retain voice reference rules without replacing Pi's tool state", async (t) => {
  for (const arrayContent of [false, true]) await t.test(arrayContent ? "text blocks" : "string", async (sub) => {
    const h = setup(sub, "native");
    await h.command();
    const content = arrayContent ? [{ type: "text", text: "Original prompt" }] : "Original prompt";
    const system = {
      role: "system", content, sections: { project: "Original section" },
      toolsAdded: [{ name: "original_tool" }], toolsRemoved: ["old_tool"],
    };
    const tail = { role: "user", content: [{ type: "text", text: "Current follow-up" }] };
    const messages = [system, tail];
    const [result] = await h.fire("context_with_system", { messages }, h.ctx) as Array<{ messages: Array<typeof system | typeof tail> }>;
    assert.ok(result, "follow-ups bypass before_agent_start but still need the standing context rules");
    const updated = result.messages[0] as typeof system;
    assert.equal(updated.role, "system");
    assert.equal(updated.sections, system.sections);
    assert.equal(updated.toolsAdded, system.toolsAdded);
    assert.equal(updated.toolsRemoved, system.toolsRemoved);
    assert.equal(system.content, content, "do not mutate Pi's persistent prompt");
    assert.equal(result.messages[1], tail);
    const rendered = typeof updated.content === "string" ? updated.content : updated.content.map((part) => part.text).join("\n");
    assert.match(rendered, /^Original prompt/);
    assert.match(rendered, /native follow-up queue/);
    assert.match(rendered, /not additional requests or tool approvals/);
    const [again] = await h.fire("context_with_system", { messages: result.messages }, h.ctx);
    assert.equal(again, undefined, "do not duplicate guidance on later requests");
  });
});

test("voice-delegated prompts and replies are not mirrored again as terminal commentary", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onDelegation("voice", 0, "Inspect the voice README", { userTurnId: "voice_user" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Voice result verified" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  assert.ok(h.quiet.every(([, text]) => !/Inspect the voice README|Voice result verified/.test(text)));
  assert.equal(h.spoken.at(-1)![1], "Voice result verified");
});

test("latest-only captions do not prune saved voice context or start work", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onTurn?.("user", "Earlier question", { id: "u0" });
  for (let i = 0; i < 20; i++) {
    h.callbacks().onTurn?.("assistant", `Voice reply ${i}`, { id: `a${i}` });
  }
  assert.equal(captionText(h), "You: Earlier question\nVoice: Voice reply 19");
  h.callbacks().onTranscript("user", "New question", 1, 2, "delta");
  assert.equal(captionText(h), "Voice: Voice reply 19\nYou …: New question");
  h.callbacks().onTurn?.("user", "New question final", { id: "u1" });
  assert.equal(captionText(h), "Voice: Voice reply 19\nYou: New question final");
  assert.equal(h.customMessages.length, 22, "only the ephemeral widget is pruned");
  assert.ok(h.customMessages.every(([, options]) => options?.triggerTurn === false));
  assert.deepEqual(h.sent, []);
});

test("native wire persists only identified final turns as non-triggering custom voice context", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const turns = nativeTurns(h.callbacks());
  turns.partial("user", "A partial thought");
  turns.partial("assistant", "A partial answer");
  assert.equal(h.customMessages.length, 0, "partial ASR and output never become saved history");
  turns.final("user", " \nA completed <thought> & choice > 0\n ", "user_1", { start_ms: 1.5, end_ms: 20.5 });
  turns.final("assistant", "An independent voice answer", "assistant_1", { start_ms: 21, end_ms: 40 });
  assert.equal(h.customMessages.length, 2);
  const callId = (h.customMessages[0][0].details as { callId: string }).callId;
  assert.match(callId, /^[a-f0-9-]{36}$/);
  for (const [index, [message, options]] of h.customMessages.entries()) {
    assert.equal(message.customType, "talk-history");
    assert.equal(message.display, true);
    assert.deepEqual(options, { triggerTurn: false });
    assert.equal(message.content, index
      ? "[talk:assistant]\nAn independent voice answer"
      : "[talk:user]\nA completed <thought> & choice > 0");
    assert.deepEqual(message.details, {
      version: 1, callId, turnId: index ? "assistant_1" : "user_1", speaker: index ? "assistant" : "user",
      source: { provider: "openai-codex", model: "gpt-live-1-codex" },
      startMs: index ? 21 : 1.5, endMs: index ? 40 : 20.5,
    });
    assert.equal(Object.hasOwn(message, "role"), false, "history is not a fabricated native user/assistant message");
    assert.equal(Object.hasOwn(message, "usage"), false);
  }
  turns.final("user", "A completed thought", "user_1");
  turns.final("assistant", "An independent voice answer", "assistant_1");
  // Also exercise controller/history dedupe without the wire's duplicate filter.
  h.callbacks().onTurn?.("user", "A completed thought", { id: "user_1" });
  h.callbacks().onTurn?.("assistant", "An independent voice answer", { id: "assistant_1" });
  assert.equal(h.customMessages.length, 2);
  turns.final("user", "A caption without server identity");
  assert.ok(h.widgets.at(-1)![1]!.includes("You: A caption without server identity"));
  assert.equal(h.customMessages.length, 2, "unidentified final captions are still display-only");
  assert.deepEqual(h.sent, [], "saving voice context must never submit a Pi prompt");
  assert.deepEqual(h.entries, [], "history uses context messages, not appendEntry");
  await h.command("status");
  assert.match(h.notices.at(-1)![0], /^Talk: active\n/);
  assert.match(h.notices.at(-1)![0], /Voice context: 2 turn\(s\) submitted to Pi/);
});

for (const presentation of ["Pi result", "clarification"] as const) {
  test(`${presentation} speech bars unowned assistant output until a fresh identified turn`, async (t) => {
    const h = setup(t, "native");
    await h.command();
    const turns = nativeTurns(h.callbacks());
    turns.final("assistant", "Independent greeting", "greeting");
    h.callbacks().onDelegation("presentation", 0, presentation === "Pi result" ? "Inspect the project's tests" : "Okay do it");
    h.advance(400);
    if (presentation === "Pi result") {
      assert.equal(h.sent.length, 1);
      const [prompt] = h.sent[0] as [string];
      await h.fire("before_agent_start", { prompt });
      await h.fire("message_end", { message: {
        role: "assistant", content: [{ type: "text", text: "The tests pass." }], stopReason: "stop",
      } });
      await h.fire("agent_settled");
      assert.deepEqual(h.spoken, [["presentation", "The tests pass."]]);
    } else {
      assert.deepEqual(h.sent, []);
      assert.match(h.spoken.at(-1)![1], /What exactly would you like me to do/);
    }
    const readback = h.spoken.at(-1)![1];
    turns.partial("assistant", readback);
    turns.final("assistant", readback, "readback");
    assert.equal(h.customMessages.length, 1, "Pi-supplied speech must not be copied as a voice-model answer");
    turns.final("user", "Another conversational thought", "later_user");
    h.advance(30_000);
    turns.final("assistant", "Different delayed output", "unattributed_output");
    assert.equal(h.customMessages.length, 2, "a final without a fresh turn start and a timer cannot reopen assistant recording");
    assert.match(String(h.customMessages[1][0].content), /Another conversational thought/);
    assert.equal(h.sent.length, presentation === "Pi result" ? 1 : 0, "history never generates another native prompt");
    await h.command("status");
    assert.match(h.notices.at(-1)![0], /Voice context: 2 turn\(s\)/);
    assert.match(h.notices.at(-1)![0], /Skipped:/);
  });
}

test("conversation after Pi speech saves both missing voice replies, then excludes the next handoff", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const turns = nativeTurns(h.callbacks());
  h.callbacks().onDelegation("initial", 0, "Inspect tests", { userTurnId: "initial_user" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[0] as [string])[0] });
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Backend explanation" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  turns.start("assistant", "readback");
  turns.final("assistant", "Backend explanation", "readback");
  assert.equal(h.customMessages.length, 0, "Pi's readback is not duplicated");
  const pairs = [
    ["Well, it might be actually pretty good", "Hmm, it could be, yeah. What part seems good to you?"],
    ["Yeah, that we don't send it", "I get that. It’s safer, sure, but it also hid a genuine reply. Do you want that tradeoff?"],
  ];
  for (const [index, [user, assistant]] of pairs.entries()) {
    turns.start("user", `u${index}`);
    turns.final("user", user, `u${index}`);
    turns.start("assistant", `a${index}`);
    turns.final("assistant", assistant, `a${index}`);
  }
  assert.deepEqual(h.customMessages.map(([message]) => message.content), pairs.flatMap(([user, assistant]) => [
    `[talk:user]\n${user}`, `[talk:assistant]\n${assistant}`,
  ]));
  assert.ok(h.customMessages.every(([, options]) => options?.triggerTurn === false));
  assert.equal(h.sent.length, 1, "ordinary conversation does not wake Pi");
  turns.start("user", "next_user");
  h.callbacks().onDelegation("next_task", 0, "Look at the transcript now", { userTurnId: "next_user" });
  h.advance(0);
  await h.fire("before_agent_start", { prompt: (h.sent[1] as [string])[0] });
  turns.final("user", "Look at the transcript now", "next_user");
  turns.start("assistant", "next_ack");
  turns.final("assistant", "Let me check that", "next_ack");
  assert.equal(h.customMessages.length, 4, "delegated user and acknowledgements remain excluded");
});

test("a quiet terminal reply revokes an in-flight voice reply, and the next conversation can recover", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const turns = nativeTurns(h.callbacks());
  turns.start("user", "u1");
  turns.final("user", "Let's chat", "u1");
  turns.start("assistant", "overlap");
  await h.fire("input", { text: "Typed request", source: "interactive" }, h.ctx);
  await h.fire("message_end", { message: { role: "user", content: [{ type: "text", text: "Typed request" }] } });
  await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Terminal result" }], stopReason: "stop" } });
  await h.fire("agent_settled");
  assert.ok(h.quiet.some(([, text]) => text.includes("Terminal result")));
  turns.final("assistant", "Mixed independent speech and terminal readback", "overlap");
  turns.start("assistant", "quiet_readback");
  turns.final("assistant", "Terminal result", "quiet_readback");
  assert.equal(h.customMessages.length, 1, "quiet replies also block uncertain readbacks");
  turns.start("user", "u2");
  turns.final("user", "How about something else?", "u2");
  turns.start("assistant", "a2");
  turns.final("assistant", "An independent conversation reply", "a2");
  assert.equal(h.customMessages.length, 3);
  assert.equal(h.customMessages.at(-1)![0].content, "[talk:assistant]\nAn independent conversation reply");
  assert.deepEqual(h.sent, []);
});

test("questionnaire speech and late finals stay out of history until an independent later call", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const oldCallbacks = h.callbacks();
  const turns = nativeTurns(oldCallbacks);
  turns.final("assistant", "Independent opening", "opening");
  const answer = requestVoiceQuestions(h.events, questions());
  const finishPrompt = (id: string) => {
    const text = h.spoken.at(-1)![1];
    turns.partial("assistant", text);
    turns.final("assistant", text, id);
  };
  finishPrompt("question_prompt");
  h.replyQuestion("Blue");
  turns.final("user", "Blue", "question_choice");
  finishPrompt("question_readback");
  h.replyQuestion("Yes");
  turns.final("user", "Yes", "question_confirmation");
  assert.equal((await answer)?.cancelled, false);
  turns.start("user", "after_question_user");
  turns.final("user", "A later unrelated thought", "after_question_user");
  turns.start("assistant", "after_question_assistant");
  turns.final("assistant", "A later unrelated answer", "after_question_assistant");
  assert.equal(h.customMessages.length, 1, "both speakers remain excluded after the first questionnaire");
  assert.deepEqual(h.sent, [], "tool replies must not create native Pi prompts");
  await h.command("status");
  assert.match(h.notices.at(-1)![0], /Voice context: 1 turn\(s\).*paused after a tool questionnaire/);
  const firstCall = (h.customMessages[0][0].details as { callId: string }).callId;
  await h.command("stop");
  const widgets = h.widgets.length;
  const updates = h.dashboard().length;
  turns.final("user", "Stopped late final", "late_user");
  oldCallbacks.onTurn?.("assistant", "Stopped late answer", { id: "late_assistant" });
  assert.equal(h.customMessages.length, 1);
  assert.equal(h.widgets.length, widgets);
  assert.equal(h.dashboard().length, updates);
  await h.command();
  turns.final("assistant", "Old call after restart", "old_call_final");
  nativeTurns(h.callbacks()).final("assistant", "New independent answer", "opening");
  assert.equal(h.customMessages.length, 2, "the new call resets questionnaire and presentation exclusions");
  assert.match(String(h.customMessages[1][0].content), /New independent answer/);
  const details = h.customMessages[1][0].details as { callId: string; turnId: string };
  assert.notEqual(details.callId, firstCall);
  assert.equal(details.turnId, "opening", "server IDs are scoped to each call");
  assert.deepEqual(h.customMessages[1][1], { triggerTurn: false });
  assert.deepEqual(h.sent, []);
});

test("dashboard elapsed refreshes while quiet and excludes credential and connection setup", async (t) => {
  const h = setup(t, "native");
  const auth = deferred<string>();
  const connection = deferred<LiveSession>();
  h.setAuthorize(() => auth.promise);
  h.setConnect(() => connection.promise);
  const starting = h.command();
  h.advance(15_000);
  assert.equal(h.intervalCallbacks.length, 0);
  auth.resolve(token);
  await flush();
  h.advance(20_000);
  h.callbacks().onProgress?.("Connecting voice…");
  assert.deepEqual(h.dashboard().at(-1), { state: "connecting", detail: "Connecting voice…" });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  assert.equal(h.intervalCallbacks.length, 0);
  connection.resolve(h.live);
  await starting;
  assert.deepEqual(h.dashboard().at(-1), { state: "listening", elapsedMs: 0 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  assert.equal(h.intervalCallbacks.length, 1);
  const updates = h.dashboard().length;
  h.advance(1000);
  assert.equal(h.dashboard().length, updates + 1);
  assert.deepEqual(h.dashboard().at(-1), { state: "listening", elapsedMs: 1000 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  h.advance(1000);
  assert.deepEqual(h.dashboard().at(-1), { state: "listening", elapsedMs: 2000 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
});

test("closing freezes elapsed immediately and clears refresh callbacks across sessions", async (t) => {
  const h = setup(t);
  await h.command();
  h.advance(3270);
  const oldCallbacks = h.callbacks();
  const oldTick = h.intervalCallbacks[0];
  const closing = deferred<CloseInfo>();
  h.live.close = () => closing.promise;
  const stopping = h.command("stop");
  assert.deepEqual(h.dashboard().at(-1), { state: "closing", elapsedMs: 3270 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  const ticks = h.intervalTicks();
  h.advance(5000);
  await h.command("status");
  assert.deepEqual(h.dashboard().at(-1), { state: "closing", elapsedMs: 3270 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  assert.equal(h.intervalTicks(), ticks);
  closing.resolve({ confirmed: true });
  await stopping;
  assert.deepEqual(h.dashboard().at(-1), { state: "idle" });
  await h.command();
  const widgets = h.widgets.length;
  const updates = h.dashboard().length;
  oldTick();
  oldCallbacks.onProgress?.("late progress");
  oldCallbacks.onTranscript("user", "late caption", 0, 1);
  oldCallbacks.onTurn?.("user", "late final", { id: "stale_turn" });
  oldCallbacks.onClosed({ confirmed: false });
  oldCallbacks.onError(new Error("late error"));
  assert.equal(h.widgets.length, widgets);
  assert.equal(h.dashboard().length, updates);
  h.advance(1000);
  assert.deepEqual(h.dashboard().at(-1), { state: "connecting", detail: "Waiting for microphone…", elapsedMs: 1000 });
  assert.deepEqual(h.widgets.at(-1), ["talk", []]);
  await h.command("stop");
  const stoppedWidgets = h.widgets.length;
  const stoppedUpdates = h.dashboard().length;
  const stoppedTicks = h.intervalTicks();
  assert.deepEqual(h.dashboard().at(-1), { state: "idle" });
  h.advance(5000);
  assert.equal(h.widgets.length, stoppedWidgets);
  assert.equal(h.dashboard().length, stoppedUpdates);
  assert.equal(h.intervalTicks(), stoppedTicks);
});

for (const cause of ["failure", "shutdown", "late setup"] as const) {
  test(`elapsed refresh is cleaned up on ${cause}`, async (t) => {
    const h = setup(t);
    const connection = deferred<LiveSession>();
    if (cause === "late setup") h.setConnect(() => connection.promise);
    const starting = h.command();
    await flush();
    if (cause === "failure") h.callbacks().onError(new Error("lost connection"));
    else await h.fire("session_shutdown");
    await flush();
    if (cause === "late setup") connection.resolve(h.live);
    await starting;
    const widgets = h.widgets.length;
    const updates = h.dashboard().length;
    const ticks = h.intervalTicks();
    assert.deepEqual(h.dashboard().at(-1), { state: "idle" });
    h.advance(20 * 60_000);
    await flush();
    assert.equal(h.widgets.length, widgets);
    assert.equal(h.dashboard().length, updates);
    assert.equal(h.intervalTicks(), ticks);
    assert.equal(h.intervalCallbacks.length, cause === "late setup" ? 0 : 1);
  });
}

function agent(status = "running", telemetry = {}) {
  return { states: [{ id: 1, label: "Reviewer", task: "Review tests", status, ...telemetry }] };
}
function todos(completed = false) {
  return { state: { nextId: 2, items: [{ id: 1, text: "Verify tests", completed }] } };
}
function questions(question = "Which color?") {
  return normalizeQuestions([{ id: "color", question, options: [{ label: "Blue" }, { label: "Green" }] }]);
}

test("startup awaits the compact summary before transport and recording, seeding only continuity and activity", async (t) => {
  const h = setup(t);
  const summary = deferred<string>();
  const raw = "RAW MAIN HISTORY must not reach voice";
  Object.assign(h.ctx.sessionManager, { getEntries: () => [{ type: "message", message: { role: "user", content: raw } }] });
  h.events.emit(SUBAGENTS_CHANGED_EVENT, agent());
  h.events.emit(TODOS_CHANGED_EVENT, todos());
  h.setSummarize(() => summary.promise);
  const starting = h.command();
  await flush();
  assert.equal(h.summaryCalls.length, 1);
  assert.equal(h.summaryCalls[0][0], h.ctx);
  assert.equal(h.summaryCalls[0][1].aborted, false);
  assert.equal(h.counts().opens, 0);
  assert.equal(h.counts().recorderStarts, 0);
  assert.equal(h.counts().playerStarts, 0);
  summary.resolve("Compact: tests are under review.");
  await starting;
  assert.equal(h.counts().opens, 1);
  assert.equal(h.counts().recorderStarts, 1);
  const seed = h.initialContexts[0]!;
  assert.match(seed, /Conversation summary:\nCompact: tests are under review\./);
  assert.match(seed, /Coding agent model: anthropic\/some-other-model/);
  assert.match(seed, /Coding agent is idle/);
  assert.match(seed, /Current activity:[\s\S]*Reviewer[\s\S]*Verify tests/);
  assert.ok(!seed.includes(raw));
  assert.deepEqual(quietActivity(h), [], "pre-start activity is seeded, not replayed; Stop capability is separate");
  assert.deepEqual(h.sent, []);
});

for (const failure of [false, true]) {
  test(`summary ${failure ? "failure warns" : "unavailable fallback"} continues without a real provider`, async (t) => {
    const h = setup(t);
    h.setSummarize(async () => {
      if (failure) throw new Error("summary failed");
      return undefined;
    });
    await h.command();
    assert.equal(h.summaryCalls.length, 1);
    assert.equal(h.counts().opens, 1);
    assert.match(h.initialContexts[0]!, /No conversation summary is available/);
    assert.equal(h.notices.filter(([, level]) => level === "warning").length, failure ? 1 : 0);
    if (failure) assert.match(h.notices.find(([, level]) => level === "warning")![0], /without a conversation summary/);
    assert.deepEqual(h.providers, ["openai-codex"]);
    assert.deepEqual(h.sent, []);
  });
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`stop aborts a pending summary and suppresses late ${outcome}`, async (t) => {
    const h = setup(t);
    const summary = deferred<string>();
    h.setSummarize(() => summary.promise);
    const starting = h.command();
    await flush();
    const signal = h.summaryCalls[0][1];
    await h.command("stop");
    assert.equal(signal.aborted, true);
    const widgets = h.widgets.length;
    if (outcome === "resolve") summary.resolve("late summary");
    else summary.reject(new Error("late failure"));
    await starting;
    await flush();
    assert.deepEqual(h.initialContexts, []);
    assert.equal(h.counts().opens, 0);
    assert.equal(h.counts().recorderStarts, 0);
    assert.equal(h.widgets.length, widgets);
    assert.deepEqual(h.notices, []);
  });
}

test("activity updates are quiet, bounded, debounced and ignore repeated states and telemetry streams", async (t) => {
  const h = setup(t, "native");
  h.events.emit(SUBAGENTS_CHANGED_EVENT, agent());
  h.events.emit(TODOS_CHANGED_EVENT, todos());
  await h.command();
  const baseline = h.quiet.length;
  for (let i = 0; i < 3; i++) {
    h.events.emit(SUBAGENTS_CHANGED_EVENT, agent("running", { tokens: i, activity: `token ${i}`, result: `partial ${i}` }));
    h.events.emit(TODOS_CHANGED_EVENT, todos());
    await h.fire("message_update", { message: { role: "assistant", content: `partial ${i}` } });
    await h.fire("tool_execution_update", { partialResult: `stream ${i}` });
  }
  h.advance(150);
  assert.equal(h.quiet.length, baseline);
  h.events.emit(SUBAGENTS_CHANGED_EVENT, agent("completed"));
  h.events.emit(TODOS_CHANGED_EVENT, todos(true));
  h.events.emit(TODOS_CHANGED_EVENT, { state: { nextId: 3, items: [{ id: 2, text: "🧪".repeat(500), completed: false }] } });
  h.advance(149);
  assert.equal(h.quiet.length, baseline);
  h.advance(1);
  assert.equal(h.quiet.length, baseline + 4);
  assert.match(h.quiet.map(([, text]) => text).join("\n"), /Todo #1 removed/);
  assert.match(h.quiet[baseline][1], /Reviewer.*completed/);
  assert.match(h.quiet[baseline + 1][1], /Todo #1 completed/);
  for (const [id, text] of h.quiet) {
    assert.equal(id, null);
    assert.ok(Buffer.byteLength(text) <= 450);
  }
  h.events.emit(SUBAGENTS_CHANGED_EVENT, agent("completed", { result: "late result", tokens: 999 }));
  h.advance(150);
  assert.equal(h.quiet.length, baseline + 4);
  assert.deepEqual(h.spoken, []);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.appended, []);
  assert.deepEqual(h.played, []);
  assert.equal(h.counts().recorderStarts, 0);
});

test("activity during transport startup flushes exactly once after ready", async (t) => {
  const h = setup(t, "native");
  const connection = deferred<LiveSession>();
  h.setConnect(() => connection.promise);
  const starting = h.command();
  await flush();
  h.events.emit(SUBAGENTS_CHANGED_EVENT, agent());
  h.events.emit(TODOS_CHANGED_EVENT, todos());
  h.advance(300);
  assert.deepEqual(h.quiet, []);
  connection.resolve(h.live);
  await starting;
  assert.equal(quietActivity(h).length, 2);
  assert.match(quietActivity(h)[0][1], /Reviewer.*started/);
  assert.match(quietActivity(h)[1][1], /Todo #1 added/);
  h.advance(300);
  assert.equal(quietActivity(h).length, 2);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.spoken, []);
});

test("stop cancels the 150ms activity timer without leaking updates into the next call", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.events.emit(SUBAGENTS_CHANGED_EVENT, agent());
  h.advance(149);
  await h.command("stop");
  await h.command();
  h.advance(1000);
  assert.deepEqual(quietActivity(h), []);
  assert.match(h.initialContexts[1]!, /Reviewer/);
  assert.deepEqual(h.sent, []);
});

test("live ask_user correlates plain replies with raw speech and separately confirms structured answers", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const qs = questions();
  let settled = false;
  const answer = requestVoiceQuestions(h.events, qs).then((result) => { settled = true; return result; });
  assert.match(h.spoken.at(-1)![1], /Which color\?[\s\S]*1\. Blue[\s\S]*2\. Green/);
  assert.equal(h.widgets.at(-1)![0], "talk-question");
  assert.match(h.widgets.at(-1)![1]!.join("\n"), /Question 1\/1: Which color\?/);
  const prompts = h.spoken.length;
  h.finishSpoken();
  const firstControl = h.latestControl();
  h.callbacks().onTurn?.("user", "Blue");
  h.callbacks().onTurn?.("assistant", "Blue");
  h.callbacks().onDelegation("no_raw_speech", 0, JSON.stringify({ talk_answer: firstControl.token }));
  assert.match(h.widgets.at(-1)![1]!.join("\n"), /Question answer: listening/);
  h.callbacks().onTranscript("user", "Blue", 0, 10);
  assert.match(h.widgets.at(-1)![1]!.join("\n"), /Question answer: heard reply; waiting for voice handoff/);
  h.callbacks().onDelegation("not-a-task", 10, "Ask a new question");
  h.advance(400);
  await flush();
  assert.equal(h.spoken.length, prompts);
  assert.equal(settled, false);
  assert.deepEqual(h.sent, []);
  h.callbacks().onDelegation("forged_choice", 10, "Green");
  assert.equal(h.spoken.length, prompts, "model answer text must not override raw speech");
  h.callbacks().onDelegation("first_choice", 10, "Blue");
  assert.match(h.spoken.at(-1)![1], /You chose: Blue.*Yes to confirm/);
  assert.equal(h.spoken.at(-1)![0], "first_choice", "readback answers the committing delegation");
  assert.notEqual(h.latestControl().token, firstControl.token);
  h.callbacks().onDelegation("answer-not-task", 15, "Blue");
  h.advance(400);
  assert.deepEqual(h.sent, []);
  h.callbacks().onTurn?.("assistant", "ja");
  await flush();
  assert.equal(settled, false, "assistant confirmation cannot answer");
  h.finishSpoken();
  h.replyQuestion("ja");
  assert.deepEqual(await answer, { questions: qs, cancelled: false, answers: [{
    id: "color", question: "Which color?", skipped: false, answers: [{ label: "Blue", custom: false }],
  }] });
  assert.deepEqual(h.widgets.filter(([key]) => key === "talk-question").at(-1), ["talk-question", undefined]);
  h.callbacks().onDelegation("late-answer", 20, "Blue");
  h.advance(400);
  assert.deepEqual(h.sent, []);

  h.callbacks().onTranscript("user", "Inspect the project", 30, 40);
  h.callbacks().onDelegation("real-task", 40, "Inspect the project");
  h.advance(400);
  assert.equal(h.sent.length, 1, "fresh matching project speech needs no extra Yes prompt");
  assert.ok(h.spoken.every(([, text]) => !text.includes("Start this new task?")));
  assert.match((h.sent[0] as [string])[0], /Inspect the project/);
});

test("real wire fractional timestamps accept only an ASR-matched task after a questionnaire", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const answer = requestVoiceQuestions(h.events, questions());
  h.finishSpoken();
  h.replyQuestion("Blue");
  h.finishSpoken();
  h.replyQuestion("Ja");
  await answer;
  const prompts = h.spoken.length;
  const wire = createCodexWire(h.callbacks());
  t.mock.method(performance, "now", () => 237.5625);
  wire.receive({ type: "input_transcript.added", item: { id: "hello_speech", text: "Say hello to the coding agent" } });
  const task = "Acknowledge the user.\nDo not modify files.";
  wire.receive({ type: "delegation.created", item: {
    id: "unmatched_fractional_clock", type: "delegation", target: "client",
    content: [{ type: "input_text", text: task }],
  } });
  h.advance(0);
  assert.deepEqual(h.sent, [], "a paraphrase is not a fresh matching request");
  assert.match(h.quiet.at(-1)![1], /did not match a fresh new spoken task/);
  wire.receive({ type: "input_transcript.added", item: { id: "task_speech", text: `\n${task}` } });
  wire.receive({ type: "delegation.created", item: {
    id: "real_fractional_clock", type: "delegation", target: "client",
    content: [{ type: "input_text", text: task }],
  } });
  assert.deepEqual(h.sent, [], "accepted handoffs wait for the bridge's next tick");
  assert.equal(h.spoken.length, prompts, "matching speech needs no extra task confirmation");
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0] as [string])[0], "[talk:user]\nAcknowledge the user.\nDo not modify files.");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "real_fractional_clock" }]]);
  assert.equal(h.notices.some(([, level]) => level === "error"), false);
});

test("missing user turn.done: screenshot One commits through the real wire and new tasks need fresh matching ASR", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const wire = createCodexWire(h.callbacks());
  let count = 0;
  const id = (prefix: string) => `${prefix}_${++count}`;
  const partial = (text: string) => wire.receive({ type: "input_transcript.added", item: { id: id("user"), text } });
  const delegate = (input: string, replyId = id("delegate")) => {
    wire.receive({ type: "delegation.created", item: { id: replyId, type: "delegation", target: "client",
      content: [{ type: "input_text", text: input }] } });
    return replyId;
  };
  const finish = () => {
    const itemId = id("assistant");
    const text = h.spoken.at(-1)![1];
    wire.receive({ type: "output_transcript.added", item: { id: itemId, text } });
    wire.receive({ type: "turn.done", item_id: itemId, turn: { id: id("turn"), role: "assistant", transcript: text } });
  };
  partial("Let's try the questionnaire");
  let resolved = false;
  const pending = requestVoiceQuestions(h.events, normalizeQuestions([{
    id: "handoff", question: "Which handoff?", options: [{ label: "Quiet handoffs" }, { label: "Verbose handoffs" }],
  }]));
  void pending.then(() => { resolved = true; });
  await h.command("status");
  assert.match(h.notices.at(-1)![0], /Question answer: listening/);
  finish();
  const first = JSON.stringify({ talk_answer: h.latestControl().token });
  partial("One"); // Screenshot: no USER turn.done ever arrives.
  assert.match(h.widgets.at(-1)![1]!.join("\n"), /Question answer: heard reply; waiting for voice handoff/);
  await flush();
  assert.equal(resolved, false);
  const choiceId = delegate(first);
  assert.match(h.spoken.at(-1)![1], /You chose: Quiet handoffs/);
  assert.equal(h.spoken.at(-1)![0], choiceId);
  const confirm = JSON.stringify({ talk_answer: h.latestControl().token });
  assert.notEqual(confirm, first);
  delegate(first, choiceId); // Same wire ID, then same stale nonce under a new ID.
  delegate(first);
  partial("Yes please");
  delegate(confirm); // Premature Yes cannot confirm before readback finishes.
  finish();
  delegate(confirm); // Finishing the readback discarded premature speech.
  // A delayed user final contributes a display-only suffix, not new consent.
  wire.receive({ type: "turn.done", turn: { id: id("late_user"), role: "user", transcript: "Let's try the questionnaireOneYes please Yes" } });
  delegate(confirm);
  await flush();
  assert.equal(resolved, false);
  partial("Yes please");
  const confirmId = delegate(confirm);
  const result = await pending;
  assert.equal(result?.cancelled, false);
  assert.deepEqual(result?.answers[0].answers, [{ label: "Quiet handoffs", custom: false }]);
  assert.ok(h.quiet.some(([replyId, text]) => replyId === confirmId && /recorded locally/.test(text)), "finish-only commit has a correlated quiet acknowledgement");
  delegate(confirm, confirmId);
  delegate(first);
  delegate(confirm);
  delegate("Choose Blue");
  h.advance(400);
  assert.deepEqual(h.sent, []);

  const prompts = h.spoken.length;
  const retiredTask = JSON.stringify({ talk_task_answer: "expired" });
  delegate(retiredTask); // Metadata alone supplies no fresh speech.
  wire.receive({ type: "turn.done", turn: { id: id("final_only_task"), role: "user", transcript: "Delete the old files" } });
  delegate("Delete the old files");
  h.advance(400);
  assert.deepEqual(h.sent, [], "a final-only caption cannot authorize a new task");

  partial("Hello, say hello to the coding agent");
  delegate(first); // Protocol replies stay local even with no question pending.
  delegate(retiredTask);
  wire.receive({ type: "turn.done", turn: { id: id("late_task_user"), role: "user", transcript: "Hello, say hello to the coding agent Yes" } });
  delegate("Delete the old files");
  h.advance(0);
  assert.deepEqual(h.sent, [], "a late final cannot authorize an unrelated task");
  const taskReplyId = delegate("Say hello to the coding agent");
  delegate("Say hello to the coding agent", taskReplyId);
  delegate("Say hello to the coding agent"); // Fresh ID cannot reuse consumed ASR.
  assert.deepEqual(h.sent, []);
  assert.equal(h.spoken.length, prompts, "there is no mandatory new-task readback");
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0] as [string])[0], "[talk:user]\nSay hello to the coding agent");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: taskReplyId }]]);
  assert.equal(h.notices.some(([, level]) => level === "error"), false);
  for (const [replyId, text] of h.spoken) wire.context(replyId, text, true);
  for (const [replyId, text] of h.quiet) wire.context(replyId, text, false);
});

test("current readback must finish after the old assistant prompt; premature Yes and late user finals cannot confirm", async (t) => {
  const h = setup(t, "native");
  await h.command();
  let settled = false;
  const pending = requestVoiceQuestions(h.events, questions()).then((result) => { settled = true; return result; });
  const initialPrompt = h.spoken.at(-1)![1];
  h.callbacks().onTranscript("assistant", initialPrompt, 0, 10);
  // First-phase choice does not require the initial prompt to have finished.
  h.replyQuestion("One");
  const readback = h.spoken.at(-1)![1];
  const reply = JSON.stringify({ talk_answer: h.latestControl().token });
  h.replyQuestion("Yes");
  h.callbacks().onTurn?.("assistant", initialPrompt);
  h.callbacks().onDelegation("old_prompt_done", 20, reply);
  h.callbacks().onTurn?.("user", "One Quiet Handoffs Hello");
  h.callbacks().onDelegation("late_choice_final", 20, reply);
  await flush();
  assert.equal(settled, false, "the old assistant final is not the current readback");
  h.callbacks().onTranscript("assistant", readback, 20, 30);
  h.callbacks().onTranscript("user", "Yes", 20, 30);
  h.callbacks().onTurn?.("assistant", readback);
  h.callbacks().onDelegation("same_utterance_yes", 30, reply);
  h.callbacks().onTurn?.("user", "Yes");
  h.callbacks().onDelegation("late_yes_final", 30, reply);
  await flush();
  assert.equal(settled, false, "finishing the readback discards all premature Yes speech");
  assert.match(h.widgets.at(-1)![1]!.join("\n"), /Question confirm: listening/);
  h.replyQuestion("Yes please");
  assert.equal((await pending)?.cancelled, false);
  assert.deepEqual(h.sent, []);
});

test("stale and forged protocol replies cannot reset per-user-turn bookkeeping or become tasks", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const pending = requestVoiceQuestions(h.events, questions());
  const old = h.latestControl();
  h.finishSpoken();
  h.replyQuestion("One");
  h.finishSpoken();
  h.replyQuestion("Yes");
  await pending;
  h.callbacks().onTranscript("user", "Uh alright do it", 0, 10);
  h.callbacks().onDelegation("vague_first", 10, "Uh alright do it");
  const prompts = h.spoken.length;
  for (const [id, input] of [
    ["stale_question", JSON.stringify({ talk_answer: old.token })],
    ["forged_question", JSON.stringify({ talk_answer: "forged", answer: "Yes" })],
    ["stale_task", JSON.stringify({ talk_task_answer: "expired" })],
  ]) h.callbacks().onDelegation(id, 10, input);
  h.callbacks().onDelegation("vague_again", 10, "Okay do it");
  assert.equal(h.spoken.length, prompts, "ignored metadata must not reopen clarification in the same turn");
  assert.equal(h.widgets.filter(([key]) => key === "talk-question").at(-1)?.[1], undefined);
  h.advance(400);
  assert.deepEqual(h.sent, []);
  h.callbacks().onDelegation("concrete_after_invalid", 10, "Inspect the project's tests");
  assert.match(h.quiet.at(-1)![1], /did not match a fresh new spoken task/);
  h.callbacks().onDelegation("no_new_speech", 10, JSON.stringify({ talk_task_answer: "forged", answer: "Yes" }));
  h.callbacks().onTranscript("assistant", "Inspect the project's tests", 10, 20);
  h.callbacks().onDelegation("assistant_is_not_consent", 20, "Inspect the project's tests");
  h.advance(0);
  assert.deepEqual(h.sent, [], "neither metadata nor assistant speech authorizes project work");
  assert.equal(h.spoken.length, prompts);
  h.callbacks().onTranscript("user", "\nInspect the project's tests", 20, 30);
  h.callbacks().onDelegation("fresh_matching_task", 30, "Inspect the project's tests");
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0] as [string])[0], "[talk:user]\nInspect the project's tests");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "fresh_matching_task" }]]);
});

test("a question opened during a preceding user turn ignores that old final", async (t) => {
  const h = setup(t, "native");
  await h.command();
  h.callbacks().onTranscript("user", "Previous request", 0, 10);
  const answer = requestVoiceQuestions(h.events, questions());
  const prompts = h.spoken.length;
  h.callbacks().onTurn?.("user", "Previous request");
  assert.equal(h.spoken.length, prompts);

  h.finishSpoken();
  h.replyQuestion("Green");
  assert.match(h.spoken.at(-1)![1], /You chose: Green/);
  h.finishSpoken();
  h.replyQuestion("ja");
  assert.deepEqual((await answer)?.answers[0].answers, [{ label: "Green", custom: false }]);
  assert.deepEqual(h.sent, []);
});

test("late answer delegations stay non-executable even after a fresh user turn", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const result = requestVoiceQuestions(h.events, questions());
  h.finishSpoken();
  h.replyQuestion("Blue");
  h.callbacks().onDelegation("blocked-answer", 10, "Choose Blue");
  h.finishSpoken();
  h.replyQuestion("Yes");
  await result;

  h.callbacks().onTranscript("user", "Another question", 20, 30);
  h.callbacks().onDelegation("blocked-answer", 10, "Choose Blue");
  assert.equal(h.widgets.filter(([key]) => key === "talk-question").at(-1)?.[1], undefined);
  h.callbacks().onDelegation("delayed-new-id", 10, "Choose Blue");
  h.advance(1000);
  assert.deepEqual(h.sent, [], "a stale delegation cannot execute just because another turn began");
  assert.match(h.quiet.at(-1)![1], /did not match a fresh new spoken task/);
  assert.ok(h.spoken.every(([, text]) => !text.includes("Start this new task")));
  h.callbacks().onTranscript("user", "\nBlue", 40, 50);
  h.callbacks().onDelegation("fresh_choice_is_not_a_task", 50, "Blue");
  h.advance(0);
  assert.deepEqual(h.sent, [], "even fresh ASR matching an option label cannot become project work");
  h.callbacks().onTranscript("user", "\nInspect the project's tests", 60, 70);
  h.callbacks().onDelegation("fresh_project_task", 70, "Inspect the project's tests");
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0] as [string])[0], "[talk:user]\nInspect the project's tests");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "fresh_project_task" }]]);
  h.callbacks().onDelegation("blocked-answer", 10, "Choose Blue");
  h.callbacks().onDelegation("another_late_answer", 10, "Choose Blue");
  h.advance(400);
  assert.equal(h.sent.length, 1);
});

test("aborting a questionnaire mid-answer cannot turn that answer into an action", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const controller = new AbortController();
  const result = requestVoiceQuestions(h.events, questions(), controller.signal);
  h.callbacks().onTranscript("user", "Blue", 0, 10);
  controller.abort();
  assert.equal((await result)?.cancelled, true);
  h.callbacks().onDelegation("after-abort", 10, "Choose Blue");
  h.callbacks().onTurn?.("user", "Blue");
  h.advance(400);
  assert.deepEqual(h.sent, []);
  h.callbacks().onDelegation("retired_task_reply", 10, JSON.stringify({ talk_task_answer: "expired" }));
  h.callbacks().onTranscript("user", "\nBlue", 20, 30);
  h.callbacks().onDelegation("fresh_aborted_choice", 30, "Blue");
  h.advance(0);
  assert.deepEqual(h.sent, [], "aborted questionnaire choices remain non-executable");
  await h.command("stop");
  h.advance(120_000);
  assert.deepEqual(h.sent, []);
});

for (const cause of ["disconnect", "keyboard", "oversized question", "abort"] as const) {
  test(`live ask_user ${cause} ${cause === "abort" ? "returns cancellation" : "falls back to GUI"}`, async (t) => {
    const h = setup(t, "native");
    await h.command();
    const controller = new AbortController();
    const qs = questions(cause === "oversized question" ? "x".repeat(451) : undefined);
    const answer = requestVoiceQuestions(h.events, qs, controller.signal);
    if (cause === "disconnect") h.finish({ confirmed: false });
    if (cause === "keyboard") { h.finishSpoken(); h.replyQuestion("keyboard"); }
    if (cause === "abort") controller.abort();
    const result = await answer;
    if (cause === "abort") assert.deepEqual(result, { questions: qs, answers: [], cancelled: true });
    else assert.equal(result, undefined);
    await flush();
    assert.deepEqual(h.sent, []);
    if (cause === "oversized question") {
      assert.match(h.spoken.at(-1)![1], /answer this questionnaire in Pi's terminal/);
      assert.equal(h.widgets.some(([key]) => key === "talk-question"), false);
    } else assert.deepEqual(h.widgets.filter(([key]) => key === "talk-question").at(-1), ["talk-question", undefined]);
  });
}

test("screenshot topic change returns the actual long request through ask_user, never a new Pi message", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const qs = questions("Which screenshot should we review?");
  const answer = requestVoiceQuestions(h.events, qs);
  h.finishSpoken();
  h.replyQuestion("One");
  assert.match(h.spoken.at(-1)![1], /You chose: Blue\./);
  assert.doesNotMatch(h.spoken.at(-1)![1], /You chose: One/i);
  const actual = "Yes I just sent an image. I'm not happy with the layout in this screenshot. " +
    "The navigation overlaps the heading, the buttons are too close together, and the image preview is cropped. " +
    "Please inspect the screenshot and explain what should change before editing anything. " +
    "I want the spacing and hierarchy reviewed against the current project, not approval of the color choice.";
  assert.ok(actual.length > 320);
  h.finishSpoken();
  h.replyQuestion(actual);
  const result = await answer;
  assert.deepEqual(result, { questions: qs, cancelled: true, userRequest: actual, answers: [{
    id: "color", question: qs[0].question, skipped: false, answers: [],
  }] });
  assert.deepEqual(h.widgets.filter(([key]) => key === "talk-question").at(-1), ["talk-question", undefined]);
  assert.match(h.quiet.at(-1)![1], /questionnaire ended.*returned directly in the ask_user tool result/i);
  assert.match(h.quiet.at(-1)![1], /Do not delegate it again/);
  assert.deepEqual(h.sent, []);
  h.callbacks().onDelegation("late-screenshot-answer", 10, actual);
  h.advance(400);
  assert.deepEqual(h.sent, []);

  h.callbacks().onTranscript("user", "Inspect the project's screenshot rendering tests", 20, 30);
  h.callbacks().onDelegation("fresh-screenshot-task", 30, "Inspect the project's screenshot rendering tests");
  assert.ok(h.spoken.every(([, text]) => !text.includes("Start this new task")));
  assert.deepEqual(h.sent, [], "fresh matching speech still waits for the bridge's next tick");
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0] as [string])[0], "[talk:user]\nInspect the project's screenshot rendering tests");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "fresh-screenshot-task" }]]);
  assert.doesNotMatch((h.sent[0] as [string])[0], /I'm not happy|One|New voice context|You:|Voice:/);
  h.callbacks().onDelegation("late-screenshot-answer", 10, actual);
  h.advance(400);
  assert.equal(h.sent.length, 1);
});

test("a new topic before any candidate is a tool-result request, not a free-text answer", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const qs = questions();
  const answer = requestVoiceQuestions(h.events, qs);
  const actual = "Tell Pi to inspect image";
  const prompts = h.spoken.length;
  h.finishSpoken();
  h.replyQuestion(actual);
  assert.deepEqual(await answer, { questions: qs, cancelled: true, userRequest: actual, answers: [{
    id: "color", question: "Which color?", skipped: false, answers: [],
  }] });
  assert.equal(h.spoken.length, prompts, "a topic change must not get a free-text readback");
  assert.deepEqual(h.widgets.filter(([key]) => key === "talk-question").at(-1), ["talk-question", undefined]);
  assert.match(h.quiet.at(-1)![1], /questionnaire ended.*ask_user tool result/i);
  h.callbacks().onDelegation("topic-is-not-a-task", 10, actual);
  h.advance(400);
  assert.deepEqual(h.sent, []);
});

test("after a questionnaire, a topic change cannot authorize a mismatched replacement task", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const answer = requestVoiceQuestions(h.events, questions());
  h.finishSpoken();
  h.replyQuestion("One");
  h.finishSpoken();
  h.replyQuestion("Yes please");
  assert.equal((await answer)?.cancelled, false);
  const prompts = h.spoken.length;
  h.callbacks().onTranscript("user", "No, look at the image instead", 0, 10);
  h.callbacks().onDelegation("old-topic", 10, "Run the project's tests");
  h.callbacks().onDelegation("replacement-paraphrase", 10, "Inspect the project's image rendering code");
  h.callbacks().onTurn?.("assistant", "Yes please");
  h.callbacks().onTranscript("assistant", "Inspect the project's image rendering code", 10, 20);
  h.callbacks().onDelegation("assistant-replacement", 20, "Inspect the project's image rendering code");
  h.advance(400);
  assert.deepEqual(h.sent, [], "neither a topic change nor assistant speech authorizes a paraphrased task");
  assert.equal(h.spoken.length, prompts);
  assert.deepEqual(h.widgets.filter(([key]) => key === "talk-question").at(-1), ["talk-question", undefined]);

  h.callbacks().onTranscript("user", "\nInspect the project's image rendering code", 20, 30);
  h.callbacks().onDelegation("fresh-replacement", 30, "Inspect the project's image rendering code");
  assert.deepEqual(h.sent, []);
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0] as [string])[0], "[talk:user]\nInspect the project's image rendering code");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "fresh-replacement" }]]);
  assert.doesNotMatch((h.sent[0] as [string])[0], /Run the project's tests|No, look at/);
  h.callbacks().onDelegation("old-topic", 10, "Run the project's tests");
  h.callbacks().onDelegation("old-topic-new-id", 10, "Run the project's tests");
  h.advance(400);
  assert.equal(h.sent.length, 1, "rejected handoffs cannot be revived without matching new speech");
});

test("after a questionnaire, Yes and late finals cannot authorize an unheard task or added instructions", async (t) => {
  const h = setup(t, "native");
  await h.command();
  const questionnaire = requestVoiceQuestions(h.events, questions());
  h.finishSpoken();
  h.replyQuestion("Blue");
  h.finishSpoken();
  h.replyQuestion("Yes");
  await questionnaire;
  const prompts = h.spoken.length;
  h.callbacks().onTranscript("user", "Yes", 10, 20);
  h.callbacks().onDelegation("late-task", 20, "Delete the old files");
  h.callbacks().onTurn?.("user", "Yes");
  h.callbacks().onDelegation("no_fresh_task_speech", 20, JSON.stringify({ talk_task_answer: "expired" }));
  h.callbacks().onTranscript("user", "Inspect the files without changing them", 20, 30, "final");
  h.callbacks().onTurn?.("user", "Inspect the files without changing them");
  h.callbacks().onDelegation("final_only_task", 30, "Inspect the files without changing them");
  h.advance(0);
  assert.deepEqual(h.sent, [], "Yes, metadata, and final-only captions cannot supply a task");

  h.callbacks().onTranscript("user", "\nInspect the files", 50, 60);
  h.callbacks().onDelegation("unheard_extra_instructions", 60, "Inspect the files without changing them");
  h.callbacks().onTurn?.("user", "Inspect the files without changing them");
  h.callbacks().onDelegation("late_corrected_final", 60, "Inspect the files without changing them");
  h.advance(0);
  assert.deepEqual(h.sent, [], "even a safe-sounding addition must be present in ASR, not just the final");
  assert.equal(h.spoken.length, prompts);

  h.callbacks().onDelegation("matching_task", 60, "Inspect the files");
  h.advance(0);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0] as [string])[0], "[talk:user]\nInspect the files");
  assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "matching_task" }]]);
  assert.doesNotMatch((h.sent[0] as [string])[0], /Delete|without changing them/);
});

for (const afterQuestionnaire of [false, true]) {
  test(`vague delegation clarifies once until a matched handoff ${afterQuestionnaire ? "after" : "before"} a questionnaire`, async (t) => {
    const h = setup(t, "native");
    await h.command();
    if (afterQuestionnaire) {
      const answer = requestVoiceQuestions(h.events, questions());
      h.finishSpoken();
      h.replyQuestion("Blue");
      h.finishSpoken();
      h.replyQuestion("Yes");
      await answer;
    }
    h.callbacks().onTranscript("user", "Uh alright do it", 0, 10);
    h.callbacks().onTurn?.("user", "Uh alright do it");
    const prompts = h.spoken.length;
    for (const [id, input] of [["vague-1", "Uh alright do it"], ["vague-2", "Okay do it"], ["vague-3", "Uh alright do it"]]) {
      h.callbacks().onDelegation(id, 10, input);
      h.advance(400);
    }
    assert.deepEqual(h.sent, []);
    assert.equal(h.spoken.length, prompts + 1);
    assert.match(h.spoken.at(-1)![1], /What exactly would you like me to do\?.*nothing was started/s);
    assert.doesNotMatch(h.spoken.at(-1)![1], /Start this new task/);
    assert.equal(h.widgets.filter(([key]) => key === "talk-question").at(-1)?.[1], undefined);

    h.callbacks().onTranscript("user", "\nOkay do it", 20, 30);
    h.callbacks().onTurn?.("user", "Okay do it");
    h.callbacks().onDelegation("vague-next-turn", 30, "Okay do it");
    assert.equal(h.spoken.length, prompts + 1, "user finals do not reset clarification or create a fresh handoff boundary");
    const input = "Run a live ask_user voice questionnaire test";

    h.callbacks().onTranscript("user", `\n${input}`, 40, 50);
    h.callbacks().onTurn?.("user", input);
    h.callbacks().onDelegation("concrete-questionnaire-test", 50, input);
    assert.equal(h.spoken.length, prompts + 1, "a concrete ASR-matched handoff needs no new-task confirmation");
    assert.deepEqual(h.sent, []);
    h.advance(400);
    assert.equal(h.sent.length, 1);
    const [prompt, options] = h.sent[0] as [string, unknown];
    assert.equal(prompt, `[talk:user]\n${input}`, "the full concrete input is preserved");
    assert.deepEqual(h.entries, [["talk-delegation", { version: 1, delegationId: "concrete-questionnaire-test" }]]);
    assert.doesNotMatch(prompt, /Uh alright|Okay do it|New voice context|You:|Voice:|conversation|transcript/i);
    assert.deepEqual(options, { deliverAs: "followUp", expandPromptTemplates: false });

    await h.fire("before_agent_start", { prompt });
    await h.fire("agent_settled");
    const settledPrompts = h.spoken.length;
    h.spokenRequest("Okay do it");
    h.advance(400);
    assert.equal(h.sent.length, 1, "a fresh vague request still cannot execute");
    assert.equal(h.spoken.length, settledPrompts + 1, "a consumed handoff permits a new clarification");
    assert.match(h.spoken.at(-1)![1], /What exactly would you like me to do\?.*nothing was started/s);
  });
}

for (const known of [true, false]) {
  test(`summary failure exposes only ${known ? "the safe timeout reason" : "an unknown-error fallback"} in warning and status`, async (t) => {
    const h = setup(t, "native");
    const error = known ? new TalkSummaryError("timeout") : new Error("Bearer secret");
    error.message = "Bearer secret injected credentials";
    error.stack = "Bearer secret injected stack";
    h.setSummarize(async () => { throw error; });
    await h.command();
    assert.equal(h.counts().opens, 1);
    assert.match(h.initialContexts[0]!, /No conversation summary is available/);
    const warnings = h.notices.filter(([, level]) => level === "warning");
    assert.equal(warnings.length, 1);
    const reason = known
      ? "Conversation summary timed out after 15 seconds (openai-codex/gpt-6-luna)."
      : "unknown summary error";
    assert.ok(warnings[0][0].includes(reason));
    await h.command("status");
    assert.match(h.notices.at(-1)![0], /^Talk: active\n/);
    assert.ok(h.notices.at(-1)![0].includes(`Summary: unavailable — ${reason}`));
    assert.match(h.notices.at(-1)![0], /Voice context: 0 turn\(s\) submitted to Pi/);
    assert.equal(h.notices.at(-1)![1], "info");
    assert.doesNotMatch(JSON.stringify([h.notices, h.statuses, h.dashboard(), h.widgets, h.initialContexts, h.spoken, h.quiet, h.entries, h.sent, h.customMessages]), /Bearer|secret|injected/);
    assert.deepEqual(h.sent, []);
  });
}

test("unconfirmed graceful close reports usage and a warning without duplicate cleanup", async (t) => {
  const h = setup(t);
  h.setCloseInfo({ confirmed: false });
  await h.command();
  await h.command("stop");
  assert.deepEqual(h.entries, [["talk-usage", { confirmed: false }]]);
  assert.deepEqual(h.notices.at(-1), ["Talk stopped; final voice usage could not be confirmed.", "warning"]);
  assert.equal(h.counts().closeCalls, 1);
});
