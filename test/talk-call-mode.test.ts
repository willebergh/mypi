import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTalk } from "../extensions/talk/index.ts";
import type { FaceTimeModeOptions, FaceTimeVoiceHandle } from "../extensions/talk/facetime-mode.ts";
import type { LiveCallbacks } from "../extensions/talk/live.ts";
import { TALK_STATUS_CHANGED_EVENT } from "../extensions/resource-status/protocol.ts";
import { normalizeQuestions } from "../extensions/ask-user/core.ts";
import { requestVoiceQuestions } from "../extensions/ask-user/voice.ts";

type Dependencies = NonNullable<Parameters<typeof registerTalk>[1]>;
function setup(t: TestContext) {
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const handlers = new Map<string, Function>();
  const definitions = new Map<string, any>();
  const notices: string[] = [], gates: boolean[] = [];
  const quiet: string[] = [], spoken: string[] = [];
  const opened: any[][] = [], history: unknown[] = [], sent: unknown[] = [];
  const messages: any[][] = [], emitted: [string, any][] = [];
  const listeners = new Map<string, Function[]>();
  const events = {
    on(name: string, handler: Function) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
    emit(name: string, payload: unknown) { emitted.push([name, payload]); for (const handler of listeners.get(name) ?? []) handler(payload); },
  };
  const statuses = new Map<string, string | undefined>();
  let activeTools = ["read", "bash"];
  let callbacks!: LiveCallbacks;
  let modeOptions!: FaceTimeModeOptions;
  let modeCreates = 0, disabled = 0, voiceEnded = 0, peerCloses = 0;
  let voice: FaceTimeVoiceHandle | undefined;
  const abort = new AbortController();
  const state = { enabled: false, phase: "disabled", connected: false };
  const profiles = {
    physical: { microphone: { id: "physical-mic", name: "Physical microphone" }, speaker: { id: "physical-out", name: "Headphones" } },
    virtual: { microphone: { id: "virtual-in", name: "Agent Input" }, speaker: { id: "virtual-out", name: "Agent Output" } },
  };
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/project", isIdle: () => true,
    sessionManager: { getSessionId: () => "s", getBranch: () => [] },
    modelRegistry: { getApiKeyForProvider: async () => "test-token" },
    ui: { notify: (text: string) => notices.push(text), setStatus: (key: string, value?: string) => statuses.set(key, value), setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; },
    registerMessageRenderer() {}, on(name: string, handler: Function) { handlers.set(name, handler); },
    events, appendEntry() {}, sendMessage(value: unknown, options: unknown) { history.push(value); messages.push([value, options]); }, sendUserMessage(value: unknown) { sent.push(value); },
    registerTool(definition: any) { definitions.set(definition.name, definition); },
    getActiveTools: () => activeTools, setActiveTools: (value: string[]) => { activeTools = value; },
  } as unknown as ExtensionAPI;
  const mode = {
    status: () => ({ ...state }),
    async enable() { state.enabled = true; state.connected = true; state.phase = "standby"; modeOptions.onStatus?.(this.status()); },
    async disable() { disabled++; state.enabled = false; abort.abort(); await voice?.stop(); state.phase = "disabled"; },
    async call(to: string, purpose?: string) { return { to, purpose, submitted: true }; },
    async answer() { return {}; },
    async hangup() { await voice?.stop(); state.phase = "standby"; return {}; },
    async voiceEnded() { voiceEnded++; state.phase = "standby"; },
  };
  const dependencies: Dependencies = {
    audioMode: "native", summarizeContext: async () => undefined,
    loadAudioDevices: async () => profiles.physical,
    loadAudioProfiles: async () => profiles,
    createFaceTimeMode(options) { modeCreates++; modeOptions = options; return mode; },
    createTrace: () => ({ reset: async () => {}, enable: async () => {}, disable: async () => {}, status: () => ({ enabled: false, path: "/unused", dropped: 0 }), session: () => ({ record() {}, addSecrets() {} }) }),
    async openLive(...args) {
      opened.push(args); callbacks = args[2];
      return { append() {}, thinking(_id, text) { quiet.push(text); }, commentary(_id, text) { spoken.push(text); }, setAudioEnabled: (enabled) => gates.push(enabled), close: async () => { peerCloses++; return { confirmed: true }; } };
    },
    startRecorder: (() => { throw new Error("unexpected PCM capture"); }) as Dependencies["startRecorder"],
    startPlayer: (() => { throw new Error("unexpected PCM playback"); }) as Dependencies["startPlayer"],
  };
  registerTalk(pi, dependencies);
  const run = (args: string) => command(args, ctx);
  t.after(async () => { await run("stop"); await handlers.get("session_shutdown")?.({}, ctx); });
  return {
    run, definitions, notices, opened, gates, history, sent, statuses, dependencies, profiles, mode, quiet, spoken,
    get modeOptions() { return modeOptions; }, get modeCreates() { return modeCreates; }, get disabled() { return disabled; },
    get voiceEnded() { return voiceEnded; }, get peerCloses() { return peerCloses; }, get callbacks() { return callbacks; },
    get activeTools() { return activeTools; }, events, emitted, messages,
    get dashboard() { return emitted.filter(([name]) => name === TALK_STATUS_CHANGED_EVENT).at(-1)?.[1]; },
    async ended() {
      await voice?.stop();
      state.phase = "standby";
      modeOptions.onStatus?.(mode.status());
      modeOptions.onCallEnded?.({ event: "call.ended", serviceInstanceId: "test-service", callId: "test-call", verified: true });
    },
    async incoming() { voice = await modeOptions.prepareVoice(abort.signal); return voice; },
    fire: (event: string) => handlers.get(event)?.({}, ctx),
  };
}

