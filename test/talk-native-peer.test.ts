import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNativePeer, type NativeAudioSelection, type NativePeerOptions } from "../extensions/talk/native-peer.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: Record<string, unknown>[] = [];
  kills: unknown[] = [];
  autoClose = true;
  closeOnKill = true;
  holdWrites = false;
  writes: (() => void)[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.commands.push(JSON.parse(chunk.toString()));
      if (this.holdWrites) this.writes.push(done);
      else done();
    },
    final: (done) => {
      done();
      if (this.autoClose) queueMicrotask(() => this.emit("close", 0, null));
    },
  });
  kill(signal: unknown) {
    this.kills.push(signal);
    if (signal === "SIGKILL" && this.closeOnKill) this.emit("close", null, signal);
    return true;
  }
  event(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

function harness(child = new FakeChild(), options: NativePeerOptions = {}) {
  const controller = new AbortController();
  const errors: Error[] = [];
  const events: unknown[] = [];
  let ready = 0;
  let closed = 0;
  const calls: unknown[][] = [];
  const spawnProcess = ((...args: unknown[]) => { calls.push(args); return child; }) as unknown as typeof spawn;
  const callbacks = {
    onError(error: Error) { errors.push(error); },
    onEvent(event: unknown) { events.push(event); },
    onReady() { ready++; },
    onClosed() { closed++; },
  };
  const setup = createNativePeer(callbacks, controller.signal, { platform: "darwin", spawnProcess, ...options });
  // Observe immediately, including tests that deliberately fail before awaiting.
  void setup.catch(() => {});
  return {
    child, controller, errors, events, calls, setup, callbacks,
    get ready() { return ready; }, get closed() { return closed; },
    async launch() { child.event({ type: "ready", version: 6 }); return setup; },
  };
}
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

async function connected() {
  const h = harness();
  const peer = await h.launch();
  h.child.event({ type: "offer", sdp: "v=0\r\n" });
  await peer.offer;
  peer.applyAnswer("v=0\r\nanswer");
  h.child.event({ type: "state", state: "ready" });
  return { ...h, peer };
}

test("spawns only the local binary, pipes everything and passes an environment allowlist", async () => {
  const h = harness();
  const peer = await h.launch();
  const [binary, args, options] = h.calls[0] as [string, unknown, { env: NodeJS.ProcessEnv; stdio: string[] }];
  assert.equal(binary, fileURLToPath(new URL(`../extensions/talk/native/bin/darwin-${process.arch}/pi-codex-voice`, import.meta.url)));
  assert.deepEqual(args, []);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME"];
  assert.deepEqual(Object.keys(options.env).sort(), allowed.filter((key) => process.env[key] !== undefined).sort());
  h.child.stderr.write("secret stderr sk-key v=0\n".repeat(50_000));
  await peer.close();
  assert.equal(h.closed, 1);
  assert.equal(h.errors.length, 0);
});

test("missing binary never falls back, and unsupported platforms never spawn", async () => {
  const h = harness();
  h.child.emit("error", Object.assign(new Error("secret path"), { code: "ENOENT" }));
  await assert.rejects(h.setup, /\/skill:setup/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.errors.length, 1);
  assert.equal(h.closed, 1);
  assert.doesNotMatch(h.errors[0].message, /secret/);
  let spawns = 0;
  await assert.rejects(createNativePeer(h.callbacks, new AbortController().signal, {
    platform: "linux", spawnProcess: (() => { spawns++; }) as unknown as typeof spawn,
  }), /macOS/);
  assert.equal(spawns, 0);
});

test("launch readiness differs from session readiness; nested messages remain intact", async () => {
  const h = harness();
  const peer = await h.launch();
  assert.deepEqual(h.child.commands, [{ type: "start_v3" }]);
  assert.equal(h.ready, 0);
  assert.throws(() => peer.sendData({}), /not ready/);
  h.child.event({ type: "state", state: "ready" });
  h.child.event({ type: "data", message: { body: "ignored" } });
  h.child.event({ type: "offer", sdp: "v=0\n" });
  assert.equal(await peer.offer, "v=0\n");
  peer.applyAnswer("v=0\nanswer");
  assert.throws(() => peer.applyAnswer("v=0\n"));
  const message = { type: "data", body: { nested: ["hello", { type: "error" }] } };
  h.child.event({ type: "data", message });
  assert.deepEqual(h.events, [message]);
  assert.equal(h.ready, 0);
  assert.throws(() => peer.sendData(message));
  h.child.event({ type: "state", state: "listening" });
  h.child.event({ type: "state", state: "ready" });
  assert.equal(h.ready, 1);
  peer.sendData(message);
  assert.deepEqual(h.child.commands.slice(1), [
    { type: "apply_answer", sdp: "v=0\nanswer" }, { type: "send_data", message },
  ]);
  const closing = peer.close();
  assert.equal(peer.close(), closing);
  await closing;
  assert.deepEqual(h.child.commands.at(-1), { type: "shutdown" });
  assert.equal(h.closed, 1);
  assert.equal(h.errors.length, 0);
});

test("initial disabled audio gates follow start_v3 before offer or answer, with device selection intact", async () => {
  const h = harness(new FakeChild(), { initialAudioEnabled: false, microphone: "input", speaker: "output" });
  assert.equal(h.child.commands.length, 0);
  const peer = await h.launch();
  assert.equal(typeof peer.setAudioEnabled, "function");
  assert.deepEqual(h.child.commands, [
    { type: "start_v3", microphone: "input", speaker: "output" },
    { type: "set_input_muted", muted: true },
    { type: "set_speaker_suppressed", suppressed: true, epoch: 1 },
  ]);
  peer.setAudioEnabled!(false);
  assert.equal(h.child.commands.length, 3);
  h.child.event({ type: "offer", sdp: "v=0\n" });
  await peer.offer;
  peer.applyAnswer("v=0\nanswer");
  h.child.event({ type: "state", state: "ready" });
  peer.setAudioEnabled!(true);
  peer.setAudioEnabled!(true);
  peer.setAudioEnabled!(false);
  peer.setAudioEnabled!(false);
  peer.setAudioEnabled!(true);
  assert.deepEqual(h.child.commands.slice(3), [
    { type: "apply_answer", sdp: "v=0\nanswer" },
    { type: "set_input_muted", muted: false },
    { type: "set_speaker_suppressed", suppressed: false, epoch: 2 },
    { type: "set_input_muted", muted: true },
    { type: "set_speaker_suppressed", suppressed: true, epoch: 3 },
    { type: "set_input_muted", muted: false },
    { type: "set_speaker_suppressed", suppressed: false, epoch: 4 },
  ]);
  assert.equal(h.errors.length, 0);
  await peer.close();
  assert.throws(() => peer.setAudioEnabled!(true), /closed/);
  assert.equal(h.errors.length, 0);
  assert.equal(h.child.commands.at(-1)?.type, "shutdown");
});

test("default and explicit enabled starts are unchanged; gates can change before an offer", async () => {
  for (const initialAudioEnabled of [undefined, true]) {
    const h = harness(new FakeChild(), { initialAudioEnabled });
    const peer = await h.launch();
    peer.setAudioEnabled!(true);
    peer.setAudioEnabled!(true);
    assert.deepEqual(h.child.commands, [{ type: "start_v3" }]);
    peer.setAudioEnabled!(false);
    peer.setAudioEnabled!(false);
    peer.setAudioEnabled!(true);
    assert.deepEqual(h.child.commands.slice(1), [
      { type: "set_input_muted", muted: true },
      { type: "set_speaker_suppressed", suppressed: true, epoch: 1 },
      { type: "set_input_muted", muted: false },
      { type: "set_speaker_suppressed", suppressed: false, epoch: 2 },
    ]);
    await peer.close();
  }
});

for (const initial of [true, false]) {
  for (const command of ["set_input_muted", "set_speaker_suppressed"]) {
    for (const asyncError of [false, true]) {
      test(`audio gate ${command} write failure closes peer (${initial ? "initial" : "runtime"}, ${asyncError ? "callback" : "throw"})`, async (t) => {
        const h = harness(new FakeChild(), { initialAudioEnabled: !initial });
        const original = h.child.stdin.write.bind(h.child.stdin);
        t.mock.method(h.child.stdin, "write", (line: string, callback: (error?: Error | null) => void) => {
          if (JSON.parse(line).type === command) {
            if (!asyncError) throw new Error("secret write failure");
            queueMicrotask(() => callback(new Error("secret write failure")));
            return true;
          }
          return original(line, callback);
        });
        if (initial) {
          h.child.event({ type: "ready", version: 6 });
          await assert.rejects(h.setup);
        } else {
          const peer = await h.launch();
          if (asyncError) peer.setAudioEnabled!(false);
          else assert.throws(() => peer.setAudioEnabled!(false), /input failed/);
          await flush();
          assert.throws(() => peer.setAudioEnabled!(true), /closed/);
          assert.throws(() => peer.applyAnswer("v=0\nanswer"));
          await peer.close();
        }
        assert.equal(h.errors.length, 1);
        assert.equal(h.closed, 1);
        assert.doesNotMatch(h.errors[0].message, /secret/);
        assert.equal(h.child.commands.at(-1)?.type, "shutdown");
      });
    }
  }
}

test("audio gate queue saturation fails closed", async () => {
  const h = harness();
  const peer = await h.launch();
  Object.defineProperty(h.child.stdin, "writableLength", { get: () => 512 * 1024 });
  assert.throws(() => peer.setAudioEnabled!(false), /queue/);
  await peer.close();
  assert.equal(h.errors.length, 1);
  assert.equal(h.closed, 1);
  assert.deepEqual(h.child.commands, [{ type: "start_v3" }]);
});

test("invalid gate values fail closed rather than coercing to enabled", async () => {
  for (const enabled of [null, 0, "true", {}]) {
    const h = harness();
    const peer = await h.launch();
    assert.throws(() => peer.setAudioEnabled!(enabled as boolean), /Invalid native audio gate/);
    await peer.close();
    assert.equal(h.errors.length, 1);
    assert.deepEqual(h.child.commands, [{ type: "start_v3" }, { type: "shutdown" }]);
  }
});

test("initial gate option is validated before spawn and snapshotted", async () => {
  for (const initialAudioEnabled of [null, 0, "false", {}]) {
    let spawns = 0;
    await assert.rejects(createNativePeer({ onEvent() {}, onReady() {}, onError() {}, onClosed() {} }, new AbortController().signal, {
      platform: "darwin", initialAudioEnabled: initialAudioEnabled as boolean,
      spawnProcess: (() => { spawns++; }) as unknown as typeof spawn,
    }), /Invalid native initial audio gate/);
    assert.equal(spawns, 0);
  }
  const child = new FakeChild();
  const options: NativePeerOptions = {
    platform: "darwin", initialAudioEnabled: false,
    spawnProcess: (() => child) as unknown as typeof spawn,
  };
  const setup = createNativePeer({ onEvent() {}, onReady() {}, onError() {}, onClosed() {} }, new AbortController().signal, options);
  options.initialAudioEnabled = true;
  child.event({ type: "ready", version: 6 });
  const peer = await setup;
  assert.deepEqual(child.commands.slice(1), [
    { type: "set_input_muted", muted: true },
    { type: "set_speaker_suppressed", suppressed: true, epoch: 1 },
  ]);
  await peer.close();
});

test("normal speaker activity and playout diagnostics do not terminate a call", async () => {
  const h = await connected();
  h.child.event({ type: "playback_activity" });
  h.child.event({ type: "playout_stats", epoch: 0, underruns: 0, start_threshold_ms: 40 });
  h.child.event({ type: "data", message: { type: "output_transcript.added", item: { text: "Hello" } } });
  assert.equal(h.errors.length, 0);
  assert.equal(h.events.length, 1);
  await h.peer.close();
});

test("split multibyte UTF-8 and combined many-line chunks are framed individually", async () => {
  const h = await connected();
  const message = { body: "こんにちは 🎙️" };
  const bytes = Buffer.from(`${JSON.stringify({ type: "data", message })}\n`);
  for (const byte of bytes) h.child.stdout.write(Buffer.from([byte]));
  const line = `${JSON.stringify({ type: "data", message })}\n`;
  h.child.stdout.write(line.repeat(10_000));
  assert.equal(h.events.length, 10_001);
  assert.deepEqual(h.events[0], message);
  await h.peer.close();
});

test("malformed, partial, oversized and invalid protocol events fail closed without leaking content", async () => {
  for (const emit of [
    (c: FakeChild) => c.stdout.write("secret invalid JSON\n"),
    (c: FakeChild) => { c.stdout.write('{"type":"secret'); c.stdout.end(); },
    (c: FakeChild) => c.stdout.write("x".repeat(512 * 1024 + 1)),
    (c: FakeChild) => { c.stdout.write("x".repeat(512 * 1024)); c.stdout.write("x"); },
    (c: FakeChild) => c.event({ type: "offer", sdp: "secret invalid SDP" }),
    (c: FakeChild) => c.event({ type: "offer", sdp: `v=0\n${"x".repeat(256 * 1024)}` }),
    (c: FakeChild) => c.event({ type: "data", message: "x".repeat(64 * 1024) }),
    (c: FakeChild) => c.event({ type: "error", message: "secret sk-auth v=0\n" }),
  ]) {
    const h = harness();
    const peer = await h.launch();
    emit(h.child);
    await flush();
    await peer.close();
    await assert.rejects(peer.offer);
    assert.equal(h.errors.length, 1);
    assert.equal(h.closed, 1);
    assert.doesNotMatch(h.errors[0].message, /secret|sk-auth|v=0|xxxx/);
  }
});

test("unsupported versions, helper failures and process failures settle startup once", async () => {
  for (const action of [
    (c: FakeChild) => c.event({ type: "ready", version: 5 }),
    (c: FakeChild) => c.event({ type: "error", message: "permission denied secret" }),
    (c: FakeChild) => c.emit("error", new Error("secret")),
    (c: FakeChild) => c.emit("close", 1, null),
  ]) {
    const h = harness();
    action(h.child);
    await assert.rejects(h.setup);
    assert.equal(h.errors.length, 1);
    assert.equal(h.closed, 1);
    assert.doesNotMatch(h.errors[0].message, /secret/);
    if (/denied/.test(h.errors[0].message)) assert.match(h.errors[0].message, /Privacy & Security > Microphone/);
  }
});

test("startup and offer deadlines clean up and reject pending promises", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startup = harness();
    t.mock.timers.tick(5_000);
    await assert.rejects(startup.setup, /startup timed out/);
    assert.equal(startup.errors.length, 1);
    const h = harness();
    const peer = await h.launch();
    t.mock.timers.tick(14_999);
    assert.equal(h.errors.length, 0);
    t.mock.timers.tick(1);
    await assert.rejects(peer.offer, /offer timed out/);
    await peer.close();
    assert.equal(h.errors.length, 1);
  } finally { t.mock.timers.reset(); }
});

