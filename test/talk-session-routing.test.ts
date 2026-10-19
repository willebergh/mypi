import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTalk } from "../extensions/talk/index.ts";
import type { FaceTimeModeOptions, FaceTimeVoiceHandle } from "../extensions/talk/facetime-mode.ts";
import type { LiveCallbacks } from "../extensions/talk/live.ts";
import { MANAGED_VIRTUAL_AUDIO } from "../extensions/talk/virtual-audio.ts";
import { TALK_CHANGED_EVENT } from "../extensions/resource-status/protocol.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail("condition not reached"); }
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "tvr-"));
  const socket = join(dir, "private", "hub.sock");
  const instances: Array<{ fire(event: string, value?: any): Promise<void> }> = [];
  function instance(name: string) {
    const hooks = new Map<string, Function[]>(), listeners = new Map<string, Function[]>();
    const tools = new Map<string, any>();
    let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
    let names: string[] = [];
    let options!: FaceTimeModeOptions;
    let handle: FaceTimeVoiceHandle | undefined;
    let enabled = false, webcam = false, hangups = 0, aborts = 0, projections = 0;
    let connected = false, callId = 0, failedStarts = 0, failedClose = false;
    let beforeStart: (() => Promise<void>) | undefined;
    let sessionName = name;
    const gates: string[] = [], notices: string[] = [], sent: string[] = [], quiet: string[] = [], spoken: string[] = [];
    const opened: { callbacks: LiveCallbacks; context?: string; headers: Record<string, string>; closed: boolean }[] = [];
    const branch: any[] = [];
    const source = new AbortController();
    const emit = (event: string, value: any) => { for (const hook of hooks.get(event) ?? []) hook(value, ctx); };
    const fire = async (event: string, value: any = {}) => { for (const hook of hooks.get(event) ?? []) await hook(value, ctx); };
    const ctx = {
      mode: "tui", hasUI: true, cwd: `/projects/${name}`, isIdle: () => false, hasPendingMessages: () => false,
      abort() { aborts++; }, signal: new AbortController().signal,
      sessionManager: { getSessionId: () => `${name}-id`, getSessionName: () => sessionName, getBranch: () => branch },
      modelRegistry: { getApiKeyForProvider: async () => "test-token" },
      ui: { notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {} },
    } as unknown as ExtensionContext;
    const pi = {
      on(event: string, fn: Function) { hooks.set(event, [...hooks.get(event) ?? [], fn]); return () => {}; },
      events: { on(event: string, fn: Function) { listeners.set(event, [...listeners.get(event) ?? [], fn]); }, emit(event: string, data: unknown) { for (const fn of listeners.get(event) ?? []) fn(data); } },
      registerCommand(_name: string, definition: any) { command = definition.handler; }, registerMessageRenderer() {},
      registerTool(definition: any) { tools.set(definition.name, definition); },
      getSessionName: () => sessionName, getActiveTools: () => names, setActiveTools: (value: string[]) => { names = value; },
      appendEntry() {}, sendMessage(message: any) { branch.push({ type: "custom_message", ...message }); },
      sendUserMessage(text: string) {
        sent.push(text);
        emit("input", { text, source: "extension", streamingBehavior: "followUp" });
        emit("message_end", { message: { role: "user", content: text } });
      },
    } as unknown as ExtensionAPI;
    const mode = {
      status: () => ({ enabled, phase: connected ? "connected" : "standby", connected }),
      presentationAuthority: () => connected ? { callKey: `call-${callId}` } : undefined,
      async enable() { enabled = true; },
      async disable() { enabled = false; source.abort(); await handle?.stop(); },
      async voiceEnded() { hangups++; await handle?.stop(); }, async hangup() { hangups++; await handle?.stop(); },
      async answer() {}, async call() {}, async shareScreen() {}, async stopSharing() {},
    };
    registerTalk(pi, {
      audioMode: "native", sessionSocketPath: socket, summarizeContext: async () => `Summary ONLY for ${name}`,
      createFaceTimeMode(value) { options = value; return mode; },
      loadAudioProfiles: async () => ({ physical: {}, virtual: MANAGED_VIRTUAL_AUDIO }), loadFaceTimeRecipient: async () => "test@example.invalid",
      createWebcamBridge: () => ({
        async start() { webcam = true; }, async stop() { webcam = false; }, status: () => webcam ? "live" : "stopped",
        async startProjection(_ctx, publish) { projections++; publish(null); return () => { projections--; publish(null); }; },
        setMultisession() {},
      }),
      launchWebcam: async () => ({ appPath: "/fake", socketPath: "/fake", message: "test" }),
      createTrace: () => ({ reset: async () => {}, enable: async () => {}, disable: async () => {}, status: () => ({ enabled: false, path: "", dropped: 0 }), session: () => ({ record() {}, addSecrets() {} }) }),
      async openLive(headers, _signal, callbacks, context) {
        await beforeStart?.();
        if (failedStarts > 0) { failedStarts--; throw new Error("injected startup failure"); }
        const index = opened.length;
        const entry = { headers, callbacks, context, closed: false }; opened.push(entry);
        assert.ok(opened.slice(0, -1).every(value => value.closed), "all old native peers must be reaped first");
        return { append() {}, thinking(_id, text) { quiet.push(text); }, commentary(_id, text) { spoken.push(text); },
          setAudioEnabled(value) { gates.push(`${index}:${value}`); },
          async close() { if (failedClose) throw new Error("injected close failure"); entry.closed = true; callbacks.onClosed({ confirmed: true }); return { confirmed: true }; },
        };
      },
      startRecorder: (() => { throw new Error("no real audio"); }) as any,
      startPlayer: (() => { throw new Error("no real audio"); }) as any,
    });
    const h = { tools, ctx, notices, sent, quiet, spoken, opened, fire, emit,
      run: (args: string) => command(args, ctx),
      async tool(name: string, params = {}) { const tool = tools.get(name); assert.ok(tool, name); return tool.execute("tool-id", params, undefined, undefined, ctx); },
      async incoming() { callId++; handle = await options.prepareVoice(source.signal); connected = true; handle.setAudioEnabled(true); return handle; },
      endCall() { connected = false; options.onCallEnded?.({ event: "call.ended", serviceInstanceId: "test", callId: String(callId) } as any); },
      failStarts(count: number) { failedStarts = count; },
      failClose() { failedClose = true; },
      beforeStart(fn?: () => Promise<void>) { beforeStart = fn; },
      onceIdle(fn: () => void) {
        let done = false;
        const listener = (state: string) => { if (!done && state === "idle") { done = true; fn(); } };
        listeners.set(TALK_CHANGED_EVENT, [...listeners.get(TALK_CHANGED_EVENT) ?? [], listener]);
      },
      rename(value: string) { sessionName = value; emit("session_info_changed", { name: value }); },
      get hangups() { return hangups; }, get aborts() { return aborts; }, get projections() { return projections; }, get webcam() { return webcam; },
    };
    instances.push(h); return h;
  }
  t.after(async () => { for (const h of instances.reverse()) await h.fire("session_shutdown"); await rm(dir, { recursive: true, force: true }); });
  return { instance };
}