test("regular Talk uses physical audio and cannot enable FaceTime tools or standby", async (t) => {
  const h = setup(t);
  await h.run("start");
  assert.deepEqual(h.opened[0][5], { microphone: "physical-mic", speaker: "physical-out" });
  assert.equal(h.opened[0][6], true);
  await h.run("facetime");
  assert.equal(h.modeCreates, 0);
  assert.equal(h.definitions.size, 0);
  assert.match(h.notices.at(-1)!, /Stop the current Talk mode/);
});

test("standby exposes tools without a voice call; virtual call stays gated until connected", async (t) => {
  const h = setup(t);
  await h.run("facetime");
  assert.equal(h.opened.length, 0);
  assert.equal(h.definitions.size, 4);
  assert.deepEqual(h.modeOptions.routing, { input: "Agent Output", output: "Agent Input" });
  assert.deepEqual(h.dashboard, { state: "idle", mode: "facetime", detail: "standby" });
  assert.equal(h.statuses.get("talk-facetime"), undefined, "no separate FaceTime footer status");
  await h.run("start");
  assert.equal(h.opened.length, 0);
  assert.match(h.notices.at(-1)!, /FaceTime Talk mode is on/);
  const voice = await h.incoming();
  assert.deepEqual(h.opened[0][5], { microphone: "virtual-in", speaker: "virtual-out" });
  assert.equal(h.opened[0][6], false);
  assert.equal(h.dashboard.state, "connecting");
  assert.match(h.dashboard.detail, /Waiting for FaceTime connection/);
  h.callbacks.onTurnStart?.("user", "before");
  h.callbacks.onTranscript("user", "not authorized", 0, 1, "delta", { itemId: "before" });
  h.callbacks.onTurn?.("user", "not authorized", { id: "before", startMs: 0, endMs: 1 });
  h.callbacks.onDelegation("before", 0, "Do something");
  assert.equal(h.history.length, 0);
  assert.equal(h.sent.length, 0);
  voice.setAudioEnabled(true);
  assert.equal(h.dashboard.state, "listening");
  assert.equal(h.dashboard.mode, "facetime");
  h.callbacks.onTurnStart?.("user", "after");
  h.callbacks.onTranscript("user", "Hello", 0, 1, "delta", { itemId: "after" });
  h.callbacks.onTurn?.("user", "Hello", { id: "after", startMs: 0, endMs: 1 });
  assert.equal(h.history.length, 1, "same Talk reference history is used after connection");
  await voice.stop();
  assert.equal(h.voiceEnded, 0, "coordinator-owned stop must not recursively request hangup");
  assert.equal(h.definitions.get("facetime_call").exposure, "direct");
});

