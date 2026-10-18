import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { listNativeDevices } from "../extensions/talk/native-peer.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: Record<string, unknown>[] = [];
  kills: unknown[] = [];
  autoClose = true;
  stdin = new Writable({
    write: (chunk, _encoding, done) => { this.commands.push(JSON.parse(chunk.toString())); done(); },
    final: (done) => {
      done();
      if (this.autoClose) queueMicrotask(() => this.emit("close", 0, null));
    },
  });
  kill(signal: unknown) { this.kills.push(signal); return true; }
  event(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

function discovery() {
  const child = new FakeChild();
  const controller = new AbortController();
  const calls: unknown[][] = [];
  const setup = listNativeDevices(controller.signal, {
    platform: "darwin",
    spawnProcess: ((...args: unknown[]) => { calls.push(args); return child; }) as unknown as typeof spawn,
  });
  void setup.catch(() => {});
  return { child, controller, calls, setup };
}

const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
const device = { id: "CoreAudio:device-1", name: "USB 🎙️", is_default: true };
const deviceList = { type: "devices", inputs: [device], outputs: [] };

test("discovery lists only after ready, sanitizes labels, and reaps before resolving without opening audio", async () => {
  const h = discovery();
  h.child.autoClose = false;
  assert.deepEqual(h.child.commands, []);
  const bytes = Buffer.from(`${JSON.stringify({ type: "ready", version: 7 })}\n${JSON.stringify({
    ...deviceList, outputs: [{ ...device, name: "Speaker\u001b[31m\u009b\r\n\t\u202e\u2028\u0007" }],
  })}\n`);
  // Both combined events and split UTF-8 must frame correctly.
  for (const byte of bytes) h.child.stdout.write(Buffer.from([byte]));
  assert.deepEqual(h.child.commands, [{ type: "list_devices" }, { type: "shutdown" }]);
  let done = false;
  void h.setup.then(() => { done = true; });
  await flush();
  assert.equal(done, false);
  h.child.emit("close", 0, null);
  const devices = await h.setup;
  assert.deepEqual(devices.inputs, [device]);
  assert.equal(devices.outputs[0].name, "Speaker [31m");
  assert.equal(devices.outputs[0].id, device.id);
  assert.equal(h.child.stdin.writableEnded, true);
  assert.deepEqual(h.child.kills, []);
  h.child.event({ type: "error", message: "late secret" });
  h.child.emit("error", new Error("late secret"));
});

test("discovery accepts empty lists and maximum per-direction count/UTF-8 bounds", async () => {
  for (const entries of [[], Array.from({ length: 128 }, (_, index) => ({
    id: `${index}`.padEnd(512, "x"), name: "é".repeat(256), is_default: false,
  }))]) {
    const h = discovery();
    h.child.event({ type: "ready", version: 7 });
    h.child.event({ type: "devices", inputs: entries, outputs: entries });
    assert.deepEqual(await h.setup, { inputs: entries, outputs: entries });
    assert.deepEqual(h.child.commands, [{ type: "list_devices" }, { type: "shutdown" }]);
  }
});

test("discovery rejects malformed ordering, fields, counts, byte limits and unsafe IDs with redacted errors", async () => {
  const malformed: unknown[] = [
    null, [], {}, { type: "ready", version: 7 }, { type: "offer", sdp: "v=0\nsecret" },
    { ...deviceList, inputs: null }, { ...deviceList, outputs: {} },
    { ...deviceList, inputs: Array(129).fill(device) }, { ...deviceList, outputs: Array(129).fill(device) },
    ...[null, [], {}, { ...device, id: 1 }, { ...device, id: "" },
      { ...device, id: "x".repeat(513) }, { ...device, id: "é".repeat(257) },
      { ...device, id: "secret\u001b" }, { ...device, id: "secret\u009b" },
      { ...device, id: "secret\u202e" }, { ...device, id: "secret\n" },
      { ...device, name: 1 }, { ...device, name: "é".repeat(257) },
      { ...device, is_default: "true" },
    ].map((entry) => ({ ...deviceList, inputs: [entry] })),
    { type: "error", message: "secret sk-key v=0\n" },
  ];
  for (const event of malformed) {
    const h = discovery();
    h.child.event({ type: "ready", version: 7 });
    h.child.event(event);
    await assert.rejects(h.setup, (error: Error) => {
      assert.doesNotMatch(error.message, /secret|sk-key|v=0|xxxx|é/);
      return true;
    });
    assert.deepEqual(h.child.commands, [{ type: "list_devices" }, { type: "shutdown" }]);
    assert.equal(h.child.stdin.writableEnded, true);
  }
  for (const event of [deviceList, { type: "ready", version: 5 }]) {
    const h = discovery();
    h.child.event(event);
    await assert.rejects(h.setup, /protocol/);
    assert.deepEqual(h.child.commands, [{ type: "shutdown" }]);
  }
});

test("discovery bounds protocol lines before parsing and redacts stream/process errors", async () => {
  for (const action of [
    (c: FakeChild) => c.stdout.write("secret invalid JSON\n"),
    (c: FakeChild) => { c.stdout.write('{"type":"secret'); c.stdout.end(); },
    (c: FakeChild) => c.stdout.end(),
    (c: FakeChild) => c.stdout.write("x".repeat(512 * 1024 + 1)),
    (c: FakeChild) => { c.stdout.write("x".repeat(512 * 1024)); c.stdout.write("x"); },
    (c: FakeChild) => c.stdout.emit("error", new Error("secret")),
    (c: FakeChild) => c.stderr.emit("error", new Error("secret")),
    (c: FakeChild) => c.stdin.emit("error", new Error("secret")),
    (c: FakeChild) => c.emit("error", new Error("secret")),
    (c: FakeChild) => c.emit("close", 1, null),
  ]) {
    const h = discovery();
    h.child.event({ type: "ready", version: 7 });
    h.child.stderr.write("secret stderr sk-key v=0\n".repeat(50_000));
    action(h.child);
    await assert.rejects(h.setup, (error: Error) => {
      assert.doesNotMatch(error.message, /secret|sk-key|v=0|xxxx/);
      return true;
    });
    // A process already reported closed needs no stdin shutdown.
    if (h.child.commands.length > 1) assert.equal(h.child.stdin.writableEnded, true);
    assert.ok(h.child.commands.every((command) => ["list_devices", "shutdown"].includes(command.type as string)));
  }
});

test("discovery has bounded startup/list deadlines and cleans up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startup = discovery();
    t.mock.timers.tick(5_000);
    await assert.rejects(startup.setup, /startup timed out/);
    assert.deepEqual(startup.child.commands, [{ type: "shutdown" }]);
    const h = discovery();
    t.mock.timers.tick(4_999);
    h.child.event({ type: "ready", version: 7 });
    t.mock.timers.tick(4_999);
    assert.deepEqual(h.child.commands, [{ type: "list_devices" }]);
    t.mock.timers.tick(1);
    await assert.rejects(h.setup, /device discovery timed out/);
    assert.equal(h.child.commands.at(-1)?.type, "shutdown");
    t.mock.timers.tick(60_000);
    assert.deepEqual(h.child.kills, []);
  } finally { t.mock.timers.reset(); }
});