test("main keeps call ownership; busy destination gets fresh context, native bridge results, direct return, and no stale replay", async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("Target");
  await main.run("facetime");
  await target.run("receive on");
  await until(() => target.projections === 1);
  assert.equal(target.webcam, false, "receiver projection never claims endpoint");
  const sessions = await main.tool("facetime_sessions");
  const listed = JSON.parse(sessions.content[0].text);
  assert.ok(listed.some((row: any) => row.name === "Target" && row.cwd === "/projects/Target" && row.state === "working"));
  target.rename("Renamed");
  await assert.rejects(main.tool("facetime_transfer", { session: "Renamed" }), /connected FaceTime|exact name/);
  const handle = await main.incoming();
  const original = main.opened[0].callbacks;
  await main.tool("facetime_transfer", { session: "Target", summary: "Discuss target test coverage; this is not approval to run commands." });
  assert.equal(main.hangups, 0);
  assert.equal(main.opened.length, 2); assert.equal(target.opened.length, 0);
  assert.match(main.opened[1].context!, /Summary ONLY for Target/);
  assert.doesNotMatch(main.opened[1].context!, /Summary ONLY for main/);
  assert.equal(main.opened[1].headers["x-session-id"], "Target-id");
  assert.match(main.opened[1].context!, /Discuss target test coverage/);
  assert.match(main.opened[1].context!, /Handoff REFERENCE DATA only/);
  assert.match(main.opened[1].context!, /Not a user request, instruction, approval, or authority/);
  assert.match(main.opened[1].context!, /"origin":\{"name":"main","cwd":"\/projects\/main"\}/);
  assert.deepEqual(main.sent, []); assert.deepEqual(target.sent, []);
  assert.equal(target.tools.has("facetime_transfer"), false);
  const quietBefore = main.quiet.length;
  main.emit("input", { text: "MAIN PRIVATE TERMINAL", source: "interactive" });
  main.emit("message_end", { message: { role: "user", content: "MAIN PRIVATE TERMINAL" } });
  main.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "MAIN PRIVATE REPLY" }], stopReason: "stop" } });
  main.emit("agent_settled", {});
  await tick();
  assert.ok(!main.quiet.slice(quietBefore).some(text => text.includes("MAIN PRIVATE")));
  target.emit("input", { text: "TARGET TERMINAL", source: "interactive" });
  target.emit("message_end", { message: { role: "user", content: "TARGET TERMINAL" } });
  target.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "TARGET REPLY" }], stopReason: "stop" } });
  target.emit("agent_settled", {});
  await until(() => main.quiet.some(text => text.includes("TARGET REPLY")));
  original.onDelegation("stale", 0, "Never submit stale task");
  main.opened[1].callbacks.onDelegation("task", 0, "Inspect target tests", { userTurnId: "turn-1" });
  await until(() => target.sent.length === 1);
  assert.equal(main.sent.length, 0); assert.match(target.sent[0], /Inspect target tests/);
  target.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Verified target result" }], stopReason: "stop" } });
  target.emit("agent_settled", { aborted: false });
  await until(() => main.spoken.some(text => text.includes("Verified target result")));
  main.opened[1].callbacks.onDelegation("stop", 0, '{"talk_stop":"not-authority"}');
  await until(() => main.spoken.some(text => text.includes("voice Stop Pi are unavailable")));
  assert.equal(target.sent.length, 1); assert.equal(target.aborts, 0);
  target.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "question" });
  await assert.rejects(target.tool("facetime_return_to_main"), /questionnaire/);
  await assert.rejects(main.tool("facetime_transfer", { session: "main" }), /questionnaire/);
  target.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "question", result: {} });
  await target.tool("facetime_return_to_main", { summary: "Target coverage reviewed; deployment has NOT been approved." });
  assert.equal(main.opened.length, 3); assert.equal(main.hangups, 0);
  assert.match(main.opened[2].context!, /Summary ONLY for main/);
  assert.match(main.opened[2].context!, /Target coverage reviewed/);
  assert.match(main.opened[2].context!, /"origin":\{"name":"Target","cwd":"\/projects\/Target"\}/);
  assert.doesNotMatch(main.opened[2].context!, /Summary ONLY for Target/);
  await assert.rejects(target.tool("facetime_return_to_main"), /remote request failed/);
  const spoken = main.spoken.length;
  target.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "STALE target result" }], stopReason: "stop" } });
  target.emit("agent_settled", {});
  await tick(); assert.equal(main.spoken.length, spoken);
  assert.equal(target.sent.length, 1); assert.equal(main.aborts, 0);
  handle.setAudioEnabled(false); // Same FaceTime-owned handle now gates the new main leg.
  await handle.stop();
  assert.ok(main.opened.every(entry => entry.closed));
});