test("shutdown escalates TERM then KILL and waits for reaping, ignoring late events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = harness();
    h.child.autoClose = false;
    h.child.closeOnKill = false;
    const peer = await h.launch();
    const closing = peer.close();
    let done = false;
    void closing.then(() => { done = true; });
    assert.equal(h.closed, 0);
    t.mock.timers.tick(1_499);
    assert.deepEqual(h.child.kills, []);
    t.mock.timers.tick(1);
    assert.deepEqual(h.child.kills, ["SIGTERM"]);
    assert.equal(done, false);
    t.mock.timers.tick(1_000);
    assert.equal(done, false);
    assert.equal(h.closed, 0);
    h.child.emit("close", null, "SIGKILL");
    await closing;
    assert.deepEqual(h.child.kills, ["SIGTERM", "SIGKILL"]);
    assert.equal(h.closed, 1);
    await assert.rejects(peer.offer, /closed/);
    h.child.event({ type: "error", message: "late" });
    h.child.event({ type: "state", state: "ready" });
    h.child.emit("error", new Error("late"));
    assert.equal(h.errors.length, 0);
    assert.equal(h.ready, 0);
    t.mock.timers.tick(60_000);
    assert.equal(h.child.kills.length, 2);
  } finally { t.mock.timers.reset(); }
});

