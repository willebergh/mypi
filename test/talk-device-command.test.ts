import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTalk } from "../extensions/talk/index.ts";
import type { TalkDeviceSettings } from "../extensions/talk/audio-devices.ts";

type Dependencies = NonNullable<Parameters<typeof registerTalk>[1]>;
function harness(t: TestContext, mode: "native" | "browser" = "native") {
  const handlers = new Map<string, Function>();
  const notices: string[] = [];
  const selections: string[][] = [];
  const saved: TalkDeviceSettings[] = [];
  const opened: unknown[] = [];
  let answers: (string | undefined)[] = [];
  let settings: TalkDeviceSettings = {};
  let discoveries = 0;
  let closes = 0;
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/project", isIdle: () => true,
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    modelRegistry: { getApiKeyForProvider: async () => "test-token" },
    ui: {
      notify: (message: string) => notices.push(message), setStatus() {}, setWidget() {},
      async select(_title: string, options: string[]) { selections.push(options); return answers.shift(); },
    },
  } as unknown as ExtensionContext;
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const pi = {
    registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; },
    registerMessageRenderer() {},
    on(name: string, handler: Function) { handlers.set(name, handler); },
    events: { on() {}, emit() {} }, appendEntry() {}, sendUserMessage() {}, sendMessage() {},
  } as unknown as ExtensionAPI;
  const dependencies: Dependencies = {
    audioMode: mode,
    loadAudioDevices: async () => structuredClone(settings),
    saveAudioDevices: async (next) => { settings = structuredClone(next); saved.push(settings); },
    resetAudioProfiles: async () => { settings = {}; saved.push({}); },
    listAudioDevices: async () => { discoveries++; return {
      inputs: [{ id: "mic-1", name: "USB Microphone", is_default: true }],
      outputs: [{ id: "out-1", name: "Headphones", is_default: true }],
    }; },
    summarizeContext: async () => undefined,
    createTrace: () => ({
      reset: async () => {}, disable: async () => {}, enable: async () => {},
      status: () => ({ enabled: false, path: "/unused/devices.jsonl", dropped: 0 }),
      session: () => ({ record() {}, addSecrets() {} }),
    }),
    openLive: async (...args) => {
      opened.push(args[5]);
      return { append() {}, thinking() {}, commentary() {}, close: async () => { closes++; return { confirmed: true, seconds: 0 }; } };
    },
    startRecorder: (() => { throw new Error("must not open microphone in device picker"); }) as Dependencies["startRecorder"],
    startPlayer: (() => { throw new Error("must not play audio in device picker"); }) as Dependencies["startPlayer"],
  };
  registerTalk(pi, dependencies);
  t.after(async () => { await command("stop", ctx); await handlers.get("session_shutdown")?.({}, ctx); });
  return {
    command: (args: string) => command(args, ctx), ctx, dependencies, notices, selections, saved, opened,
    setAnswers: (...values: (string | undefined)[]) => { answers = values; },
    setSettings: (value: TalkDeviceSettings) => { settings = value; },
    get discoveries() { return discoveries; }, get closes() { return closes; },
    fire: (name: string) => handlers.get(name)?.({}, ctx),
  };
}

test("/talk devices saves both selections without opening a call; next connection receives IDs", async (t) => {
  const h = harness(t);
  h.setAnswers("Physical", "1. USB Microphone [default]", "1. Headphones [default]");
  await h.command("devices");
  assert.deepEqual(h.selections[0], ["Physical", "Virtual"]);
  assert.equal(h.discoveries, 1);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.saved, [{ microphone: { id: "mic-1", name: "USB Microphone" }, speaker: { id: "out-1", name: "Headphones" } }]);
  await h.command("start");
  assert.deepEqual(h.opened, [{ microphone: "mic-1", speaker: "out-1" }]);
  await h.command("status");
  assert.match(h.notices.at(-1)!, /Microphone: USB Microphone\nOutput: Headphones/);
});