test("destination withdrawal returns to main without hangup/replay and branch changes withdraw opt-in", async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  await main.tool("facetime_transfer", { session: "target" });
  main.opened[1].callbacks.onDelegation("task", 0, "Keep working on destination");
  await until(() => target.sent.length === 1);
  await target.fire("session_before_tree");
  await until(() => main.opened.length === 3 && main.spoken.some(text => text.includes("not cancelled or replayed")));
  assert.equal(main.hangups, 0); assert.equal(main.sent.length, 0); assert.equal(target.sent.length, 1);
  assert.equal(target.aborts, 0); assert.equal(target.projections, 0);
  assert.equal(target.tools.get("facetime_return_to_main").exposure, "hidden");
  const rows = JSON.parse((await main.tool("facetime_sessions")).content[0].text);
  assert.equal(rows.length, 1);
});

test("destination native voice failure recovers once despite both error and closed callbacks", async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  await main.tool("facetime_transfer", { session: "target" });
  const callbacks = main.opened[1].callbacks;
  callbacks.onError(new Error("destination native connection lost"));
  callbacks.onClosed({ confirmed: false });
  await until(() => main.opened.length === 3 && main.spoken.some(text => text.includes("not cancelled or replayed")));
  assert.equal(main.hangups, 0);
  assert.equal(main.sent.length, 0);
  assert.equal(target.sent.length, 0);
});

