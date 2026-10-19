import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRemoteVoiceBackend, createSessionVoiceReceiver } from "../extensions/talk/session-voice.ts";
import { createVoiceRouter } from "../extensions/talk/voice-routing.ts";
import type { TalkJson, TalkSessionPeer } from "../extensions/talk/multisession-protocol.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// An in-memory main/receiver link exercises the public backend protocol, whether
// activation uses a notification or an acknowledged request. No native voice,
// sockets, calls, or Pi work is started.
function receiver(summarize: () => Promise<string | undefined> = async () => "Target summary") {
  const hooks = new Map<string, Function>();
  const sent: string[] = [];
  const output: Array<{ kind: string; id: string | null; text: string }> = [];
  const ctx = {
    cwd: "/target", isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] }, ui: { notify() {} },
  } as unknown as ExtensionContext;
  const pi = {
    on(event: string, handler: Function) { hooks.set(event, handler); },
    events: { on() {}, emit() {} },
    sendUserMessage(text: string) { sent.push(text); },
    appendEntry() {}, sendMessage() {},
  } as unknown as ExtensionAPI;
  const voice = createSessionVoiceReceiver(pi, {
    context: () => ctx, summarize, activity: () => "idle", name: () => "Target",
    send(_event, payload) { backend.receive(payload); },
  });
  const peer = {
    connected: true,
    request(method: string, payload: TalkJson) { return voice.request(method, payload); },
    notify(event: string, payload: TalkJson) { voice.event(event, payload); },
  } as unknown as TalkSessionPeer;
  const backend = createRemoteVoiceBackend(peer, (kind, id, text) => output.push({ kind, id, text }));
  return {
    voice, backend, sent, output,
    prepare: () => backend.prepare(new AbortController().signal),
    delegate(text: string, id = "task") {
      backend.event("delegate", [id, 0, text, { userTurnId: `user-${id}` }]);
    },
    question(start: boolean) {
      hooks.get(start ? "tool_execution_start" : "tool_execution_end")!({
        toolName: "ask_user", toolCallId: "question", result: {},
      });
    },
    close() { backend.close(); voice.close(); },
  };
}

// Positive control: the guards below must reject unsafe inputs, not accidentally
// pass because this fake connection cannot activate or dispatch any work.
test("review harness forwards an explicit remote task and main-side output", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = receiver(); t.after(() => h.close());
  await h.prepare();
  await h.backend.activate();
  h.voice.activity(["Target is ready"]);
  h.delegate("Inspect the target test suite");
  t.mock.timers.tick(0);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Inspect the target test suite/);
  assert.ok(h.output.some(event => event.kind === "thinking" && event.text === "Target is ready"));
});

test("idle remote destination must clarify vague go ahead without submitting Pi work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = receiver(); t.after(() => h.close());
  await h.prepare();
  await h.backend.activate();
  h.delegate("go ahead");
  t.mock.timers.tick(0);
  assert.deepEqual(h.sent, [], "vague approval is not a new task on an idle destination");
});

for (const key of ["talk_answer", "talk_task_answer"]) {
  test(`remote ${key} control with a JSON-escaped key never becomes Pi work`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = receiver(); t.after(() => h.close());
    await h.prepare();
    await h.backend.activate();
    // Keep an actual backslash-u escape on the wire, not a JS-decoded "a".
    const input = `{"${key.replace("answer", "\\u0061nswer")}":"retired-nonce","choice":1}`;
    assert.ok(input.includes("\\u0061"));
    assert.equal(JSON.parse(input)[key], "retired-nonce");
    h.delegate(input);
    t.mock.timers.tick(0);
    assert.deepEqual(h.sent, [], "retired questionnaire controls must be parsed and intercepted before the bridge");
  });
}

test("voice.prepare rechecks questionnaires that start during asynchronous summarization", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred<void>();
  const summary = deferred<string>();
  const h = receiver(() => { entered.resolve(); return summary.promise; });
  t.after(() => h.close());
  const preparing = h.prepare();
  // Attach the rejection assertion before resolving the delayed summary.
  const rejected = assert.rejects(preparing, /questionnaire/i);
  await entered.promise;
  h.question(true);
  assert.equal(h.voice.pending(), true);
  summary.resolve("Summary completed after ask_user started");
  await rejected;
  assert.equal(h.output.length, 0, "preparation alone must not emit main-side voice output");
  try { await h.backend.activate(); } catch { /* A rejected prepare cannot be activated. */ }
  const marker = "Activity from a rejected preparation";
  h.voice.activity([marker]);
  h.delegate("Inspect files on the rejected preparation", "rejected-prepare");
  t.mock.timers.tick(0);
  h.question(false);
  h.delegate("Inspect files after the rejected preparation", "expired-prepare");
  t.mock.timers.tick(0);
  assert.deepEqual(h.sent, [], "a rejected preparation must never become a work-capable voice scope");
  assert.ok(!h.output.some(event => event.text === marker));
});

test("questionnaire starting after prepare makes activation fail closed, including after the question ends", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = receiver(); t.after(() => h.close());
  await h.prepare();
  h.question(true);
  // Either an explicit activation rejection or a disabled receiver is safe.
  // Do not require a particular new activation RPC or error wording.
  try { await h.backend.activate(); } catch { /* Expected for acknowledged refusal. */ }
  const marker = "Private target activity from an activation that must be refused";
  h.voice.activity([marker]);
  h.delegate("Inspect target files while ask_user is pending", "during-question");
  t.mock.timers.tick(0);
  h.question(false);
  assert.equal(h.voice.pending(), false);
  // Merely ending ask_user must not retroactively authorize that activation.
  h.voice.activity([marker]);
  h.delegate("Inspect target files after the refused activation", "after-question");
  t.mock.timers.tick(0);
  assert.deepEqual({
    sent: h.sent,
    leakedActivity: h.output.filter(event => event.text === marker),
  }, { sent: [], leakedActivity: [] }, "a refused activation cannot forward activity or submit later work on that voice epoch");
});

test("stop during delayed target startup rejects transfer instead of reporting false success", async t => {
  const entered = deferred<void>();
  const ready = deferred<void>();
  const events: string[] = [];
  const router = createVoiceRouter<string, { name: string }>({
    main: "main", signal: new AbortController().signal, timeoutMs: 60_000,
    async start(name) {
      events.push(`start:${name}`);
      if (name === "target") { entered.resolve(); await ready.promise; }
      return { name };
    },
    async close(leg) { events.push(`close:${leg.name}`); },
    gate(leg, enabled) { events.push(`audio:${leg.name}:${enabled}`); },
    pending: () => false, introduce() {},
    notice(_leg, text) { events.push(`notice:${text}`); },
    changed(name) { events.push(`route:${name}`); }, expired() {},
  });
  t.after(async () => { ready.resolve(); await router.handle.stop(); });
  const handle = await router.start();
  handle.setAudioEnabled(true);
  const transfer = router.transfer("target", "Transfer succeeded");
  // Observe both outcomes immediately, avoiding an unhandled rejection if a
  // fixed router rejects as soon as stop aborts its signal.
  const result = transfer.then(() => "resolved" as const, () => "rejected" as const);
  await entered.promise;
  const stopping = handle.stop();
  ready.resolve();
  await stopping;
  assert.ok(events.includes("close:target"), "late target leg must be reaped");
  assert.ok(!events.includes("audio:target:true"), "cancelled target must never receive audio");
  assert.ok(!events.includes("notice:Transfer succeeded"));
  assert.equal(router.target(), "main");
  assert.equal(router.available(), false);
  assert.equal(await result, "rejected", "a cancelled transfer must reject, not falsely confirm success");
});