test("changing selections preserves the active call until reconnect", async (t) => {
  const h = harness(t);
  await h.command("start");
  h.setAnswers("Physical", "1. USB Microphone [default]", "System default");
  await h.command("devices");
  assert.equal(h.closes, 0);
  assert.equal(h.opened.length, 1);
  assert.match(h.notices.at(-1)!, /current call is unchanged/);
  await h.command("status");
  assert.match(h.notices.at(-1)!, /Microphone: System default\nOutput: System default/);
  await h.command("stop");
  await h.command("start");
  assert.deepEqual(h.opened, [{}, { microphone: "mic-1" }]);
});

test("cancel is transactional; explicit audio reset does not enumerate and startup errors stay safe", async (t) => {
  const h = harness(t);
  h.setAnswers("Physical", "1. USB Microphone [default]", undefined);
  await h.command("devices");
  assert.equal(h.saved.length, 0);
  h.dependencies.loadAudioDevices = async () => { throw new Error("private invalid config"); };
  await h.command("devices reset");
  assert.deepEqual(h.saved, [{}]);
  assert.equal(h.discoveries, 1);
  await h.command("start");
  assert.equal(h.opened.length, 0);
  assert.ok(h.notices.some(message => /Could not read Talk audio settings.*devices reset/.test(message)));
  assert.ok(h.notices.every(message => !message.includes("private invalid config")));
});

test("non-native and headless device pickers do not enumerate or persist", async (t) => {
  const browser = harness(t, "browser");
  await browser.command("devices");
  assert.match(browser.notices.at(-1)!, /native Talk audio only/);
  assert.equal(browser.discoveries, 0);
  const native = harness(t);
  (native.ctx as any).hasUI = false;
  await native.command("devices");
  assert.match(native.notices.at(-1)!, /interactive UI/);
  assert.equal(native.discoveries, 0);
  assert.equal(native.saved.length, 0);
});

test("virtual profile selection and reset do not overwrite physical selections", async (t) => {
  const h = harness(t);
  const writes: unknown[] = [];
  h.dependencies.loadAudioProfiles = async () => ({ physical: { microphone: { id: "physical", name: "Built in" } }, virtual: {} });
  h.dependencies.saveAudioProfile = async (profile, settings) => { writes.push({ profile, settings }); };
  h.setAnswers("1. USB Microphone [default]", "1. Headphones [default]");
  await h.command("devices virtual");
  assert.deepEqual(writes, [{ profile: "virtual", settings: { microphone: { id: "mic-1", name: "USB Microphone" }, speaker: { id: "out-1", name: "Headphones" } } }]);
  assert.equal(h.saved.length, 0, "legacy physical save was not called");
  await h.command("devices virtual reset");
  assert.deepEqual(writes[1], { profile: "virtual", settings: {} });
});

test("the first picker can select virtual, or cancel without loading/enumerating/saving", async (t) => {
  const h = harness(t);
  const writes: unknown[] = [];
  let loads = 0;
  h.dependencies.loadAudioProfiles = async () => { loads++; return { physical: {}, virtual: {} }; };
  h.dependencies.saveAudioProfile = async (profile, settings) => { writes.push({ profile, settings }); };
  h.setAnswers(undefined);
  await h.command("devices");
  assert.equal(h.discoveries, 0);
  assert.equal(loads, 0);
  assert.equal(writes.length, 0);
  h.setAnswers("Virtual", "1. USB Microphone [default]", "System default");
  await h.command("devices");
  assert.deepEqual(writes, [{ profile: "virtual", settings: { microphone: { id: "mic-1", name: "USB Microphone" } } }]);
  assert.match(h.notices.at(-1)!, /Talk virtual audio settings saved/);
});

test("shutdown cancels discovery and does not save or open stale dialogs", async (t) => {
  const h = harness(t);
  let signal!: AbortSignal;
  h.dependencies.listAudioDevices = async (value) => {
    signal = value;
    await new Promise<void>(resolve => value.addEventListener("abort", () => resolve(), { once: true }));
    return { inputs: [], outputs: [] };
  };
  const picking = h.command("devices physical");
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await h.fire("session_shutdown");
  await picking;
  assert.equal(signal.aborted, true);
  assert.equal(h.selections.length, 0);
  assert.equal(h.saved.length, 0);
});