test("cancellation before, during and after launch settles all pending work", async () => {
  const pre = new AbortController();
  pre.abort();
  let spawned = false;
  await assert.rejects(createNativePeer({ onEvent() {}, onReady() {}, onError() {}, onClosed() {} }, pre.signal, {
    platform: "darwin", spawnProcess: (() => { spawned = true; }) as unknown as typeof spawn,
  }), /aborted/);
  assert.equal(spawned, false);
  const early = harness();
  early.controller.abort();
  await assert.rejects(early.setup, /closed/);
  assert.equal(early.errors.length, 0);
  assert.equal(early.closed, 1);
  const h = harness();
  const peer = await h.launch();
  h.controller.abort();
  await assert.rejects(peer.offer, /closed/);
  await peer.close();
  assert.equal(h.errors.length, 0);
  assert.equal(h.closed, 1);
});

test("terminal connection states and EPIPE stop the helper exactly once", async () => {
  for (const state of ["failed", "disconnected", "closed", "EPIPE"]) {
    const h = await connected();
    if (state === "EPIPE") h.child.stdin.emit("error", new Error("secret EPIPE"));
    else h.child.event({ type: "state", state });
    await h.peer.close();
    assert.equal(h.errors.length, 1);
    assert.equal(h.child.commands.at(-1)?.type, "shutdown");
  }
});