test("an outgoing introduction uses quiet connection context then a speakable greeting only after gates open", async (t) => {
  const h = setup(t);
  await h.run("facetime");
  const voice = await h.incoming(); // Same owned voice handle is used for either call direction.
  const before = h.spoken.length;
  voice.introduceOutgoingCall?.();
  assert.equal(h.spoken.length, before, "no greeting while audio is gated");
  voice.setAudioEnabled(true);
  voice.introduceOutgoingCall?.("The tests passed; share the verified result.");
  assert.match(h.quiet.at(-2)!, /Verified outgoing FaceTime call.*Say ONLY 'Hello sir'.*wait for the user's first fresh spoken reply/);
  assert.match(h.quiet.at(-2)!, /never an answer, approval, or permission/);
  assert.match(h.quiet.at(-1)!, /Call purpose.*The tests passed; share the verified result/);
  assert.ok(h.quiet.slice(-2).every(text => Buffer.byteLength(text) <= 450));
  assert.equal(h.spoken.at(-1), "Hello sir");
  await h.run("stop");
  const after = h.spoken.length;
  voice.introduceOutgoingCall?.();
  assert.equal(h.spoken.length, after, "no introduction on a stale voice handle");
});

test("manual calls can supply a purpose, without treating missing purpose as known context", async (t) => {
  const h = setup(t);
  await h.run("facetime");
  await h.run("facetime call synthetic@example.invalid --reason The requested tests passed.");
  const result = JSON.parse(h.notices.at(-1)!);
  assert.equal(result.to, "synthetic@example.invalid");
  assert.equal(result.purpose, "The requested tests passed.");
  const voice = await h.incoming();
  voice.setAudioEnabled(true);
  voice.introduceOutgoingCall?.();
  assert.match(h.quiet.at(-1)!, /No specific topic was supplied/);
  assert.match(h.quiet.at(-1)!, /After their reply, ask what they would like to discuss/);
  assert.equal(h.spoken.at(-1), "Hello sir");
});

test("stopping or switching Pi sessions disables mode and hides every FaceTime tool", async (t) => {
  const h = setup(t);
  await h.run("facetime");
  await h.incoming();
  await h.fire("session_before_switch");
  assert.equal(h.disabled, 1);
  assert.equal(h.peerCloses, 1);
  assert.deepEqual(h.activeTools, ["read", "bash"]);
  assert.ok([...h.definitions.values()].every(value => value.exposure === "hidden"));
  assert.equal(h.statuses.get("talk-facetime"), undefined);
  await h.run("start");
  assert.equal(h.opened[1][6], true);
});

test("call end releases ask_user without terminal fallback and queues a lifecycle turn", async (t) => {
  const h = setup(t);
  await h.run("facetime");
  const voice = await h.incoming();
  voice.setAudioEnabled(true);
  const questions = normalizeQuestions([{ id: "color", question: "Which color?", options: [{ label: "Blue" }, { label: "Green" }] }]);
  const waiting = requestVoiceQuestions(h.events, questions);
  h.callbacks.onTranscript("user", "Blue", 0, 1, "delta", { itemId: "choice" });
  h.callbacks.onDelegation("choice", 0, "Blue");
  await h.ended();
  const result = await waiting;
  assert.ok(result, "undefined would wrongly open the terminal fallback");
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.answers[0].answers, [], "unconfirmed choice is not an approval");
  const notifications = h.messages.filter(([message]) => message.customType === "talk-facetime-event");
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0][1], { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(notifications[0][0].display, false);
  assert.match(notifications[0][0].content, /not an answer, approval/);
  assert.deepEqual(h.dashboard, { state: "idle", mode: "facetime", detail: "standby" });
  await h.run("stop");
  assert.deepEqual(h.dashboard, { state: "idle" });
});

test("invalid virtual settings fail without exposing tools or opening audio", async (t) => {
  const h = setup(t);
  h.dependencies.loadAudioProfiles = async () => ({ physical: {}, virtual: {} });
  await h.run("facetime");
  assert.equal(h.modeCreates, 0);
  assert.equal(h.opened.length, 0);
  assert.equal(h.definitions.size, 0);
  assert.match(h.notices.at(-1)!, /requires an explicit microphone and output/);
});
