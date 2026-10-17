import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getEventListeners } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import askUserExtension from "../extensions/ask-user/index.ts";
import { ASK_USER_VOICE_REQUEST_EVENT, type VoiceQuestionRequest } from "../extensions/ask-user/voice.ts";
import {
  formatAskUserResult,
  normalizeQuestions,
  type AskUserResult,
  type RawQuestion,
} from "../extensions/ask-user/core.ts";

test("normalizes single and multiple-answer questions", () => {
  assert.deepEqual(
    normalizeQuestions([
      {
        id: "framework",
        question: "Which framework?",
        options: [{ label: "React", description: "Web UI" }],
      },
      {
        id: "features",
        label: "Features",
        question: "Which features?",
        mode: "multiple",
        options: [{ label: "Auth" }, { label: "Billing" }],
      },
    ]),
    [
      {
        id: "framework",
        label: "Q1",
        question: "Which framework?",
        mode: "single",
        options: [{ label: "React", description: "Web UI" }],
      },
      {
        id: "features",
        label: "Features",
        question: "Which features?",
        mode: "multiple",
        options: [
          { label: "Auth", description: undefined },
          { label: "Billing", description: undefined },
        ],
      },
    ],
  );
});

test("rejects malformed questionnaires", () => {
  assert.throws(() => normalizeQuestions([]), /At least one/);
  assert.throws(
    () =>
      normalizeQuestions([
        { id: "same", question: "First?" },
        { id: "same", question: "Second?" },
      ]),
    /Duplicate question id/,
  );
  assert.throws(
    () =>
      normalizeQuestions([
        {
          id: "duplicate-options",
          question: "Choose",
          options: [{ label: "A" }, { label: "A" }],
        },
      ]),
    /duplicate option/,
  );
});

test("formats selected, free-text, and skipped answers", () => {
  const text = formatAskUserResult({
    questions: [],
    cancelled: false,
    answers: [
      {
        id: "scope",
        question: "Scope?",
        skipped: false,
        answers: [
          { label: "API", custom: false },
          { label: "And docs", custom: true },
        ],
      },
      {
        id: "deadline",
        question: "Deadline?",
        skipped: true,
        answers: [],
      },
    ],
  });
  assert.equal(text, "scope: API, And docs (free text)\ndeadline: skipped");
});

test("normal cancellation formatting is unchanged", () => {
  assert.equal(formatAskUserResult({ questions: [], answers: [], cancelled: true }), "User cancelled the questionnaire");
});

test("interrupted tool results carry only confirmed answers and the actual new request", () => {
  const userRequest = "Tell Pi to look at the image.\nWhat went wrong? /run $(not executed)";
  const text = formatAskUserResult({
    questions: normalizeQuestions([{ id: "first", question: "First?" }, { id: "next", question: "Next?" }]),
    answers: [
      { id: "first", question: "First?", skipped: false, answers: [{ label: "Green", custom: false }] },
      { id: "next", question: "Next?", skipped: false, answers: [] },
    ],
    cancelled: true,
    userRequest,
  });
  assert.equal(text, "Confirmed answers:\nfirst: Green\n" +
    "Incomplete questionnaire interrupted; remaining questions are unanswered. No approval inferred for unanswered questions.\n" +
    "New spoken user request: " + userRequest);
  assert.doesNotMatch(text, /next:|hidden|history|steer/i);
});

