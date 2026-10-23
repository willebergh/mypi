import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDictation } from "../extensions/dictation/index.ts";
import { startRecorder } from "../extensions/dictation/recorder.ts";

function extension() {
  const shortcuts = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function>();
  const emitted: [string, unknown][] = [];
  const pi = {
    registerShortcut: (key: string, value: any) => shortcuts.set(key, value),
    registerCommand: (key: string, value: any) => commands.set(key, value),
    on: (key: string, value: Function) => events.set(key, value),
    events: { emit(name: string, value: unknown) { emitted.push([name, value]); } },
  } as unknown as ExtensionAPI;
  return { pi, shortcuts, commands, events, emitted };
}
function context(overrides: Record<string, any> = {}) {
  let draft = "";
  const ui = {
    setStatus() {}, notify() {}, pasteToEditor(text: string) { draft += text; },
    getEditorText() { return draft; }, setEditorText(text: string) { draft = text; },
  };
  const ctx = {
    mode: "tui", ui,
    modelRegistry: { getApiKeyForProvider: async () => "token" },
    sessionManager: { getSessionId: () => "session" },
    ...overrides,
  } as unknown as ExtensionContext;
  return { ctx, ui };
}
const timerContexts = new WeakSet<TestContext>();
function setup(t: TestContext, deps: Record<string, any> = {}) {
  if (!timerContexts.has(t)) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    timerContexts.add(t);
    setKittyProtocolActive(true);
    t.after(() => setKittyProtocolActive(false));
  }
  const ext = extension();
  const calls = { pasted: [] as string[], status: [] as any[], notices: [] as any[], appended: [] as Buffer[], closed: 0, stopped: 0, headers: undefined as any, signal: undefined as any };
  let finish: () => Promise<string> = async () => "hello";
  let onTranscript: ((text: string) => void) | undefined;
  let onAudio: ((pcm: Buffer) => void) | undefined;
  const transcriber = {
    append: (pcm: Buffer) => calls.appended.push(pcm),
    finish: () => finish(), close: () => { calls.closed++; },
  };
  const recorder = { stop: async () => { calls.stopped++; } };
  const injected = {
    openTranscriber: async (headers: any, signal: any, _error: any, update?: (text: string) => void) => {
      calls.headers = headers; calls.signal = signal; onTranscript = update; return transcriber;
    },
    startRecorder: (append: (b: Buffer) => void, _error: any) => { onAudio = append; return recorder; },
    ...deps,
  };
  const c = context();
  const paste = c.ui.pasteToEditor;
  c.ui.pasteToEditor = (text: string) => { calls.pasted.push(text); paste(text); };
  c.ui.setStatus = (...args: any[]) => calls.status.push(args);
  c.ui.notify = (...args: any[]) => calls.notices.push(args);
  let input!: (data: string) => unknown;
  (c.ctx.ui as any).onTerminalInput = (handler: typeof input) => { input = handler; return () => {}; };
  registerDictation(ext.pi, injected);
  ext.events.get("session_start")!({}, c.ctx);
  ext.emitted.length = 0; // Assertions below track activity after session initialization.
  t.after(() => ext.events.get("session_shutdown")!());
  let held = false;
  return {
    async toggle() {
      held = !held;
      input(held ? "\x1b[32u" : "\x1b[32;1:3u");
      if (held) t.mock.timers.tick(1_000);
      // Keyboard callbacks intentionally launch asynchronous capture/finish work.
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    ...ext, ...c, calls, transcriber, recorder, setFinish: (f: typeof finish) => { finish = f; },
    transcript: (text: string) => onTranscript?.(text),
    audio: (pcm: Buffer) => onAudio?.(pcm),
  };
}
const start = (h: ReturnType<typeof setup>) => h.toggle();
const cancel = (h: ReturnType<typeof setup>) => h.events.get("session_before_tree")!();

