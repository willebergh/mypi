import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceRouter, VoiceReapError } from "../extensions/talk/voice-routing.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function setup(overrides: Partial<Parameters<typeof createVoiceRouter<string, { name: string }>>[0]> = {}) {
  const events: string[] = [];
  const controller = new AbortController();
  const router = createVoiceRouter<string, { name: string }>({ main: "main", signal: controller.signal, timeoutMs: 60_000,
    async start(name) { events.push(`start:${name}`); return { name }; },
    async close(leg) { events.push(`close:${leg.name}`); },
    gate(leg, enabled) { events.push(`audio:${leg.name}:${enabled}`); }, pending: () => false,
    introduce() {}, notice(_leg, text) { events.push(text); }, changed(name) { events.push(`route:${name}`); }, expired() {}, ...overrides,
  });
  return { router, events, controller };
}

test("stable FaceTime handle reaps old leg before creating or enabling replacement; no hangup operation", async t => {
  const reaped = deferred();
  const h = setup({ async close(leg) { if (leg.name === "main") await reaped.promise; } });
  t.after(() => h.router.handle.stop());
  const handle = await h.router.start();
  handle.setAudioEnabled(true);
  const transfer = h.router.transfer("target");
  await Promise.resolve();
  assert.ok(!h.events.includes("start:target"));
  assert.equal(h.events.at(-1), "audio:main:false");
  reaped.resolve(); await transfer;
  assert.equal(handle, h.router.handle);
  assert.deepEqual(h.events.slice(-3), ["route:target", "start:target", "audio:target:true"]);
  assert.equal(h.router.target(), "target");
});

test("questionnaire blocks transfer before teardown", async t => {
  const h = setup({ pending: () => true }); t.after(() => h.router.handle.stop());
  await h.router.start();
  await assert.rejects(h.router.transfer("target"), /questionnaire/);
  assert.ok(!h.events.some(value => value.startsWith("close:")));
});

test("destination loss returns to fresh main with notice, without replaying anything", async t => {
  const h = setup(); t.after(() => h.router.handle.stop());
  const handle = await h.router.start(); handle.setAudioEnabled(true);
  await h.router.transfer("target");
  await h.router.lost("unrelated"); assert.equal(h.router.target(), "target");
  await h.router.lost("target");
  assert.equal(h.router.target(), "main");
  assert.match(h.events.at(-1)!, /not cancelled or replayed/);
  assert.equal(h.events.filter(value => value === "start:main").length, 2);
});

test("cancel during replacement startup reaps late peer, never enables its audio, resets route", async () => {
  const ready = deferred();
  const h = setup({ async start(name) { if (name === "target") await ready.promise; return { name }; } });
  await h.router.start(); h.router.handle.setAudioEnabled(true);
  const transfer = h.router.transfer("target");
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const stopping = h.router.handle.stop();
  ready.resolve(); await Promise.all([assert.rejects(transfer, /cancelled|superseded/), stopping]);
  assert.ok(h.events.includes("close:target"));
  assert.ok(!h.events.includes("audio:target:true"));
  assert.equal(h.router.target(), "main");
});

test("replacement failure falls back to fresh main; failed reap never creates another peer", async t => {
  const h = setup({ async start(name) { if (name === "target") throw new Error("gone"); return { name }; } });
  t.after(() => h.router.handle.stop());
  await h.router.start();
  await assert.rejects(h.router.transfer("target"), /gone/);
  assert.equal(h.router.target(), "main");
  assert.match(h.events.at(-1)!, /no task was replayed/);
  const broken = setup({ async close() { throw new Error("not reaped"); } });
  await broken.router.start();
  await assert.rejects(broken.router.transfer("target"), /not reaped/);
  await assert.rejects(broken.router.transfer("main"), /unavailable/);
  await assert.rejects(broken.router.transfer("target"), /unavailable/);
  assert.equal(broken.events.filter(value => value.startsWith("start:")).length, 1);
  await broken.router.handle.stop();
});

test("failed destination and fallback leave a recoverable empty leg; retry same main target", async t => {
  let failing = false;
  const h = setup({ async start(name) { if (failing) throw new Error("startup failed"); return { name }; } });
  t.after(() => h.router.handle.stop());
  await h.router.start(); h.router.handle.setAudioEnabled(true);
  failing = true;
  await assert.rejects(h.router.transfer("target"), /startup failed/);
  assert.equal(h.router.available(), false);
  assert.equal(h.router.recoverable(), true);
  assert.equal(h.router.target(), "main");
  failing = false;
  await h.router.transfer("main");
  assert.equal(h.router.available(), true);
  assert.equal(h.events.at(-1), "audio:main:true");
});

test("failed startup reaping forbids fallback and every later retry", async t => {
  const starts: string[] = [];
  const h = setup({ async start(name) {
    starts.push(name);
    if (name === "target") throw new VoiceReapError("startup peer could not be reaped");
    return { name };
  } });
  t.after(() => h.router.handle.stop());
  await h.router.start();
  await assert.rejects(h.router.transfer("target"), /could not be reaped/);
  assert.equal(h.router.recoverable(), false);
  await assert.rejects(h.router.transfer("main"), /unavailable/);
  await assert.rejects(h.router.transfer("other"), /unavailable/);
  assert.deepEqual(starts, ["main", "target"]);
});

test("call deadline is not extended by transfer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let expired = 0;
  const h = setup({ timeoutMs: 600_000, expired() { expired++; } });
  await h.router.start();
  t.mock.timers.tick(599_000);
  await h.router.transfer("target");
  t.mock.timers.tick(1_000);
  assert.equal(expired, 1);
  await h.router.handle.stop();
  assert.equal(h.router.target(), "main");
});