test("outgoing command and queue bounds throw instead of silently dropping", async () => {
  const h = await connected();
  assert.throws(() => h.peer.sendData("x".repeat(64 * 1024)), /size limit/);
  assert.throws(() => h.peer.sendData({ self: 1n }), /encode/);
  h.child.holdWrites = true;
  for (let i = 0; i < 8; i++) h.peer.sendData("x".repeat(63 * 1024));
  assert.throws(() => h.peer.sendData("x".repeat(63 * 1024)), /queue/);
  // Release writes so the fake can process shutdown and emit close.
  h.child.holdWrites = false;
  h.child.writes.shift()?.();
  await h.peer.close();
  assert.equal(h.errors.length, 1);
});

test("answer validation and escaped SDP command limit", async () => {
  const h = harness();
  const peer = await h.launch();
  h.child.event({ type: "offer", sdp: "v=0\n" });
  await peer.offer;
  assert.throws(() => peer.applyAnswer("invalid"));
  assert.throws(() => peer.applyAnswer(`v=0\n${"x".repeat(256 * 1024)}`));
  assert.throws(() => peer.applyAnswer(`v=0\n${"\u0001".repeat(100_000)}`), /size limit/);
  peer.applyAnswer(`v=0\n${"x".repeat(200_000)}`);
  await peer.close();
});