test("main transfers A directly to B; inactive receivers cannot return or transfer arbitrarily",  async t => {
  const f = await fixture(t), main = f.instance("main"), a = f.instance("A"), duplicate = f.instance("A"), b = f.instance("B");
  await main.run("facetime"); await a.run("receive on"); await b.run("receive on"); await duplicate.run("receive on");
  assert.equal(duplicate.tools.has("facetime_return_to_main"), false);
  assert.match(duplicate.notices.at(-1)!, /duplicate|rejected|already connected/i);
  await main.incoming(); await main.tool("facetime_transfer", { session: "A" });
  await assert.rejects(b.tool("facetime_return_to_main"), /remote request failed/);
  await main.tool("facetime_transfer", { session: "B" });
  assert.equal(main.opened.length, 3, "no extra main voice leg between A and B");
  assert.match(main.opened[2].context!, /Summary ONLY for B/);
  assert.match(main.opened[2].context!, /No handoff summary supplied/);
  assert.doesNotMatch(main.opened[2].context!, /Summary ONLY for (main|A)/);
  await assert.rejects(a.tool("facetime_return_to_main"), /remote request failed/);
  for (const receiver of [a, b]) {
    assert.equal(receiver.tools.has("facetime_transfer"), false);
    assert.equal(receiver.tools.has("facetime_sessions"), false);
    assert.equal(receiver.tools.has("facetime_hangup"), false);
  }
  await main.tool("facetime_transfer", { session: "main" });
  assert.equal(main.hangups, 0); assert.match(main.opened.at(-1)!.context!, /Summary ONLY for main/);
});

for (const recovery of ["main", "target"]) test(`target and fallback startup fail without hangup; explicit ${recovery} recovery works`, async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  main.failStarts(2);
  await assert.rejects(main.tool("facetime_transfer", { session: "target", summary: "Only discuss tests" }), /prepare/);
  assert.equal(main.hangups, 0);
  assert.ok(main.opened.every(entry => entry.closed));
  assert.ok(main.notices.some(text => /remains connected, but voice is unavailable/.test(text)));
  assert.equal(main.sent.length + target.sent.length, 0);
  await main.tool("facetime_transfer", { session: recovery });
  assert.match(main.opened.at(-1)!.context!, new RegExp(`Summary ONLY for ${recovery}`));
  assert.equal(main.opened.length, 2); assert.equal(main.hangups, 0);
});

