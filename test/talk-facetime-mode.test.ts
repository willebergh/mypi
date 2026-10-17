import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFaceTimeMode, acquireFaceTimeLease, type FaceTimeModeOptions, type FaceTimeVoiceHandle } from "../extensions/talk/facetime-mode.ts";
import { type FaceTimeClient, type FaceTimeClientCallbacks, type FaceTimeRecord, type FaceTimeSnapshot } from "../extensions/talk/facetime-client.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let n = 0; n < 12; n++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const routing = { input: "Agent Output", output: "Agent Input" };
function snapshot(call: FaceTimeRecord = { phase: "idle" }, extra: FaceTimeRecord = {}): FaceTimeSnapshot {
  return { type: "snapshot", protocolVersion: 1, serviceInstanceId: "service-a", seq: 0,
    permission: { trusted: true }, configuration: { autoAnswer: false }, call: { phase: "idle", ...call }, ...extra } as FaceTimeSnapshot;
}
class Voice implements FaceTimeVoiceHandle {
  gates: boolean[] = [];
  stops = 0;
  introductions = 0;
  purposes: (string | undefined)[] = [];
  setAudioEnabled(enabled: boolean) { this.gates.push(enabled); }
  introduceOutgoingCall(purpose?: string) { assert.equal(this.gates.at(-1), true); this.introductions++; this.purposes.push(purpose); }
  async stop() { this.stops++; }
}
class FakeClient implements FaceTimeClient {
  commands: { command: string; args?: FaceTimeRecord }[] = [];
  closed = false;
  sequence = 0;
  current = snapshot();
  handler?: (command: string, args?: FaceTimeRecord) => Promise<unknown>;
  readonly callbacks: FaceTimeClientCallbacks;
  constructor(callbacks: FaceTimeClientCallbacks) { this.callbacks = callbacks; }
  async connect() { this.callbacks.onSnapshot(this.current); return this.current; }
  async request(command: string, args?: FaceTimeRecord): Promise<unknown> {
    this.commands.push({ command, args });
    if (this.handler) return this.handler(command, args);
    if (command === "audio.devices") return { devices: [
      { section: "input", name: routing.input, selected: true, enabled: true },
      { section: "output", name: routing.output, selected: true, enabled: true },
    ] };
    if (command === "call") return { callId: "outgoing-1" };
    return {};
  }
  event(event: string, extra: FaceTimeRecord = {}) {
    this.callbacks.onEvent({ type: "event", protocolVersion: 1, serviceInstanceId: this.current.serviceInstanceId,
      seq: ++this.sequence, event, callId: "incoming-1", direction: "incoming", identity: "Synthetic Caller", ...extra });
  }
  disconnect() { this.callbacks.onDisconnect(new Error("synthetic disconnect")); }
  reconnect(call: FaceTimeRecord = { phase: "idle" }, extra: FaceTimeRecord = {}) {
    this.current = snapshot(call, { seq: this.sequence, ...extra });
    this.callbacks.onSnapshot(this.current);
  }
  close() { this.closed = true; }
  mutations() { return this.commands.filter((entry) => ["call", "answer", "hangup"].includes(entry.command)); }
}
function harness(t: test.TestContext, extra: Partial<FaceTimeModeOptions> = {}, initial = snapshot()) {
  const voices: Voice[] = [];
  const signals: AbortSignal[] = [];
  const errors: Error[] = [];
  const events: FaceTimeRecord[] = [];
  let client!: FakeClient;
  let leases = 0;
  const mode = createFaceTimeMode({ routing, prepareVoice: async (signal) => {
    signals.push(signal);
    const voice = new Voice(); voices.push(voice); return voice;
  }, acquireLease: () => { leases++; return () => { leases--; }; },
  createClient: (callbacks) => { client = new FakeClient(callbacks); client.current = initial; return client; },
  onError: (error) => errors.push(error), onEvent: (event) => events.push(event), ...extra });
  t.after(() => mode.disable());
  return { mode, voices, signals, errors, events, get client() { return client; }, get leases() { return leases; } };
}
async function incomingReady(t: test.TestContext) {
  const h = harness(t);
  await h.mode.enable();
  h.client.event("call.incoming", { allowed: true });
  await flush();
  return h;
}
async function connected(t: test.TestContext) {
  const h = await incomingReady(t);
  h.client.event("call.connected", { verified: true });
  return h;
}