test("dictation uses existing codex credentials regardless of selected provider and pastes without sending", async (t) => {
  const h = setup(t);
  assert.equal(h.commands.size, 0);
  (h.ctx as any).model = { provider: "other" };
  (h.ctx as any).modelRegistry.getApiKeyForProvider = async (id: string) => { assert.equal(id, "openai-codex"); return "token"; };
  await start(h);
  assert.equal(h.calls.headers.authorization, "Bearer token");
  assert.equal(h.calls.headers["x-session-id"], "session");
  h.transcriber.append(Buffer.from("pcm"));
  assert.deepEqual(h.calls.appended, [Buffer.from("pcm")]);
  await start(h);
  assert.equal(h.ui.getEditorText(), "hello ");
  assert.equal(h.calls.stopped, 1);
  assert.equal(h.calls.closed, 1);
});

test("cancel while authorization or setup is pending prevents recorder start", async (t) => {
  for (const stage of ["auth", "setup"]) {
    let release!: (value: any) => void;
    const h = setup(t, stage === "setup" ? { openTranscriber: () => new Promise((r) => { release = r; }) } : {});
    if (stage === "auth") (h.ctx as any).modelRegistry.getApiKeyForProvider = () => new Promise((r) => { release = r; });
    const opening = start(h);
    await Promise.resolve();
    await cancel(h);
    release(stage === "auth" ? "token" : { close() {} });
    await opening;
    assert.equal(h.calls.stopped, 0);
  }
});

test("tree navigation discards a live recording and shutdown during finish never pastes", async (t) => {
  const h = setup(t);
  await start(h);
  await cancel(h);
  assert.deepEqual(h.calls.pasted, []);
  assert.equal(h.calls.stopped, 1);
  const x = setup(t);
  let resolve!: (s: string) => void;
  x.setFinish(() => new Promise((r) => { resolve = r; }));
  await start(x);
  const finishing = start(x);
  await Promise.resolve();
  await x.events.get("session_shutdown")!();
  resolve("late");
  await finishing;
  assert.deepEqual(x.calls.pasted, []);
});

test("empty token, empty transcript, and errors clean up safely", async (t) => {
  const empty = setup(t);
  (empty.ctx as any).modelRegistry.getApiKeyForProvider = async () => "";
  await start(empty);
  assert.equal(empty.calls.stopped, 0);
  assert.equal(empty.calls.notices[0][1], "error");
  const blank = setup(t); blank.setFinish(async () => "");
  await start(blank); await start(blank);
  assert.deepEqual(blank.calls.pasted, []);
  let onError!: (e: Error) => void;
  const broken = setup(t, { startRecorder: (_append: any, error: any) => { onError = error; return { stop: async () => {} }; } });
  await start(broken); onError(new Error("broken")); await Promise.resolve(); await Promise.resolve();
  assert.equal(broken.calls.closed, 1);
});

test("empty results distinguish missing capture from an empty model transcript", async (t) => {
  for (const size of [0, 12_000]) {
    const h = setup(t);
    h.setFinish(async () => "");
    await start(h);
    h.audio(Buffer.alloc(size));
    await start(h);
    assert.match(h.calls.notices.at(-1)[0], size === 0 ? /No microphone audio/ : /No transcript returned for 0\.25 seconds/);
  }
});

test("terminal listener filters Shift even when a dialog owns input", async (t) => {
  const h = setup(t);
  let input!: (data: string) => unknown;
  (h.ctx.ui as any).onTerminalInput = (handler: typeof input) => { input = handler; return () => {}; };
  await h.events.get("session_start")!({}, h.ctx);
  assert.deepEqual(input("\x1b[57441;2u"), { consume: true });
  await h.events.get("ui_prompt_start")!();
  assert.deepEqual(input("\x1b[57441;2:3u"), { consume: true });
  assert.equal(input("A"), undefined);
  assert.equal(h.ui.getEditorText(), "");
  await h.events.get("session_shutdown")!();
});