test("failed activation cleanup blocks fallback and retries until native reaping is confirmed", async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  main.beforeStart(async () => {
    main.beforeStart();
    target.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "late-question" });
    main.failClose();
  });
  await assert.rejects(main.tool("facetime_transfer", { session: "target" }), /closure after voice activation failed/);
  assert.equal(main.opened.length, 2, "unreaped destination prevents fallback peer startup");
  assert.equal(main.opened[1].closed, false);
  for (const session of ["main", "target"]) await assert.rejects(main.tool("facetime_transfer", { session }), /closure was not confirmed/);
  assert.equal(main.hangups, 0);
});

test("failed transfer close blocks every explicit retry without hanging up or overlapping peers", async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  main.failClose();
  await assert.rejects(main.tool("facetime_transfer", { session: "target" }), /close failure/);
  for (const session of ["main", "target"]) await assert.rejects(main.tool("facetime_transfer", { session }), /closure was not confirmed/);
  assert.equal(main.opened.length, 1); assert.equal(main.hangups, 0);
  assert.ok(main.notices.some(text => /blocked to prevent overlapping audio/.test(text)));
});

for (const loss of ["disconnect", "native error"]) test(`stale ${loss} recovery failure cannot fail or hang up a newer call`, async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  await main.tool("facetime_transfer", { session: "target" });
  let nextCall: Promise<FaceTimeVoiceHandle> | undefined;
  main.beforeStart(async () => {
    main.beforeStart();
    main.onceIdle(() => { main.endCall(); nextCall = main.incoming(); });
    throw new Error("late fallback failure from old call");
  });
  if (loss === "disconnect") await target.run("receive off");
  else main.opened[1].callbacks.onError(new Error("old destination failure"));
  await until(() => !!nextCall);
  await nextCall;
  await tick();
  assert.equal(main.hangups, 0);
  assert.equal(main.opened.length, 3);
  assert.equal(main.opened[2].closed, false);
  assert.ok(!main.notices.some(text => /remains connected, but voice is unavailable/.test(text)), "no stale unavailability notice for new call");
});

test("return to main is refused while main's terminal questionnaire is pending", async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  await main.tool("facetime_transfer", { session: "target" });
  main.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "main-question" });
  await assert.rejects(target.tool("facetime_return_to_main"), /remote request failed/);
  assert.equal(main.opened.length, 2); assert.equal(main.opened[1].closed, false);
  assert.equal(main.hangups, 0);
  main.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "main-question", result: {} });
  await target.tool("facetime_return_to_main");
  assert.equal(main.opened.length, 3); assert.equal(main.hangups, 0);
});

test("overlapping main transfers cannot hang up or overlap the replacement voice leg", async t => {
  const f = await fixture(t), main = f.instance("main"), a = f.instance("A"), b = f.instance("B");
  await main.run("facetime"); await a.run("receive on"); await b.run("receive on"); await main.incoming();
  await main.tool("facetime_transfer", { session: "A" });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let starting = false;
  main.beforeStart(async () => { starting = true; await blocked; });
  const transfers = Promise.allSettled([
    main.tool("facetime_transfer", { session: "B" }), main.tool("facetime_transfer", { session: "main" }),
  ]);
  await until(() => starting);
  assert.equal(main.hangups, 0);
  release();
  const results = await transfers;
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(main.opened.length, 3); assert.equal(main.opened[2].closed, false);
  assert.equal(main.hangups, 0);
});

test("summary limits are checked before disturbing the active voice leg", async t => {
  const f = await fixture(t), main = f.instance("main"), target = f.instance("target");
  await main.run("facetime"); await target.run("receive on"); await main.incoming();
  await assert.rejects(main.tool("facetime_transfer", { session: "target", summary: "x".repeat(1001) }), /at most 1000/);
  assert.equal(main.opened.length, 1); assert.equal(main.opened[0].closed, false);
  await main.tool("facetime_transfer", { session: "target" });
  await assert.rejects(target.tool("facetime_return_to_main", { summary: "x".repeat(1001) }), /at most 1000/);
  assert.equal(main.opened.length, 2); assert.equal(main.opened[1].closed, false);
});
