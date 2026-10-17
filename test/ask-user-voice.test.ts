import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askUserExtension from "../extensions/ask-user/index.ts";
import { normalizeQuestions, formatAskUserResult, type AskUserResult } from "../extensions/ask-user/core.ts";
import { ASK_USER_VOICE_REQUEST_EVENT, requestVoiceQuestions, type VoiceQuestionRequest } from "../extensions/ask-user/voice.ts";
import { createTalkQuestions } from "../extensions/talk/questions.ts";

const questions = normalizeQuestions([{ id: "id", question: "Choose?", options: [{ label: "Yes" }, { label: "No" }] }]);
const result: AskUserResult = { questions, answers: [{ id: "id", question: "Choose?", skipped: false,
  answers: [{ label: "Yes", custom: false }] }], cancelled: false };
const bus = (...listeners: ((request: VoiceQuestionRequest) => void)[]) => ({
  emit(name: string, data: unknown) {
    assert.equal(name, ASK_USER_VOICE_REQUEST_EVENT);
    for (const listener of listeners) listener(data as VoiceQuestionRequest);
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("no active handler falls back; claims are synchronous, once-only, and do not start losing handlers", async () => {
  assert.equal(await requestVoiceQuestions(bus(), questions), undefined);
  let saved!: VoiceQuestionRequest;
  assert.equal(await requestVoiceQuestions(bus((request) => { saved = request; }), questions), undefined);
  assert.equal(saved.claim(async () => result), false);
  let calls = 0;
  const claims: boolean[] = [];
  const events = bus(...Array.from({ length: 4 }, () => (request: VoiceQuestionRequest) => {
    assert.strictEqual(request.questions, questions);
    claims.push(request.claim(async () => { calls++; return result; }));
  }));
  assert.strictEqual(await requestVoiceQuestions(events, questions), result);
  assert.deepEqual(claims, [true, false, false, false]);
  assert.equal(calls, 1);
});

test("undefined, thrown/rejected handler, and failed emit safely fall back", async () => {
  for (const handler of [async () => undefined, () => { throw Error("sync"); }, async () => { throw Error("async"); }]) {
    assert.equal(await requestVoiceQuestions(bus((r) => { r.claim(handler); }), questions), undefined);
  }
  assert.equal(await requestVoiceQuestions({ emit() { throw Error("listener failed"); } }, questions), undefined);
});

test("pre-abort emits nothing; mid-handler abort wins, cleans listener, and ignores late success/failure", async (t) => {
  const pre = new AbortController();
  pre.abort();
  assert.equal((await requestVoiceQuestions({ emit() { assert.fail("pre-aborted emitted"); } }, questions, pre.signal))!.cancelled, true);
  for (const late of [result, undefined]) {
    const abort = new AbortController();
    const remove = t.mock.method(abort.signal, "removeEventListener");
    const work = deferred<AskUserResult | undefined>();
    let request!: VoiceQuestionRequest;
    const pending = requestVoiceQuestions(bus((r) => {
      request = r;
      assert.strictEqual(r.signal, abort.signal);
      r.claim(() => work.promise);
    }), questions, abort.signal);
    abort.abort();
    assert.deepEqual(await pending, { questions, answers: [], cancelled: true });
    assert.equal(request.claim(async () => result), false);
    work.resolve(late);
    await Promise.resolve();
    assert.equal(remove.mock.callCount(), 1);
  }
  const abort = new AbortController();
  assert.equal((await requestVoiceQuestions(bus((r) => {
    r.claim(async () => { abort.abort(); return undefined; });
  }), questions, abort.signal))!.cancelled, true);
});

test("abort during emission never invokes claimed handler; ordinary completion removes abort listener", async (t) => {
  const abort = new AbortController();
  const pending = requestVoiceQuestions(bus((r) => {
    r.claim(async () => { assert.fail("started after abort"); });
    abort.abort();
  }), questions, abort.signal);
  assert.equal((await pending)!.cancelled, true);
  const normal = new AbortController();
  const remove = t.mock.method(normal.signal, "removeEventListener");
  assert.strictEqual(await requestVoiceQuestions(bus((r) => { r.claim(async () => result); }), questions, normal.signal), result);
  assert.equal(remove.mock.callCount(), 1);
});

function toolHarness(events: { emit(name: string, data: unknown): void }) {
  type Tool = { execute(id: string, params: { questions: typeof questions }, signal: AbortSignal | undefined,
    update: undefined, ctx: ExtensionContext): Promise<{ details: AskUserResult; content: { type: string; text: string }[] }> };
  let tool!: Tool;
  let guiCalls = 0;
  askUserExtension({ on() {}, events, registerTool(value: Tool) { tool = value; } } as unknown as ExtensionAPI);
  const ctx = { mode: "tui", ui: { async custom() { guiCalls++; return result; } } } as unknown as ExtensionContext;
  return { execute: (signal?: AbortSignal, context = ctx) => tool.execute("call", { questions }, signal, undefined, context),
    ctx, get guiCalls() { return guiCalls; } };
}

test("ask_user uses voice before untouched custom UI and keeps the same result formatting", async () => {
  const voice = toolHarness(bus((r) => { r.claim(async () => result); }));
  const value = await voice.execute();
  assert.strictEqual(value.details, result);
  assert.equal(value.content[0].text, formatAskUserResult(result));
  assert.equal(voice.guiCalls, 0);
  for (const events of [bus(), bus((r) => { r.claim(async () => undefined); }),
    bus((r) => { r.claim(async () => { throw Error("disconnected"); }); })]) {
    const fallback = toolHarness(events);
    assert.strictEqual((await fallback.execute()).details, result);
    assert.equal(fallback.guiCalls, 1);
  }
});

test("ask_user mode guard precedes voice and abort cannot open late GUI", async () => {
  const guard = toolHarness({ emit() { assert.fail("non-TUI voice route"); } });
  const value = await guard.execute(undefined, { ...guard.ctx, mode: "print" });
  assert.equal(value.details.cancelled, true);
  assert.equal(guard.guiCalls, 0);
  for (const phase of ["before", "during", "after"] as const) {
    const abort = new AbortController();
    const h = toolHarness(bus((r) => {
      if (phase === "during") r.claim(async () => { abort.abort(); return undefined; });
    }));
    if (phase === "before") abort.abort();
    const pending = h.execute(abort.signal);
    if (phase === "after") abort.abort(); // After no-handler resolution but before execute resumes.
    assert.equal((await pending).details.cancelled, true);
    assert.equal(h.guiCalls, 0);
  }
});

test("claimed Talk questionnaire falls back on disconnect, and completes only after readback confirmation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = createTalkQuestions({ speak() {}, changed() {} });
  const h = toolHarness(bus((r) => { r.claim(() => c.ask(r.questions, r.signal)); }));
  const pending = h.execute();
  assert.equal(c.pending, true);
  c.answer("Yes");
  assert.equal(c.pending, true);
  c.answer("Ja");
  assert.deepEqual((await pending).details.answers, result.answers);
  assert.equal(h.guiCalls, 0);
  const disconnected = h.execute();
  c.cancel();
  await disconnected;
  assert.equal(h.guiCalls, 1);
  const timedOut = h.execute();
  t.mock.timers.tick(120_000);
  await timedOut;
  assert.equal(h.guiCalls, 2);
  assert.equal(c.answer("late yes"), false);
});