test("live text preserves the draft and final corrections never duplicate it", async (t) => {
  const h = setup(t);
  h.ui.setEditorText("Existing draft: ");
  await start(h);
  h.transcript("hel");
  assert.equal(h.ui.getEditorText(), "Existing draft: hel ");
  h.transcript("hello world");
  assert.equal(h.ui.getEditorText(), "Existing draft: hello world ");
  h.setFinish(async () => "Hello, world!");
  await start(h);
  assert.equal(h.ui.getEditorText(), "Existing draft: Hello, world! ");
});

test("cancellation rolls back the live preview and ignores late updates", async (t) => {
  const h = setup(t);
  h.ui.setEditorText("keep me");
  await start(h);
  h.transcript("temporary");
  await cancel(h);
  assert.equal(h.ui.getEditorText(), "keep me");
  h.transcript("too late");
  assert.equal(h.ui.getEditorText(), "keep me");
});

test("manual prompt edits are not overwritten by later live updates or cleanup", async (t) => {
  const h = setup(t);
  await start(h);
  h.transcript("hello");
  h.ui.setEditorText("my independent edit");
  h.transcript("hello world");
  await Promise.resolve();
  assert.equal(h.ui.getEditorText(), "my independent edit");
  assert.match(h.calls.notices.at(-1)[0], /prompt was edited/);
  assert.equal(h.calls.stopped, 1);
});

test("dashboard states reflect actual microphone data and finishing", async (t) => {
  const h = setup(t);
  await start(h);
  const states = () => h.emitted.filter(([name]) => name === "mypi:dictation-changed").map(([, state]) => state);
  assert.deepEqual(states(), ["connecting"]);
  h.audio(Buffer.alloc(0));
  assert.deepEqual(states(), ["connecting"]);
  h.audio(Buffer.alloc(4800));
  assert.deepEqual(states(), ["connecting", "listening"]);
  await start(h);
  assert.deepEqual(states(), ["connecting", "listening", "finishing", "idle"]);
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); kills: string[] = [];
  kill(signal: string) { this.kills.push(signal); return true; }
}
function childHarness() {
  const child = new FakeChild(); let args: any[] = [];
  const spawn = ((...values: any[]) => { args = values; return child; }) as any;
  return { child, args: () => args, spawn };
}
test("recorder captures SoX arguments, forwards PCM, SIGINTs and drains close", async () => {
  const h = childHarness(); const audio: Buffer[] = []; const errors: Error[] = [];
  const recorder = startRecorder((b) => audio.push(b), (e) => errors.push(e), h.spawn);
  assert.deepEqual(h.args().slice(0, 2), ["rec", ["-q", "--buffer", "1024", "-t", "raw", "-r", "24000", "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-"]]);
  const pcm = Buffer.from("pcm"); h.child.stdout.write(pcm); assert.deepEqual(audio, [pcm]);
  const stopped = recorder.stop(); assert.deepEqual(h.child.kills, ["SIGINT"]);
  const tail = Buffer.from("word tail");
  h.child.stdout.write(tail);
  assert.deepEqual(audio, [pcm, tail], "drain final audio even after stop was requested");
  h.child.emit("close", 0); await stopped; assert.deepEqual(errors, []);
});

test("recorder reports ENOENT and unexpected close once", async () => {
  for (const kind of ["enoent", "close"]) {
    const h = childHarness(); const errors: Error[] = [];
    const recorder = startRecorder(() => {}, (e) => errors.push(e), h.spawn);
    if (kind === "enoent") h.child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    else h.child.emit("close", 1);
    await recorder.stop();
    assert.equal(errors.length, 1);
    if (kind === "enoent") assert.match(errors[0].message, /SoX/);
  }
});

test("recorder escalates to SIGKILL if SIGINT does not close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = childHarness(); const recorder = startRecorder(() => {}, () => {}, h.spawn);
  const stopped = recorder.stop(); t.mock.timers.tick(1_000);
  assert.deepEqual(h.child.kills, ["SIGINT", "SIGKILL"]);
  h.child.emit("close", 0); await stopped;
});