test("new requests with no confirmed answers or after completion are explicit", () => {
  const base = { questions: [], answers: [], userRequest: "Look at the image" };
  assert.match(formatAskUserResult({ ...base, cancelled: true }), /^No confirmed answers\.\nIncomplete questionnaire interrupted/);
  assert.match(formatAskUserResult({ ...base, cancelled: false }), /Questionnaire completed; no approval beyond the confirmed answers is inferred/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const terminalQuestions: RawQuestion[] = [
  { id: " first ", question: " First? ", options: [{ label: " Yes " }, { label: "No" }] },
  { id: "next", question: "Next?", options: [{ label: "Proceed" }] },
];
const normalizedTerminalQuestions = normalizeQuestions(terminalQuestions);
const emptyCancellation: AskUserResult = {
  questions: normalizedTerminalQuestions, answers: [], cancelled: true,
};

type ToolResult = { details: AskUserResult; content: { type: string; text: string }[] };
type AskUserTool = {
  execute(id: string, params: { questions: RawQuestion[] }, signal: AbortSignal | undefined,
    update: undefined, ctx: ExtensionContext): Promise<ToolResult>;
};
type CustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type Dialog = Awaited<ReturnType<CustomFactory>>;

// Exercise the real custom factory, without a terminal. Like Pi, done can run
// before the returned component is installed, and disposal can reenter it.
function terminalHarness(options: {
  voice?: (request: VoiceQuestionRequest) => void;
  beforeFactory?: () => void;
  onDone?: () => void;
} = {}) {
  let tool!: AskUserTool;
  let component: Dialog | undefined;
  let closed = false;
  let close!: (result: AskUserResult) => void;
  let uiCalls = 0;
  let voiceCalls = 0;
  let doneCalls = 0;
  let renders = 0;
  const opened = deferred<void>();
  askUserExtension({
    on() {},
    events: { emit(name: string, data: unknown) {
      assert.equal(name, ASK_USER_VOICE_REQUEST_EVENT);
      voiceCalls++;
      options.voice?.(data as VoiceQuestionRequest);
    } },
    registerTool(value: AskUserTool) { tool = value; },
  } as unknown as ExtensionAPI);
  const ctx = {
    mode: "tui",
    ui: { custom(factory: CustomFactory) {
      uiCalls++;
      return new Promise((resolve, reject) => {
        close = (result) => {
          doneCalls++;
          if (closed) return;
          closed = true;
          options.onDone?.();
          resolve(result);
          component?.dispose?.();
        };
        options.beforeFactory?.();
        const tui = { terminal: { rows: 40 }, requestRender() { renders++; } };
        const theme = { fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text };
        Promise.resolve(factory(
          tui as Parameters<CustomFactory>[0],
          theme as Parameters<CustomFactory>[1],
          {} as Parameters<CustomFactory>[2],
          (result) => close(result as AskUserResult),
        )).then((value) => {
          component = value;
          opened.resolve();
        }, reject);
      });
    } },
  } as unknown as ExtensionContext;
  return {
    execute(signal?: AbortSignal) { return tool.execute("original-tool-call", { questions: terminalQuestions }, signal, undefined, ctx); },
    opened: opened.promise,
    get dialog() { assert.ok(component); return component; },
    get closed() { return closed; },
    get uiCalls() { return uiCalls; },
    get voiceCalls() { return voiceCalls; },
    get doneCalls() { return doneCalls; },
    get renders() { return renders; },
    hostClose(result: AskUserResult) { close(result); },
  };
}

function observeAbort(t: TestContext, signal: AbortSignal) {
  const add = t.mock.method(signal, "addEventListener");
  const remove = t.mock.method(signal, "removeEventListener");
  return {
    add,
    remove,
    assertCleaned() {
      assert.equal(getEventListeners(signal, "abort").length, 0);
      for (const call of add.mock.calls) {
        assert.equal(call.arguments[0], "abort");
        assert.deepEqual(call.arguments[2], { once: true });
        assert.equal(remove.mock.calls.filter((removed) =>
          removed.arguments[0] === "abort" && removed.arguments[1] === call.arguments[1]).length, 1);
      }
    },
  };
}

function assertCancellation(result: ToolResult, expected: AskUserResult) {
  assert.deepEqual(result.details, expected);
  assert.deepEqual(result.content, [{ type: "text", text: "User cancelled the questionnaire" }]);
  assert.equal(result.details.userRequest, undefined);
}

test("pre-aborted ask_user never attempts voice or terminal UI", { timeout: 1000 }, async (t) => {
  const controller = new AbortController();
  controller.abort();
  const listeners = observeAbort(t, controller.signal);
  const h = terminalHarness();
  assertCancellation(await h.execute(controller.signal), emptyCancellation);
  assert.equal(h.voiceCalls, 0);
  assert.equal(h.uiCalls, 0);
  assert.equal(h.doneCalls, 0);
  assert.equal(listeners.add.mock.callCount(), 0);
});

test("abort closes an already open dialog exactly like Esc; late keys cannot approve answers", { timeout: 1000 }, async (t) => {
  for (const partial of [false, true]) {
    const esc = terminalHarness();
    const escPending = esc.execute();
    await esc.opened;
    if (partial) esc.dialog.handleInput!("\r");
    esc.dialog.handleInput!("\x1b");
    const expected = (await escPending).details;

    const controller = new AbortController();
    const listeners = observeAbort(t, controller.signal);
    const h = terminalHarness({ voice(request) {
      assert.equal(request.claim(async () => undefined), true);
    } });
    const pending = h.execute(controller.signal);
    await h.opened;
    assert.equal(h.closed, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    assert.ok(h.dialog.render(60).some((line) => line.includes("First?")));
    if (partial) h.dialog.handleInput!("\r");
    controller.abort();
    assert.equal(h.closed, true);
    assertCancellation(await pending, expected);
    const renders = h.renders;
    for (const key of ["\r", " ", "\x1b[B", "\x1b", "late answer", "\r"]) h.dialog.handleInput!(key);
    // Even a stale queued listener and repeated disposal cannot complete twice.
    const callback = listeners.add.mock.calls[1].arguments[1] as EventListener;
    callback(new Event("abort"));
    h.dialog.dispose?.();
    assert.equal(h.renders, renders);
    assert.equal(h.doneCalls, 1);
    assert.equal(h.uiCalls, 1);
    assert.equal(h.voiceCalls, 1);
    assertCancellation(await pending, expected);
    listeners.assertCleaned();
  }
});

test("abort while editing free text cancels rather than submitting late text", { timeout: 1000 }, async (t) => {
  const controller = new AbortController();
  const listeners = observeAbort(t, controller.signal);
  const h = terminalHarness();
  const pending = h.execute(controller.signal);
  await h.opened;
  h.dialog.handleInput!("\x1b[B");
  h.dialog.handleInput!("\x1b[B");
  h.dialog.handleInput!("\r");
  h.dialog.handleInput!("Unconfirmed text");
  controller.abort();
  h.dialog.handleInput!("\r");
  const result = await pending;
  assert.equal(result.details.cancelled, true);
  assert.ok(result.details.answers.every((answer) => !answer.skipped && answer.answers.length === 0));
  assert.equal(h.doneCalls, 1);
  listeners.assertCleaned();
});

test("abort after async voice decline but before fallback cannot open a dialog", { timeout: 1000 }, async (t) => {
  const controller = new AbortController();
  const listeners = observeAbort(t, controller.signal);
  const voice = deferred<AskUserResult | undefined>();
  const h = terminalHarness({ voice(request) {
    assert.strictEqual(request.signal, controller.signal);
    assert.equal(request.claim(() => voice.promise), true);
  } });
  const pending = h.execute(controller.signal);
  assert.equal(h.uiCalls, 0);
  voice.resolve(undefined);
  // Voice's finish runs first; execute's await continuation runs after this abort.
  queueMicrotask(() => {
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
  });
  assertCancellation(await pending, emptyCancellation);
  assert.equal(h.voiceCalls, 1);
  assert.equal(h.uiCalls, 0);
  assert.equal(h.doneCalls, 0);
  listeners.assertCleaned();
});

test("callback-scope abort before factory initialization completes without hanging", { timeout: 1000 }, async (t) => {
  const controller = new AbortController();
  const listeners = observeAbort(t, controller.signal);
  const h = terminalHarness({ beforeFactory() { controller.abort(); } });
  const result = await h.execute(controller.signal);
  assert.equal(result.details.cancelled, true);
  assert.ok(result.details.answers.every((answer) => answer.answers.length === 0));
  assert.equal(h.uiCalls, 1);
  assert.equal(h.doneCalls, 1);
  listeners.assertCleaned();
});

test("abort during listener registration is caught and cleaned even with reentrant done", { timeout: 1000 }, async (t) => {
  for (const phase of ["before-add", "after-add"] as const) {
    const controller = new AbortController();
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    let calls = 0;
    t.mock.method(controller.signal, "addEventListener", (...args: Parameters<AbortSignal["addEventListener"]>) => {
      calls++;
      if (calls === 2 && phase === "before-add") controller.abort();
      originalAdd(...args);
      if (calls === 2 && phase === "after-add") controller.abort();
    });
    const remove = t.mock.method(controller.signal, "removeEventListener");
    const h = terminalHarness({ onDone() { controller.signal.dispatchEvent(new Event("abort")); } });
    const result = await h.execute(controller.signal);
    assert.equal(result.details.cancelled, true);
    assert.ok(result.details.answers.every((answer) => answer.answers.length === 0));
    assert.equal(h.doneCalls, 1);
    assert.equal(calls, 2);
    assert.equal(remove.mock.callCount(), 2); // Voice and terminal, once each.
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("normal completion, Esc, and external disposal remove the terminal abort listener once", { timeout: 1000 }, async (t) => {
  for (const action of ["answer", "escape", "dispose"] as const) {
    const controller = new AbortController();
    const listeners = observeAbort(t, controller.signal);
    const h = terminalHarness({ onDone() {
      // Simulate input/disposal reentering the completion callback.
      h.dialog.handleInput!("\r");
      h.dialog.dispose?.();
      controller.abort();
    } });
    const pending = h.execute(controller.signal);
    await h.opened;
    if (action === "answer") {
      h.dialog.handleInput!("\r");
      h.dialog.handleInput!("\r");
    } else if (action === "escape") {
      h.dialog.handleInput!("\x1b");
    } else {
      h.dialog.dispose?.();
      h.dialog.dispose?.();
      listeners.assertCleaned();
      controller.abort();
      h.dialog.handleInput!("\r");
      assert.equal(h.doneCalls, 0);
      h.hostClose(emptyCancellation); // Host completes its own disposed interaction.
    }
    const result = await pending;
    assert.equal(result.details.cancelled, action !== "answer");
    if (action === "answer") {
      assert.deepEqual(result.details.answers.map((answer) => answer.answers), [
        [{ label: "Yes", custom: false }], [{ label: "Proceed", custom: false }],
      ]);
      assert.equal(result.content[0].text, "first: Yes\nnext: Proceed");
    }
    h.dialog.handleInput!("\r");
    h.dialog.handleInput!("\x1b");
    assert.equal(h.doneCalls, 1);
    assert.equal(h.uiCalls, 1);
    assert.equal(listeners.add.mock.callCount(), 2);
    listeners.assertCleaned();
  }
});