test("only owned terminal call events notify context, once and after voice teardown starts", async (t) => {
  const ended: FaceTimeRecord[] = [];
  const h = harness(t, { onCallEnded(event) {
    assert.equal(h.voices.at(-1)?.stops, 1);
    assert.equal(h.mode.status().phase, "standby");
    ended.push(event);
  } });
  await h.mode.enable();
  h.client.event("call.ended", { callId: "unrelated" });
  assert.equal(ended.length, 0);
  h.client.event("call.incoming", { allowed: true });
  await flush();
  h.client.event("call.ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].event, "call.ended");
  h.client.event("call.ended");
  assert.equal(ended.length, 1, "duplicate terminal evidence must not schedule duplicate turns");
});

test("FaceTime enable checks policy/routing before standby and never takes over a busy service", async (t) => {
  const h = harness(t);
  await h.mode.enable();
  assert.deepEqual(h.client.commands.map((c) => c.command), ["audio.select", "audio.devices"]);
  assert.deepEqual(h.client.commands[0].args, routing);
  assert.equal(h.mode.status().phase, "standby");
  assert.equal(h.mode.status().connected, true);
  assert.equal(h.voices.length, 0);
  assert.equal(h.leases, 1);
  await h.mode.disable();
  assert.equal(h.leases, 0);
  assert.equal(h.client.closed, true);
  for (const initial of [
    snapshot({ phase: "incoming", callId: "manual", allowed: true }),
    snapshot({ phase: "connected", callId: "manual", verified: true }),
    snapshot(undefined, { permission: { trusted: false } }),
    snapshot(undefined, { configuration: { autoAnswer: true } }),
    snapshot(undefined, { configuration: {} }),
  ]) {
    const blocked = harness(t, {}, initial);
    await assert.rejects(blocked.mode.enable(), /active call|Accessibility|autoAnswer=false/);
    assert.equal(blocked.leases, 0);
    assert.equal(blocked.voices.length, 0);
    assert.deepEqual(blocked.client.mutations(), []);
    assert.equal(blocked.mode.status().enabled, false);
  }
});

test("FaceTime routing must verify exact, unambiguous selected marks and gives actionable open-app error", async (t) => {
  for (const devices of [[], [
    { section: "input", name: "agent output", selected: true, enabled: true },
    { section: "output", name: routing.output, selected: true, enabled: true },
  ], [
    { section: "input", name: routing.input, selected: true, enabled: true },
    { section: "input", name: "other", selected: true, enabled: true },
  ]]) {
    const h = harness(t, { createClient(callbacks) {
      const client = new FakeClient(callbacks);
      client.handler = async () => ({ devices });
      return client;
    } });
    await assert.rejects(h.mode.enable(), /Open FaceTime.*exact device name/);
    assert.equal(h.voices.length, 0);
  }
});

test("FaceTime autoanswer is fail-closed, prepares first, answers once and gates until verified connection", async (t) => {
  const preparation = deferred<FaceTimeVoiceHandle>();
  let prepares = 0;
  const h = harness(t, { prepareVoice: async () => { prepares++; return preparation.promise; } });
  await h.mode.enable();
  h.client.event("call.incoming");
  h.client.event("call.incoming", { allowed: false });
  await flush();
  assert.equal(prepares, 0);
  h.client.event("call.incoming", { allowed: true });
  h.client.event("call.incoming", { allowed: true });
  const answering = h.mode.answer();
  await flush();
  assert.equal(prepares, 1);
  assert.equal(h.client.mutations().length, 0);
  const voice = new Voice();
  preparation.resolve(voice);
  await answering;
  assert.deepEqual(voice.gates, [false]);
  assert.deepEqual(h.client.mutations().map((c) => c.command), ["answer"]);
  await h.mode.answer();
  h.client.event("call.answer_attempted", { verified: true });
  h.client.event("call.connected", { verified: false });
  assert.deepEqual(voice.gates, [false]);
  h.client.event("call.connected", { verified: true });
  assert.deepEqual(voice.gates, [false, true]);
  assert.equal(h.mode.status().phase, "connected");
  h.client.event("call.ended");
  await flush();
  assert.equal(voice.stops, 1);
  assert.equal(voice.gates.at(-1), false);
  assert.equal(h.mode.status().phase, "standby");
});

test("shared-config mode reloads the same file at idle and verifies routing without duplicate audio.select", async (t) => {
  const configPath = "/synthetic/talk.json";
  const initial = snapshot(undefined, { configuration: { autoAnswer: false, configPath, inputDevice: "Previous output", outputDevice: "Previous input" } });
  const h = harness(t, { configPath }, initial);
  const enabling = h.mode.enable();
  h.client.handler = async (command) => {
    if (command === "config.reload") return snapshot(undefined, { configuration: { autoAnswer: false, configPath, inputDevice: routing.input, outputDevice: routing.output } });
    if (command === "audio.devices") return { devices: [
      { section: "input", name: routing.input, selected: true, enabled: true },
      { section: "output", name: routing.output, selected: true, enabled: true },
    ] };
    throw new Error(`unexpected command ${command}`);
  };
  await enabling;
  assert.deepEqual(h.client.commands.map(item => item.command), ["config.reload", "audio.devices"]);
  assert.equal(h.mode.status().phase, "standby");
  assert.equal(h.voices.length, 0);
});

test("shared config path mismatch or an active call never triggers reload or routing", async (t) => {
  const configPath = "/synthetic/talk.json";
  for (const initial of [
    snapshot(undefined, { configuration: { autoAnswer: false } }),
    snapshot(undefined, { configuration: { autoAnswer: false, configPath: "/other/talk.json" } }),
    snapshot({ phase: "connected", callId: "manual", verified: true }, { configuration: { autoAnswer: false, configPath } }),
  ]) {
    const h = harness(t, { configPath }, initial);
    await assert.rejects(h.mode.enable(), /shared Talk config|active call/);
    assert.deepEqual(h.client.commands, []);
    assert.equal(h.voices.length, 0);
    assert.equal(h.leases, 0);
  }
});

test("FaceTime outgoing prepares gated voice, sends once and only adopts its response callId", async (t) => {
  const h = harness(t);
  await h.mode.enable();
  await h.mode.call("synthetic@example.invalid");
  assert.deepEqual(h.voices[0].gates, [false]);
  assert.deepEqual(h.client.mutations(), [{ command: "call", args: { to: "synthetic@example.invalid" } }]);
  await assert.rejects(h.mode.call("second@example.invalid"), /already active/);
  h.client.event("call.dialing", { callId: "outgoing-1", direction: "outgoing" });
  h.client.event("call.connected", { callId: "outgoing-1", direction: "outgoing", verified: true });
  assert.equal(h.voices[0].gates.at(-1), true);
  h.client.event("call.failed", { callId: "outgoing-1" });
  await flush();
  assert.equal(h.voices[0].stops, 1);
  assert.equal(h.mode.status().phase, "standby");
  assert.equal(h.client.mutations().length, 1);
});

test("outgoing introductions require verified audio and happen once per call, not per reconnect", async (t) => {
  const h = harness(t);
  await h.mode.enable();
  await h.mode.call("synthetic@example.invalid", "The requested checks passed; share the verified result.");
  assert.equal(h.voices[0].introductions, 0);
  h.client.event("call.dialing", { callId: "outgoing-1", direction: "outgoing" });
  h.client.event("call.connected", { callId: "outgoing-1", direction: "outgoing", verified: false });
  assert.equal(h.voices[0].introductions, 0);
  h.client.event("call.connected", { callId: "outgoing-1", direction: "outgoing", verified: true });
  assert.equal(h.voices[0].introductions, 1);
  assert.deepEqual(h.voices[0].purposes, ["The requested checks passed; share the verified result."]);
  assert.deepEqual(h.client.mutations()[0].args, { to: "synthetic@example.invalid" }, "purpose stays local, not in the Swift dial command");
  h.client.event("call.connected", { callId: "outgoing-1", direction: "outgoing", verified: true });
  assert.equal(h.voices[0].introductions, 1);
  h.client.disconnect();
  h.client.reconnect({ phase: "connected", callId: "outgoing-1", direction: "outgoing", verified: true });
  await flush();
  assert.equal(h.voices[1].gates.at(-1), true);
  assert.equal(h.voices[1].introductions, 0, "fresh voice transport must not repeat the call's greeting");
  h.client.event("call.ended", { callId: "outgoing-1", direction: "outgoing" });
  await h.mode.call("synthetic@example.invalid");
  h.client.event("call.connected", { callId: "outgoing-1", direction: "outgoing", verified: true });
  assert.equal(h.voices[2].introductions, 1, "a new call gets a new introduction");
});

test("invalid call purposes fail before voice preparation or dialing", async (t) => {
  const h = harness(t);
  await h.mode.enable();
  for (const purpose of ["", " ", "x".repeat(301), "😀".repeat(76), "bad\x1btext", "bad\u202etext"]) {
    await assert.rejects(h.mode.call("synthetic@example.invalid", purpose), /call purpose/);
  }
  assert.equal(h.voices.length, 0);
  assert.deepEqual(h.client.mutations(), []);
});

test("incoming and failed outgoing calls do not get an outgoing introduction", async (t) => {
  const incoming = await connected(t);
  assert.equal(incoming.voices[0].introductions, 0);
  const failed = harness(t);
  await failed.mode.enable();
  await failed.mode.call("synthetic@example.invalid");
  failed.client.event("call.failed", { callId: "outgoing-1", direction: "outgoing" });
  assert.equal(failed.voices[0].introductions, 0);
});

test("FaceTime cancellation during preparation stops late handles and never answers stale calls", async (t) => {
  for (const cancel of ["ended", "failed", "new-call", "disconnect", "disable", "voiceEnded", "manual-connect"]) {
    const preparation = deferred<FaceTimeVoiceHandle>();
    let signal!: AbortSignal;
    const h = harness(t, { prepareVoice: async (s) => { signal = s; return preparation.promise; } });
    await h.mode.enable();
    h.client.event("call.incoming", { allowed: true });
    await flush();
    if (cancel === "new-call") h.client.event("call.incoming", { callId: "different", allowed: false });
    else if (cancel === "disconnect") h.client.disconnect();
    else if (cancel === "disable") await h.mode.disable();
    else if (cancel === "voiceEnded") await h.mode.voiceEnded();
    else if (cancel === "manual-connect") h.client.event("call.connected", { verified: true });
    else h.client.event(`call.${cancel}`);
    assert.equal(signal.aborted, true, cancel);
    const voice = new Voice();
    preparation.resolve(voice);
    await flush();
    assert.equal(voice.stops, 1, cancel);
    assert.equal(voice.gates.includes(true), false, cancel);
    assert.deepEqual(h.client.mutations(), [], cancel);
    if (cancel === "disconnect") assert.equal(h.mode.status().phase, "unavailable");
  }
});

test("FaceTime disconnect gates/stops immediately, retains lease and resumes only same owned verified call", async (t) => {
  const h = await connected(t);
  h.signals[0].addEventListener("abort", () => assert.equal(h.voices[0].gates.at(-1), false));
  h.client.disconnect();
  assert.equal(h.voices[0].gates.at(-1), false);
  assert.equal(h.voices[0].stops, 1);
  assert.equal(h.mode.status().phase, "unavailable");
  assert.equal(h.leases, 1);
  h.client.reconnect({ phase: "connected", callId: "incoming-1", verified: true });
  await flush();
  assert.equal(h.voices.length, 2);
  assert.equal(h.voices[1].gates.at(-1), true);
  assert.equal(h.client.commands.filter((c) => c.command === "audio.select").length, 1); // No routing mutation replay either.
  assert.deepEqual(h.client.mutations().map((c) => c.command), ["answer"]);
  h.client.disconnect();
  h.client.reconnect({ phase: "connected", callId: "incoming-1", verified: true }, { serviceInstanceId: "service-b" });
  await flush();
  assert.equal(h.voices.length, 2);
  assert.equal(h.mode.status().phase, "busy");
  await h.mode.disable();
  assert.deepEqual(h.client.mutations().map((c) => c.command), ["answer"]);
});

test("FaceTime reconnect snapshots never autoanswer existing incoming calls, but new incoming events can", async (t) => {
  const h = harness(t);
  await h.mode.enable();
  h.client.disconnect();
  h.client.reconnect({ phase: "incoming", callId: "existing", allowed: true });
  await flush();
  h.client.event("call.incoming", { callId: "existing", allowed: true });
  await flush();
  assert.equal(h.voices.length, 0);
  h.client.event("call.incoming", { callId: "new", allowed: true });
  await flush();
  assert.equal(h.voices.length, 1);
  assert.deepEqual(h.client.mutations().map((c) => c.command), ["answer"]);
});

test("FaceTime hangup/voiceEnded/disable stop only owned voice and send hangup at most once until evidence", async (t) => {
  const h = await connected(t);
  await h.mode.voiceEnded();
  await h.mode.hangup();
  assert.equal(h.voices[0].stops, 1);
  assert.equal(h.mode.status().phase, "ending");
  assert.deepEqual(h.client.mutations().map((c) => c.command), ["answer", "hangup"]);
  assert.equal(h.client.mutations().at(-1)?.args, undefined); // no expectedCallId
  h.client.event("call.ended");
  assert.equal(h.mode.status().phase, "standby");
  await h.mode.disable();
  assert.equal(h.client.mutations().length, 2);
  const second = await connected(t);
  await Promise.all([second.mode.disable(), second.mode.disable()]);
  assert.equal(second.voices[0].stops, 1);
  assert.equal(second.leases, 0);
  assert.deepEqual(second.client.mutations().map((c) => c.command), ["answer", "hangup"]);
});

test("FaceTime unrelated new call cancels owned voice without hanging up the replacement", async (t) => {
  const h = await connected(t);
  h.client.event("call.connected", { callId: "manual-other", verified: true });
  assert.equal(h.voices[0].stops, 1);
  assert.equal(h.mode.status().audioEnabled, false);
  await h.mode.hangup();
  await h.mode.disable();
  assert.deepEqual(h.client.mutations().map((c) => c.command), ["answer"]);
});

test("FaceTime service mutation failure is never retried and duplicate/AX events do not escape", async (t) => {
  const h = harness(t);
  await h.mode.enable();
  h.client.handler = async (command) => { if (command === "answer") throw new Error("synthetic timeout; outcome unknown"); return {}; };
  h.client.event("call.incoming", { allowed: true });
  await flush();
  h.client.event("call.incoming", { allowed: true });
  await flush();
  assert.equal(h.client.mutations().length, 1);
  h.client.callbacks.onEvent({ type: "event", protocolVersion: 1, serviceInstanceId: "service-a", seq: 1, event: "call.ended", callId: "incoming-1" });
  assert.notEqual(h.mode.status().phase, "standby");
  h.client.event("accessibility.reconciled", { tree: "private" });
  assert.equal(h.events.some((event) => "tree" in event || event.event === "accessibility.reconciled"), false);
});

test("FaceTime owner lease excludes other controllers, recovers only dead PID empty markers and releases safely", (t) => {
  const dir = mkdtempSync("/tmp/pi-ft-owner-");
  const path = join(dir, "s");
  const lock = `${path}.owner`;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = acquireFaceTimeLease(path);
  assert.throws(() => acquireFaceTimeLease(path), /ownership/);
  assert.ok(readdirSync(lock)[0].startsWith(`${process.pid}-`));
  release(); release();
  assert.equal(existsSync(lock), false);
  mkdirSync(lock);
  // Find a definitely absent positive PID, rather than assuming a fixed PID is dead.
  let dead = 2_000_000_000;
  while (true) { try { process.kill(dead, 0); dead--; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; } }
  mkdirSync(join(lock, `${dead}-${randomUUID()}`));
  const recovered = acquireFaceTimeLease(path);
  assert.ok(readdirSync(lock)[0].startsWith(`${process.pid}-`));
  recovered();
  mkdirSync(lock); // Interrupted acquisition is ambiguous, never guessed stale.
  assert.throws(() => acquireFaceTimeLease(path), /ambiguous/);
  rmSync(lock, { recursive: true });
  const target = join(dir, "do-not-touch"); mkdirSync(target);
  symlinkSync(target, lock);
  assert.throws(() => acquireFaceTimeLease(path), /ownership/);
  assert.equal(existsSync(target), true);
});

test("FaceTime permission revocation/missing allowed during preparation fails closed", async (t) => {
  const pending = deferred<FaceTimeVoiceHandle>();
  let signal!: AbortSignal;
  const h = harness(t, { prepareVoice: async (s) => { signal = s; return pending.promise; } });
  await h.mode.enable();
  h.client.event("call.incoming", { allowed: true });
  await flush();
  h.client.event("call.incoming"); // Must not inherit allowed=true from the previous event.
  assert.equal(signal.aborted, true);
  const voice = new Voice(); pending.resolve(voice);
  await flush();
  assert.equal(voice.stops, 1);
  assert.deepEqual(h.client.mutations(), []);
});

test("FaceTime old answer response failure cannot cancel a reconnected generation", async (t) => {
  const response = deferred<unknown>();
  const h = harness(t);
  await h.mode.enable();
  h.client.handler = async (command) => {
    if (command === "answer") return response.promise;
    if (command === "audio.devices") return { devices: [
      { section: "input", name: routing.input, selected: true, enabled: true },
      { section: "output", name: routing.output, selected: true, enabled: true },
    ] };
    return {};
  };
  h.client.event("call.incoming", { allowed: true });
  await flush();
  h.client.disconnect();
  h.client.reconnect({ phase: "connected", callId: "incoming-1", verified: true });
  await flush();
  assert.equal(h.voices.length, 2);
  response.reject(new Error("old connection rejected"));
  await flush();
  assert.equal(h.voices[1].stops, 0);
  assert.equal(h.mode.status().phase, "connected");
  assert.deepEqual(h.voices[1].gates, [false, true]);
});

test("FaceTime reentrant status cancellation cannot send an answer/call after disable", async (t) => {
  for (const phase of ["answering", "dialing"]) {
    const h = harness(t, { onStatus(status) { if (status.phase === phase) void h.mode.disable(); } });
    await h.mode.enable();
    if (phase === "answering") h.client.event("call.incoming", { allowed: true });
    else await assert.rejects(h.mode.call("synthetic@example.invalid"), /cancelled/);
    await flush();
    assert.deepEqual(h.client.mutations(), []);
    assert.equal(h.mode.status().phase, "disabled");
    assert.equal(h.leases, 0);
  }
  const h = harness(t, { onStatus(status) { if (status.phase === "ending") void h.mode.disable(); } });
  await h.mode.enable();
  h.client.event("call.incoming", { allowed: true }); await flush();
  await h.mode.disable();
  assert.deepEqual(h.client.mutations().map((c) => c.command), ["answer", "hangup"]);
});

test("FaceTime outgoing lifecycle can precede its response, but terminal evidence cancels adoption", async (t) => {
  for (const terminal of [false, true]) {
    const response = deferred<unknown>();
    const h = harness(t);
    await h.mode.enable();
    h.client.handler = async (command) => command === "call" ? response.promise : {};
    const calling = h.mode.call("synthetic@example.invalid");
    void calling.catch(() => {});
    await flush();
    h.client.event("call.connected", { callId: "response-id", direction: "outgoing", verified: true });
    assert.equal(h.voices[0].gates.includes(true), false);
    if (terminal) h.client.event("call.ended", { callId: "response-id", direction: "outgoing" });
    response.resolve({ callId: "response-id" });
    if (terminal) {
      await assert.rejects(calling, /cancelled/);
      assert.equal(h.voices[0].stops, 1);
      assert.equal(h.mode.status().phase, "standby");
    } else {
      await calling;
      assert.deepEqual(h.voices[0].gates, [false, true]);
    }
  }
});

test("FaceTime failed preparation is not automatically retried for the same call", async (t) => {
  let prepares = 0;
  const h = harness(t, { prepareVoice: async () => { prepares++; throw new Error("synthetic preparation failed"); } });
  await h.mode.enable();
  h.client.event("call.incoming", { allowed: true }); await flush();
  h.client.event("call.incoming", { allowed: true }); await flush();
  assert.equal(prepares, 1);
  assert.deepEqual(h.client.mutations(), []);
});

for (const action of ["hangup", "disable", "voiceEnded"] as const) {
  test(`FaceTime ${action} reconciles an in-flight outgoing submission before one deferred hangup`, async (t) => {
    const h = harness(t);
    await h.mode.enable();
    const response = deferred<unknown>();
    h.client.handler = async (command) => command === "call" ? response.promise : {};
    const calling = h.mode.call("+46000000000").catch(error => error);
    await flush();
    assert.deepEqual(h.client.mutations().map(item => item.command), ["call"]);
    let ended = false;
    const ending = h.mode[action]().then(() => { ended = true; });
    await flush();
    assert.equal(ended, false, "wait for bounded submission reconciliation before teardown");
    assert.equal(h.voices[0].stops, 1);
    assert.ok(h.voices[0].gates.every(value => !value));
    assert.equal(h.leases, 1);
    response.resolve({ callId: "late-outgoing" });
    await ending;
    const outcome = await calling;
    assert.ok(outcome instanceof Error);
    assert.match(outcome.message, /cancelled/);
    assert.deepEqual(h.client.mutations().map(item => item.command), ["call", "hangup"]);
    await h.mode.hangup();
    assert.deepEqual(h.client.mutations().map(item => item.command), ["call", "hangup"]);
    assert.equal(h.leases, action === "disable" ? 0 : 1);
  });
}

test("FaceTime disable after uncertain outgoing submission never retries or guesses a hangup target", async (t) => {
  const h = harness(t);
  await h.mode.enable();
  const response = deferred<unknown>();
  h.client.handler = async (command) => command === "call" ? response.promise : {};
  const calling = h.mode.call("+46000000000").catch(error => error);
  await flush();
  const ending = h.mode.disable();
  response.reject(new Error("FaceTime call timed out; outcome unknown"));
  await ending;
  const outcome = await calling;
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /outcome unknown/);
  assert.deepEqual(h.client.mutations().map(item => item.command), ["call"]);
  assert.equal(h.leases, 0);
  assert.equal(h.client.closed, true);
});

test("FaceTime real lease remains held during reconnect and another mode cannot enable", async (t) => {
  const dir = mkdtempSync("/tmp/pi-ft-modes-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "s");
  const first = harness(t, { socketPath, acquireLease: acquireFaceTimeLease });
  const second = harness(t, { socketPath, acquireLease: acquireFaceTimeLease });
  await first.mode.enable();
  first.client.disconnect();
  await assert.rejects(second.mode.enable(), /ownership/);
  await first.mode.disable();
  await second.mode.enable();
  await second.mode.disable();
});