test("discovery aborts before ready or during listing and waits for TERM/KILL reaping", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const ready of [false, true]) {
      const h = discovery();
      h.child.autoClose = false;
      if (ready) h.child.event({ type: "ready", version: 7 });
      let settled = false;
      void h.setup.then(() => { settled = true; }, () => { settled = true; });
      h.controller.abort();
      h.child.event(deviceList);
      t.mock.timers.tick(1_500);
      assert.deepEqual(h.child.kills, ["SIGTERM"]);
      t.mock.timers.tick(1_000);
      assert.deepEqual(h.child.kills, ["SIGTERM", "SIGKILL"]);
      await flush();
      assert.equal(settled, false);
      h.child.emit("close", null, "SIGKILL");
      await assert.rejects(h.setup, /closed|aborted/);
      assert.equal(h.child.commands.at(-1)?.type, "shutdown");
      t.mock.timers.tick(60_000);
      assert.equal(h.child.kills.length, 2);
    }
  } finally { t.mock.timers.reset(); }
});

test("discovery never spawns when aborted/unsupported, and redacts synchronous launch errors", async () => {
  let spawns = 0;
  const spawnProcess = (() => { spawns++; throw new Error("secret path"); }) as unknown as typeof spawn;
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(listNativeDevices(pre.signal, { platform: "darwin", spawnProcess }), /aborted/);
  await assert.rejects(listNativeDevices(new AbortController().signal, { platform: "linux", spawnProcess }), /macOS/);
  assert.equal(spawns, 0);
  await assert.rejects(listNativeDevices(new AbortController().signal, { platform: "darwin", spawnProcess }), (error: Error) => {
    assert.match(error.message, /\/skill:setup/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(spawns, 1);
});

test("discovery uses the same binary/pipes/environment allowlist, never credentials", async (t) => {
  const keys = ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"];
  for (const key of keys) {
    const previous = process.env[key];
    process.env[key] = "secret";
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const child = new FakeChild();
  let options: { env: NodeJS.ProcessEnv; stdio: string[] } | undefined;
  const setup = listNativeDevices(new AbortController().signal, {
    platform: "darwin", binary: "/injected/helper",
    spawnProcess: ((binary: string, args: string[], opts: typeof options) => {
      assert.equal(binary, "/injected/helper");
      assert.deepEqual(args, []);
      options = opts;
      return child;
    }) as unknown as typeof spawn,
  });
  child.event({ type: "ready", version: 7 });
  child.event(deviceList);
  await setup;
  assert.deepEqual(options?.stdio, ["pipe", "pipe", "pipe"]);
  const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME"];
  assert.deepEqual(Object.keys(options!.env).sort(), allowed.filter((key) => process.env[key] !== undefined).sort());
  for (const key of keys) assert.equal(options!.env[key], undefined);
});