test("throwing consumer callbacks cannot escape helper handlers", async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const throws = () => { throw new Error("consumer"); };
  const setup = createNativePeer({ onEvent: throws, onReady: throws, onError: throws, onClosed: throws }, controller.signal, {
    platform: "darwin", binary: "/injected/helper", spawnProcess: (() => child) as unknown as typeof spawn,
  });
  child.event({ type: "ready", version: 6 });
  const peer = await setup;
  child.event({ type: "offer", sdp: "v=0\n" });
  await peer.offer;
  peer.applyAnswer("v=0\n");
  child.event({ type: "state", state: "ready" });
  child.event({ type: "data", message: {} });
  child.event({ type: "error", message: "secret" });
  await peer.close();
  await flush();
});

test("chosen device IDs pass unchanged, absent directions stay omitted, and selection is snapshotted", async () => {
  for (const selection of [
    {}, { microphone: "input:id" }, { speaker: "output:id" },
    { microphone: "CoreAudio:🎙️", speaker: 'id:"\\speaker' },
    { microphone: "é".repeat(256), speaker: "x".repeat(512) },
  ] satisfies NativeAudioSelection[]) {
    const h = harness(new FakeChild(), selection);
    const peer = await h.launch();
    assert.deepEqual(h.child.commands, [{ type: "start_v3", ...selection }]);
    await peer.close();
  }
  const child = new FakeChild();
  const options: NativePeerOptions = {
    platform: "darwin", microphone: "chosen",
    spawnProcess: (() => child) as unknown as typeof spawn,
  };
  const setup = createNativePeer({ onEvent() {}, onReady() {}, onError() {}, onClosed() {} }, new AbortController().signal, options);
  options.microphone = "changed";
  child.event({ type: "ready", version: 6 });
  const peer = await setup;
  assert.deepEqual(child.commands[0], { type: "start_v3", microphone: "chosen" });
  await peer.close();
});

test("invalid selections reject before spawning and unavailable devices never retry defaults", async () => {
  for (const key of ["microphone", "speaker"]) {
    for (const value of [null, 1, {}, "", "x".repeat(513), "é".repeat(257), "secret\n", "secret\u001b", "secret\u009b", "secret\u202e"]) {
      let spawns = 0;
      await assert.rejects(createNativePeer({ onEvent() {}, onReady() {}, onError() {}, onClosed() {} }, new AbortController().signal, {
        platform: "darwin", [key]: value,
        spawnProcess: (() => { spawns++; }) as unknown as typeof spawn,
      } as NativePeerOptions), (error: Error) => {
        assert.match(error.message, /Invalid native audio .* device ID/);
        assert.doesNotMatch(error.message, /secret|xxxx|é/);
        return true;
      });
      assert.equal(spawns, 0);
    }
  }
  const h = harness(new FakeChild(), { microphone: "missing-input", speaker: "missing-output" });
  const peer = await h.launch();
  h.child.event({ type: "error", message: "secret selected device unavailable" });
  await assert.rejects(peer.offer, /audio error/);
  await peer.close();
  assert.deepEqual(h.child.commands, [
    { type: "start_v3", microphone: "missing-input", speaker: "missing-output" }, { type: "shutdown" },
  ]);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(h.errors[0].message, /secret|missing/);
});
