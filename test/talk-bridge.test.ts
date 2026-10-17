import assert from "node:assert/strict";
import test from "node:test";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { createTalkBridge } from "../extensions/talk/bridge.ts";

type Observer = NonNullable<Parameters<typeof createTalkBridge>[4]>;
function harness(options: {
  idle?: boolean;
  input?: "sync" | "async" | "none";
  source?: string;
  observer?: Observer;
  failure?: "send" | "metadata";
  queueVisibility?: boolean;
  liveFailure?: "commentary" | "thinking";
} = {}) {
  const sent: Array<{ prompt: string; options: unknown }> = [];
  const entries: Array<[string, unknown]> = [];
  const order: string[] = [];
  const spoken: Array<{ id: string | null; text: string }> = [];
  const quiet: Array<{ id: string | null; text: string }> = [];
  const errors: Error[] = [];
  const events: string[] = [];
  let idle = options.idle ?? true;
  let pending = false;
  const observer: Observer = { callId: "call-123" };
  for (const event of ["pending", "accepted", "released", "detached"] as const) {
    observer[event] = (id) => {
      events.push(`${event}:${id}`); order.push(event);
      options.observer?.[event]?.(id);
    };
  }
  const bridge = createTalkBridge({
    appendEntry(name, value) {
      if (options.failure === "metadata") throw new Error("metadata failed");
      entries.push([name, value]); order.push("metadata");
    },
    sendUserMessage(prompt, sendOptions) {
      if (options.failure === "send") throw new Error("send failed");
      assert.equal(typeof prompt, "string");
      const accept = () => {
        if (options.input !== "none") bridge.input(prompt as string, options.source ?? "extension");
        sent.push({ prompt: prompt as string, options: sendOptions });
        order.push("dispatch");
      };
      // The real API is void; input runs within its async dispatch scope, before
      // native enqueue. No native consumption or beforeStart is synthesized here.
      if (options.input === "async") void Promise.resolve().then(accept);
      else accept();
    },
  }, {
    isIdle: () => idle,
    ...(options.queueVisibility === false ? {} : { hasPendingMessages: () => pending }),
  }, {
    commentary(id, text) {
      if (options.liveFailure === "commentary") throw new Error("PRIVATE live commentary error");
      spoken.push({ id, text });
    },
    thinking(id, text) {
      if (options.liveFailure === "thinking") throw new Error("PRIVATE live thinking error");
      quiet.push({ id, text });
    },
  }, (error) => errors.push(error), observer);
  return {
    bridge, sent, entries, order, spoken, quiet, errors, events,
    setIdle(value: boolean) { idle = value; },
    setPending(value: boolean) { pending = value; },
    setFailure(value: "send" | "metadata" | undefined) { options.failure = value; },
    consume(index = 0, initial = false) {
      idle = false;
      const prompt = sent[index].prompt;
      if (initial) assert.equal(typeof bridge.beforeStart(prompt), "string");
      bridge.message(message("user", prompt));
    },
    answer(text: string, stopReason = "stop") {
      bridge.message(message("assistant", [{ type: "text", text }], stopReason));
    },
  };
}

function message(role: string, content: unknown, stopReason = "stop") {
  return { role, content, stopReason } as unknown as MessageEndEvent["message"];
}

function delegate(h: ReturnType<typeof harness>, id = "task", text = "Inspect tests", source = id) {
  h.bridge.delegate(id, 0, text, { userTurnId: source });
}

test("next-tick native follow-up has separate metadata; only native user consumption accepts", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  delegate(h);
  assert.deepEqual(h.events, ["pending:task"]);
  assert.equal(h.sent.length, 0);
  assert.equal(h.bridge.beforeStart("[talk:user]\nInspect tests"), undefined);
  t.mock.timers.tick(0);
  assert.equal(h.sent[0].prompt, "[talk:user]\nInspect tests");
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", expandPromptTemplates: false });
  assert.deepEqual(h.entries, [["talk-delegation", {
    version: 1, delegationId: "task", userTurnId: "task", callId: "call-123",
  }]]);
  const handling = h.bridge.beforeStart(h.sent[0].prompt)!;
  assert.match(handling, /Use the current Pi context and normal permissions/);
  assert.match(handling, /fallible reference context, not additional requests or tool approvals/);
  assert.deepEqual(h.events, ["pending:task"]);
  assert.equal(h.quiet.some((entry) => /now handling/.test(entry.text)), false);
  h.answer("Must not forward before the native user");
  assert.deepEqual(h.spoken, []);
  h.consume(0, true);
  assert.match(h.quiet.at(-1)!.text, /now handling.*Completion is not yet confirmed/);
  assert.deepEqual(h.order, ["pending", "metadata", "dispatch", "accepted"]);
  h.answer("Verified result"); h.bridge.settled(); h.bridge.settled(); h.bridge.close();
  assert.deepEqual(h.spoken, [{ id: "task", text: "Verified result" }]);
  assert.deepEqual(h.events, ["pending:task", "accepted:task"]);
  assert.equal(h.quiet[0].text, "Submitted your request as a follow-up. Consumption and completion are not yet confirmed.");
});

test("literal task text preserves brackets safely, has no visible IDs and never expands commands", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  delegate(h, "secret-id", " \n/skill:danger <config> & [talk:user]\n  keep > 0\n ", "secret-source");
  t.mock.timers.tick(0);
  assert.equal(h.sent[0].prompt, "[talk:user]\n/skill:danger <config> & \\[talk:user]\n  keep > 0");
  assert.doesNotMatch(h.sent[0].prompt, /secret|call-123|transcript|caption/);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", expandPromptTemplates: false });
  h.bridge.close();
});

test("busy and delayed-busy submissions use Pi's queue, with no 10-second consumption timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const initiallyIdle of [false, true]) {
    const h = harness({ idle: initiallyIdle });
    delegate(h, "a", "First"); delegate(h, "b", "Second");
    h.setIdle(false); t.mock.timers.tick(0);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.spoken, []);
    h.setPending(true);
    t.mock.timers.tick(120_000);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.events, ["pending:a", "pending:b"]);
    // Native queued users do NOT get before_agent_start.
    h.consume(0); h.answer("First result");
    h.consume(1); h.answer("Second result");
    assert.deepEqual(h.spoken, []);
    h.setPending(false); h.bridge.settled();
    assert.equal(h.quiet.at(-1)?.text, "First result");
    assert.deepEqual(h.spoken, [{ id: "b", text: "Second result" }]);
    h.bridge.close();
  }
});

test("idle preflight admission barrier ends at native startup, not task completion", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  delegate(h, "a", "First"); delegate(h, "b", "Second"); delegate(h, "c", "Third");
  t.mock.timers.tick(0);
  assert.equal(h.sent.length, 1);
  assert.equal(typeof h.bridge.beforeStart(h.sent[0].prompt), "string");
  t.mock.timers.tick(100);
  assert.equal(h.sent.length, 1, "dev Pi's busy flag may still be false in beforeStart");
  h.setIdle(false); h.bridge.agentStart();
  t.mock.timers.tick(10);
  assert.equal(h.sent.length, 3, "all remaining work is natively submitted before any result");
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.errors, []);
  h.consume(0); h.answer("First"); h.consume(1); h.answer("Second"); h.consume(2); h.answer("Third");
  h.bridge.settled(); h.bridge.close();
  assert.deepEqual(h.events.filter((event) => event.startsWith("accepted")), ["accepted:a", "accepted:b", "accepted:c"]);
});

test("native consumption alone also wakes idle admission without a new lifecycle hook", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0, true); t.mock.timers.tick(10);
  assert.equal(h.sent.length, 2);
  h.bridge.close();
});

test("async input keeps private origin but is not a consumption receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false, input: "async" });
  delegate(h); t.mock.timers.tick(0);
  assert.equal(h.bridge.beforeStart("[talk:user]\nInspect tests"), undefined);
  await Promise.resolve();
  assert.equal(typeof h.bridge.beforeStart(h.sent[0].prompt), "string");
  assert.deepEqual(h.events, ["pending:task"]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.errors, []);
  h.consume(); h.answer("Verified result"); h.bridge.settled(); h.bridge.close();
  assert.equal(h.spoken[0].text, "Verified result");
});

test("followUpMode all co-consumes voice users into one shared response", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0); h.consume(1);
  h.answer("Combined verified answer"); h.bridge.settled(); h.bridge.settled();
  assert.deepEqual(h.events, ["pending:a", "pending:b", "accepted:a", "accepted:b"]);
  assert.equal(h.spoken.length, 1);
  assert.match(h.spoken[0].text, /Shared response to grouped voice requests \(not individual completion confirmation\): Combined verified answer/);
  assert.doesNotMatch(h.spoken[0].text, /\bPi\b/);
  assert.equal(h.quiet.filter((entry) => /Combined verified answer/.test(entry.text)).length, 0);
  h.bridge.close();
});

test("one voice source queues distinct native tasks while Pi is busy, including after A is consumed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const consumed of [false, true]) {
    const h = harness({ idle: false });
    const source = "user_bidi_turn_123";
    delegate(h, "inspect-delegation", "inspect repo", source); t.mock.timers.tick(0);
    if (consumed) h.consume(0);
    delegate(h, "time-delegation", "What time is it", source); t.mock.timers.tick(0);
    assert.deepEqual(h.sent, [
      { prompt: "[talk:user]\ninspect repo", options: { deliverAs: "followUp", expandPromptTemplates: false } },
      { prompt: "[talk:user]\nWhat time is it", options: { deliverAs: "followUp", expandPromptTemplates: false } },
    ]);
    assert.deepEqual(h.entries, [
      ["talk-delegation", { version: 1, delegationId: "inspect-delegation", userTurnId: source, callId: "call-123" }],
      ["talk-delegation", { version: 1, delegationId: "time-delegation", userTurnId: source, callId: "call-123" }],
    ]);
    assert.doesNotMatch(JSON.stringify(h.sent), /user_bidi_turn|delegation|call-123|usage|tokens/);
    assert.equal(h.events.filter((event) => event === `pending:${source}`).length, 2);
    if (!consumed) h.consume(0);
    h.answer("Repository inspected");
    h.consume(1); h.answer("Verified time");
    assert.deepEqual(h.spoken, []);
    h.bridge.settled(); h.bridge.settled(); h.bridge.close();
    assert.equal(h.events.filter((event) => event === `accepted:${source}`).length, 2);
    assert.equal(h.quiet.at(-1)?.text, "Repository inspected");
    assert.deepEqual(h.spoken, [{ id: "time-delegation", text: "Verified time" }]);
    assert.equal(h.sent.length, 2, "observing results never synthesizes more requests or usage");
    assert.equal(h.entries.length, 2, "only real delegation provenance is persisted");
    assert.deepEqual(h.errors, []);
  }
});

test("same source plus formatted text deduplicates waiting, submitted, consumed and completed tasks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "original", " \r\nInspect repo\r\ncarefully\r\n ", "source");
  const duplicate = (stage: string) => {
    delegate(h, `duplicate-${stage}`, "Inspect repo\ncarefully", "source");
    delegate(h, `sanitized-${stage}`, "\x1b[31mInspect repo\x1b[0m\ncarefully", "source");
    delegate(h, "original", "Entirely different", "different-source");
  };
  duplicate("waiting");
  assert.deepEqual(h.events, ["pending:source"]);
  t.mock.timers.tick(0); duplicate("submitted"); t.mock.timers.tick(0);
  h.consume(); duplicate("consumed"); t.mock.timers.tick(0);
  h.answer("Verified result"); h.bridge.settled();
  duplicate("completed"); t.mock.timers.tick(0);
  assert.deepEqual(h.events, ["pending:source", "accepted:source"]);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.spoken, [{ id: "original", text: "Verified result" }]);
  assert.deepEqual(h.errors, []);
  h.bridge.close();
});

test("source/text dedup runs after validation, while exact delegation IDs still short-circuit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "original", "Inspect tests", "source");
  delegate(h, "oversized-duplicate", " ".repeat(8192) + "Inspect tests", "source");
  delegate(h, "empty-duplicate", "", "source");
  delegate(h, "original", "", "source");
  t.mock.timers.tick(0);
  assert.equal(h.errors.length, 2);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.events, ["pending:source"]);
  h.bridge.close();
});

test("different source IDs with identical text retain native ambiguous-attribution policy", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "Same text", "source-a");
  for (let i = 0; i < 300; i++) delegate(h, `duplicate-${i}`, " \r\nSame text\r\n ", "source-a");
  delegate(h, "b", "Same text", "source-b");
  delegate(h, "a", "Changed", "source-c");
  t.mock.timers.tick(0);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.errors, []);
  assert.equal(h.sent[0].prompt, h.sent[1].prompt);
  assert.equal(h.bridge.beforeStart(h.sent[0].prompt), undefined);
  h.consume(0); h.answer("Cannot assign this result to either identical input");
  h.consume(1); h.answer("Cannot assign this result either");
  h.bridge.settled();
  assert.deepEqual(h.events, ["pending:source-a", "pending:source-b", "detached:source-a", "detached:source-b"]);
  assert.match(h.spoken[0].text, /ambiguous/);
  assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /Cannot assign/);
  delegate(h, "again", "Same text", "source-a"); t.mock.timers.tick(0);
  assert.equal(h.sent.length, 2, "uncertain consumed sources remain reserved too");
  h.bridge.close();
});

test("completed sources retain exact-text dedup, but accept changed payloads and distinct source IDs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  for (const id of ["a", "b"]) {
    delegate(h, id, "Same text"); t.mock.timers.tick(0);
    h.consume(h.sent.length - 1); h.answer(`Result ${id}`); h.bridge.settled();
    delegate(h, `${id}-duplicate`, " \r\nSame text\r\n", id);
    delegate(h, `${id}-changed`, "Different", id); t.mock.timers.tick(0);
    h.consume(h.sent.length - 1); h.answer(`Changed result ${id}`); h.bridge.settled();
  }
  assert.equal(h.sent.length, 4);
  assert.deepEqual(h.events, [
    "pending:a", "accepted:a", "pending:a", "accepted:a",
    "pending:b", "accepted:b", "pending:b", "accepted:b",
  ]);
  assert.deepEqual(h.spoken.map((entry) => entry.text), ["Result a", "Changed result a", "Result b", "Changed result b"]);
  h.bridge.close();
});

test("competing interactive, RPC and extension inputs poison identical attribution, in either order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const source of ["interactive", "rpc", "extension"]) for (const before of [false, true]) {
    const h = harness({ idle: false });
    if (before) h.bridge.input("[talk:user]\nInspect tests", source);
    delegate(h); t.mock.timers.tick(0);
    if (!before) h.bridge.input(h.sent[0].prompt, source);
    assert.equal(h.bridge.beforeStart(h.sent[0].prompt), undefined);
    h.consume(); h.answer("FOREIGN SECRET", "toolUse"); h.answer("FOREIGN SECRET"); h.bridge.settled();
    assert.deepEqual(h.events, ["pending:task", "detached:task"]);
    assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /FOREIGN SECRET/);
    h.bridge.close();
  }
});

test("unscoped or wrong-source input cannot authenticate; no-handshake timeout detaches, never retries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const options of [{ input: "none" as const }, { source: "interactive" }]) {
    const h = harness({ idle: false, ...options });
    delegate(h); t.mock.timers.tick(0);
    h.bridge.input(h.sent[0].prompt, "extension");
    assert.equal(h.bridge.beforeStart(h.sent[0].prompt), undefined);
    h.answer("foreign");
    t.mock.timers.tick(10_000);
    assert.match(h.errors[0].message, /did not acknowledge.*avoid duplicate work/);
    assert.deepEqual(h.events, ["pending:task", "detached:task"]);
    delegate(h, "retry"); t.mock.timers.tick(10_000);
    assert.equal(h.sent.length, 1);
    h.bridge.close();
  }
});

test("idle input handshake without startup may time out, but does not claim cancellation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  delegate(h); delegate(h, "waiting", "Another"); t.mock.timers.tick(0);
  h.bridge.beforeStart(h.sent[0].prompt);
  t.mock.timers.tick(10_000);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.events, ["pending:task", "pending:waiting", "detached:task", "released:waiting"]);
  assert.equal(h.sent.length, 1);
  h.bridge.close();
});

test("foreign steering hides its result without discarding future voice work or earlier completed scopes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); delegate(h, "c", "Third"); t.mock.timers.tick(0);
  h.consume(0); h.answer("First final");
  h.consume(1); h.answer("Inspecting the second request", "toolUse");
  assert.deepEqual(h.spoken, [{ id: "b", text: "Pi commentary (work in progress):\nInspecting the second request" }]);
  h.bridge.input("Typed steering", "interactive");
  h.bridge.message(message("user", "Typed steering"));
  h.answer("FOREIGN SECRET", "toolUse"); h.answer("FOREIGN SECRET");
  h.consume(2); h.answer("Third final"); h.bridge.settled();
  assert.equal(h.quiet.some((entry) => entry.text === "First final"), true);
  assert.equal(h.quiet.some((entry) => /different user request/.test(entry.text)), true);
  assert.deepEqual(h.spoken, [
    { id: "b", text: "Pi commentary (work in progress):\nInspecting the second request" },
    { id: "c", text: "Third final" },
  ]);
  assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /FOREIGN SECRET/);
  h.bridge.close();
});

test("custom/system beforeStart cannot leak its answer or discard future voice requests", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0); h.answer("First final");
  assert.equal(h.bridge.beforeStart(undefined), undefined);
  h.answer("CUSTOM SECRET", "toolUse"); h.answer("CUSTOM SECRET");
  h.consume(1); h.answer("Second final"); h.bridge.settled();
  assert.equal(h.quiet.at(-1)?.text, "First final");
  assert.equal(h.spoken[0].text, "Second final");
  assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /CUSTOM SECRET/);
  h.bridge.close();
});

test("foreign user co-consumed before or after voice contaminates the shared response", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const before of [false, true]) {
    const h = harness({ idle: false });
    delegate(h); t.mock.timers.tick(0);
    if (before) h.bridge.message(message("user", "Foreign"));
    h.consume();
    if (!before) h.bridge.message(message("user", "Foreign"));
    h.answer("FOREIGN SECRET", "toolUse"); h.answer("FOREIGN SECRET"); h.bridge.settled();
    assert.match(h.spoken[0].text, /different user request/);
    assert.doesNotMatch(h.spoken[0].text, /FOREIGN SECRET/);
    h.bridge.close();
  }
});

test("assistant public text is progress for toolUse, final only at settlement; never thinking, tools or failed text", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const reason of ["stop", "toolUse", "error", "aborted"]) {
    const h = harness({ idle: false });
    delegate(h); t.mock.timers.tick(0); h.consume();
    h.bridge.message(message("toolResult", [{ type: "text", text: "TOOL SECRET" }]));
    h.bridge.message(message("assistant", [
      { type: "thinking", thinking: "THINKING SECRET" }, { type: "text", text: "TEXT RESULT" },
    ], reason));
    h.bridge.settled();
    assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /THINKING SECRET|TOOL SECRET/);
    if (reason === "stop") assert.deepEqual(h.spoken, [{ id: "task", text: "TEXT RESULT" }]);
    else if (reason === "toolUse") {
      assert.deepEqual(h.spoken, [
        { id: "task", text: "Pi commentary (work in progress):\nTEXT RESULT" },
        { id: "task", text: "I finished without a text result. Check the terminal; no action is confirmed here." },
      ], "toolUse prose must not become scope.result or claim completion");
    } else assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /TEXT RESULT/);
    h.bridge.close();
  }
  const h = harness({ idle: false });
  delegate(h); t.mock.timers.tick(0); h.consume();
  h.bridge.message(message("assistant", [{ type: "text", text: "Mixed tool text" }, { type: "toolCall", name: "secret" }]));
  h.bridge.settled();
  assert.deepEqual(h.spoken[0], { id: "task", text: "Pi commentary (work in progress):\nMixed tool text" });
  assert.doesNotMatch(h.spoken[1].text, /Mixed tool text/);
  h.bridge.close();
});

test("public commentary relays immediately before tool results, with final reporting still separate", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h); t.mock.timers.tick(0); h.consume();
  h.bridge.message(message("assistant", [
    { type: "thinking", thinking: "PRIVATE reasoning" },
    { type: "text", text: "I will inspect the failing test." },
    { type: "toolCall", id: "private-tool-id", name: "private-tool-name", arguments: { secret: "PRIVATE args" } },
    { type: "text", text: "Then I will check the implementation." },
  ], "toolUse"));
  const progress = { id: "task", text: "Pi commentary (work in progress):\nI will inspect the failing test.\nThen I will check the implementation." };
  assert.deepEqual(h.spoken, [progress], "message_end relays before tools run or settlement");
  assert.deepEqual(h.events, ["pending:task", "accepted:task"]);
  h.bridge.message(message("toolResult", [{ type: "text", text: "PRIVATE tool output" }]));
  assert.deepEqual(h.spoken, [progress]);
  h.answer("Verified final result");
  assert.deepEqual(h.spoken, [progress], "even a final must await global settlement");
  h.bridge.settled(); h.bridge.settled();
  assert.deepEqual(h.spoken, [progress, { id: "task", text: "Verified final result" }]);
  assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /PRIVATE|private-tool|complete|finished/);
  h.bridge.close();
});

test("consecutive commentary dedup survives tools and empty/private-only messages, but is scope-local", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0);
  h.answer("Inspecting tests", "toolUse"); h.answer("Inspecting tests", "toolUse");
  h.bridge.message(message("toolResult", [{ type: "text", text: "PRIVATE result" }]));
  for (const text of ["", " \n\t", "\u0000\u001f\u007f\u0080\u200e\u202e\u2069\n\t"]) h.answer(text, "toolUse");
  h.bridge.message(message("assistant", [
    { type: "thinking", thinking: "PRIVATE reasoning" },
    { type: "toolCall", name: "PRIVATE tool", arguments: { text: "PRIVATE args" } },
  ], "toolUse"));
  h.answer("Inspecting tests", "toolUse");
  assert.equal(h.spoken.length, 1);
  h.answer("Checking implementation", "toolUse"); h.answer("Inspecting tests", "toolUse");
  assert.equal(h.spoken.length, 3, "only consecutive identical commentary is suppressed");
  h.consume(1); h.answer("Inspecting tests", "toolUse");
  assert.deepEqual(h.spoken.map((entry) => entry.id), ["a", "a", "a", "b"]);
  assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /PRIVATE/);
  h.bridge.close();
});

test("co-consumed voice batch emits progress once under its latest delegation, without completing sources", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0); h.consume(1);
  h.answer("Inspecting both requests", "toolUse"); h.answer("Inspecting both requests", "toolUse");
  assert.deepEqual(h.spoken, [{ id: "b", text: "Pi commentary (work in progress):\nInspecting both requests" }]);
  delegate(h, "duplicate", " \r\nFirst\r\n", "a"); t.mock.timers.tick(0);
  assert.equal(h.sent.length, 2, "progress must not release a consumed source reservation");
  h.answer("Combined result");
  assert.equal(h.spoken.length, 1);
  h.bridge.settled();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.spoken[1].id, "b");
  assert.match(h.spoken[1].text, /Shared response to grouped voice requests.*Combined result/);
  h.bridge.close();
});

test("unowned, unknown and ambiguous tool-use commentary is never spoken", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const kind of ["terminal", "unknown", "ambiguous", "unconsumed"] as const) {
    const h = harness({ idle: false });
    if (kind !== "terminal") { delegate(h); t.mock.timers.tick(0); }
    if (kind === "ambiguous") h.bridge.input(h.sent[0].prompt, "interactive");
    if (kind === "terminal" || kind === "unknown") {
      h.bridge.input("Ordinary terminal request", "interactive");
      h.bridge.beforeStart("Ordinary terminal request");
      h.bridge.message(message("user", "Ordinary terminal request"));
    } else if (kind === "ambiguous") h.consume();
    h.answer("PRIVATE foreign commentary", "toolUse");
    assert.deepEqual(h.spoken, []);
    h.bridge.settled();
    assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /PRIVATE/);
    h.bridge.close();
  }
});

test("failed and aborted assistant tool-call messages never relay their error body", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const reason of ["error", "aborted"]) {
    const h = harness({ idle: false });
    delegate(h); t.mock.timers.tick(0); h.consume();
    h.bridge.message(message("assistant", [
      { type: "text", text: "PRIVATE failure body" },
      { type: "toolCall", name: "PRIVATE tool", arguments: { secret: "PRIVATE args" } },
    ], reason));
    assert.equal(h.spoken.length, 0);
    h.bridge.settled();
    assert.match(h.spoken[0].text, /failed or was interrupted.*Completion is not confirmed/);
    assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /PRIVATE/);
    h.bridge.close();
  }
});

test("commentary UTF-8 cap includes exact prefix; dedup keeps only the bounded clipped update", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h); t.mock.timers.tick(0); h.consume();
  const prefix = "Pi commentary (work in progress):\n";
  const body = "é🐈".repeat(500);
  h.answer(body + "one", "toolUse"); h.answer(body + "two", "toolUse");
  assert.equal(h.spoken.length, 1, "invisible differences beyond the cap must not repeat speech");
  assert.equal(h.spoken[0].text, prefix + "é🐈".repeat(69) + "é");
  h.answer("\u0000\u202eRead 🐈\ud800 safely\u200f", "toolUse");
  assert.equal(h.spoken[1].text, prefix + "Read 🐈\ufffd safely");
  for (const update of [...h.quiet, ...h.spoken]) {
    assert.ok(Buffer.byteLength(update.text) <= 450);
    assert.equal(Buffer.from(update.text).toString("utf8"), update.text);
  }
  h.bridge.close();
  h.answer("LATE PRIVATE commentary", "toolUse"); h.bridge.settled();
  assert.equal(h.spoken.length, 2);
});

test("quiet lifecycle and commentary delivery errors remain contained without leaking error bodies", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const liveFailure of ["thinking", "commentary"] as const) {
    const h = harness({ idle: false, liveFailure });
    delegate(h);
    assert.doesNotThrow(() => t.mock.timers.tick(0));
    assert.doesNotThrow(() => h.consume());
    assert.doesNotThrow(() => h.answer("Inspecting tests", "toolUse"));
    assert.doesNotThrow(() => h.answer("Inspecting tests", "toolUse"));
    assert.equal(h.errors.length, liveFailure === "thinking" ? 2 : 1);
    h.answer("Verified result");
    assert.doesNotThrow(() => h.bridge.settled());
    assert.ok(h.errors.every((error) => error.message === "Could not return Pi's result to the voice session"));
    assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /PRIVATE/);
    h.bridge.close();
  }
});

test("automatic retry result is forwarded only at global settlement, once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h); t.mock.timers.tick(0); h.consume();
  h.answer("Failed attempt", "error"); h.answer("Recovered final");
  assert.deepEqual(h.spoken, []);
  h.bridge.settled(); h.bridge.settled();
  assert.deepEqual(h.spoken, [{ id: "task", text: "Recovered final" }]);
  h.bridge.close();
});

test("explicit interruption detaches old scopes without closing the bridge or touching native work", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "running", "Inspect tests", "running_source");
  delegate(h, "queued", "Inspect docs", "queued_source");
  t.mock.timers.tick(0);
  h.consume(0);
  h.answer("Old result that must not be spoken after stop");
  delegate(h, "waiting", "Inspect scripts", "waiting_source");
  h.bridge.interrupted();
  h.bridge.interrupted();
  assert.equal(h.sent.length, 2, "the bridge does not cancel, clear, or resubmit native requests");
  assert.ok(h.events.includes("detached:queued_source"));
  assert.ok(h.events.includes("released:waiting_source"));
  h.answer("Late old response");
  h.bridge.settled();
  assert.equal(h.spoken.length, 0);
  delegate(h, "new", "Inspect a different file", "new_source");
  t.mock.timers.tick(0);
  h.consume(2);
  h.answer("New voice request result");
  h.bridge.settled();
  assert.deepEqual(h.spoken, [{ id: "new", text: "New voice request result" }]);
  h.bridge.close();
});

test("abort settlement retains still-native-queued work; later native consumption remains attributable", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0); h.answer("aborted private text", "aborted");
  h.setPending(true); h.bridge.settled(); h.bridge.settled();
  assert.deepEqual(h.events, ["pending:a", "pending:b", "accepted:a"]);
  assert.equal(h.spoken.length, 1);
  assert.match(h.spoken[0].text, /consumption is unconfirmed/);
  t.mock.timers.tick(60_000);
  assert.deepEqual(h.errors, []);
  h.consume(1); h.answer("Second result"); h.setPending(false); h.bridge.settled();
  assert.equal(h.spoken.at(-1)?.text, "Second result");
  assert.equal(h.sent.length, 2, "never automatically resubmit");
  h.bridge.close();
});

test("empty native queue releases only unconsumed reservations; missing queue visibility retains uncertainty", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const queueVisibility of [true, false]) {
    const h = harness({ idle: false, queueVisibility });
    delegate(h); t.mock.timers.tick(0); h.bridge.settled(); h.bridge.settled();
    assert.deepEqual(h.events, queueVisibility ? ["pending:task", "released:task"] : ["pending:task"]);
    assert.equal(h.spoken.length, 1);
    assert.match(h.spoken[0].text, /consumption is unconfirmed/);
    assert.equal(h.sent.length, 1);
    h.bridge.close();
    assert.equal(h.events.at(-1), queueVisibility ? "released:task" : "detached:task");
  }
});

test("settlement before an asynchronous handshake cannot release an in-flight submission", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false, input: "async" });
  delegate(h); t.mock.timers.tick(0); h.bridge.settled();
  assert.deepEqual(h.events, ["pending:task"]);
  await Promise.resolve();
  h.consume(); h.answer("Result"); h.bridge.settled();
  assert.equal(h.events.at(-1), "accepted:task");
  h.bridge.close();
});

test("STOP releases only undispatched tasks and detaches submitted unconsumed tasks exactly once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  delegate(h, "submitted", "First"); delegate(h, "waiting", "Second"); t.mock.timers.tick(0);
  h.bridge.close(); h.bridge.close(); t.mock.timers.tick(60_000);
  assert.deepEqual(h.events, ["pending:submitted", "pending:waiting", "detached:submitted", "released:waiting"]);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.errors, []);
  h.bridge.input(h.sent[0].prompt, "extension");
  assert.equal(h.bridge.beforeStart(h.sent[0].prompt), undefined);
  h.consume(); h.answer("LATE COMMENTARY SECRET", "toolUse"); h.answer("LATE SECRET"); h.bridge.settled();
  assert.deepEqual(h.spoken, []);
});

test("closing a consumed task never releases it, and late old-call events cannot reply in either call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = harness({ idle: false });
  delegate(old, "old", "Old task"); t.mock.timers.tick(0); old.consume(); old.bridge.close();
  const fresh = harness({ idle: false });
  delegate(fresh, "new", "New task"); t.mock.timers.tick(0);
  old.answer("OLD COMMENTARY SECRET", "toolUse"); old.answer("OLD SECRET"); old.bridge.settled();
  fresh.answer("OLD COMMENTARY SECRET", "toolUse"); fresh.answer("OLD SECRET"); fresh.bridge.settled();
  assert.deepEqual(old.events, ["pending:old", "accepted:old"]);
  assert.doesNotMatch(JSON.stringify([...old.spoken, ...fresh.spoken]), /OLD (COMMENTARY )?SECRET/);
  fresh.bridge.close();
});

test("a new call cannot attribute an identical native prompt still owned by an old call", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let active: ReturnType<typeof createTalkBridge>;
  const spoken: string[] = [];
  const accepted: string[] = [];
  const pi = {
    appendEntry() {},
    sendUserMessage(prompt: unknown) { active.input(prompt as string, "extension"); },
  };
  const make = () => createTalkBridge(pi, { isIdle: () => false, hasPendingMessages: () => false }, {
    commentary(_id, text) { spoken.push(text); }, thinking() {},
  }, () => assert.fail("unexpected error"), { accepted(id) { accepted.push(id); } });
  active = make();
  active.delegate("old", 0, "Same task", { userTurnId: "old-source" }); t.mock.timers.tick(0);
  active.close();
  active = make();
  active.delegate("new", 0, "Same task", { userTurnId: "new-source" }); t.mock.timers.tick(0);
  const prompt = "[talk:user]\nSame task";
  assert.equal(active.beforeStart(prompt), undefined);
  active.message(message("user", prompt));
  active.message(message("assistant", [{ type: "text", text: "OLD SECRET" }]));
  active.message(message("user", prompt));
  active.message(message("assistant", [{ type: "text", text: "UNATTRIBUTABLE NEW RESULT" }]));
  active.settled();
  assert.deepEqual(accepted, []);
  assert.doesNotMatch(spoken.join(" "), /OLD SECRET|UNATTRIBUTABLE NEW RESULT/);
  assert.match(spoken[0], /ambiguous/);
  // A known empty queue at settlement ends the cross-call quarantine.
  active.delegate("fresh", 0, "Same task", { userTurnId: "fresh-source" }); t.mock.timers.tick(0);
  active.message(message("user", prompt));
  active.message(message("assistant", [{ type: "text", text: "Fresh result" }]));
  active.settled(); active.close();
  assert.deepEqual(accepted, ["fresh-source"]);
  assert.equal(spoken.at(-1), "Fresh result");
});

test("pre-submission metadata failure releases, while uncertain send failure detaches without retry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["metadata", "send"] as const) {
    const h = harness({ failure });
    delegate(h); t.mock.timers.tick(0); h.bridge.close(); h.bridge.close();
    assert.deepEqual(h.events, ["pending:task", `${failure === "metadata" ? "released" : "detached"}:task`]);
    assert.equal(h.sent.length, 0);
    assert.match(h.spoken[0].text, failure === "metadata" ? /could not submit/ : /could not be confirmed/);
  }
});

test("metadata failure releases only its composite key, not another same-source task waiting or submitted", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const otherWaiting of [false, true]) {
    const h = harness({ idle: false, observer: { released() {
      h.setFailure(undefined);
      // B's reservation must survive A's release, including reentrant observers.
      delegate(h, "b-duplicate-reentrant", "What time is it", "source");
    } } });
    if (!otherWaiting) { delegate(h, "b", "What time is it", "source"); t.mock.timers.tick(0); }
    h.setFailure("metadata");
    delegate(h, "a", "inspect repo", "source");
    if (otherWaiting) delegate(h, "b", "What time is it", "source");
    t.mock.timers.tick(0);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].prompt, "[talk:user]\nWhat time is it");
    delegate(h, "b-duplicate", " \r\nWhat time is it\r\n", "source");
    delegate(h, "a", "inspect repo", "source"); // Even released delegation IDs stay seen.
    delegate(h, "a-retry", "inspect repo", "source"); t.mock.timers.tick(0);
    assert.equal(h.sent.length, 2, "only an explicit new delegation can retry A");
    assert.equal(h.sent[1].prompt, "[talk:user]\ninspect repo");
    assert.deepEqual(h.events, ["pending:source", "pending:source", "released:source", "pending:source"]);
    h.consume(0); h.answer("Time result"); h.consume(1); h.answer("Inspection result");
    h.bridge.settled(); h.bridge.close();
    assert.deepEqual(h.errors, []);
  }
});

test("released source can be admitted again with a different delegation ID, but never auto-retried", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First", "source"); t.mock.timers.tick(0); h.bridge.settled();
  assert.equal(h.sent.length, 1);
  delegate(h, "b", "First", "source"); t.mock.timers.tick(0);
  h.consume(1); h.answer("Result"); h.bridge.settled(); h.bridge.close();
  assert.deepEqual(h.events, ["pending:source", "released:source", "pending:source", "accepted:source"]);
});

test("missing, empty, malformed and oversized task text never reserve a source or fall back to history", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  h.bridge.delegate("missing", 0, undefined, { userTurnId: "source" });
  for (const [i, text] of [" ", "\u0000", "x".repeat(8193), "[talk:user]".repeat(720), "\ud800"].entries()) {
    delegate(h, `invalid-${i}`, text, "source");
  }
  t.mock.timers.tick(0);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.entries, []);
  assert.equal(h.errors.length, 5);
  assert.match(h.spoken[0].text, /No task text was available/);
  delegate(h, "vague", "Do that", "source"); t.mock.timers.tick(0);
  assert.equal(h.sent[0].prompt, "[talk:user]\nDo that", "never invent context for vague speech");
  h.bridge.close();
});

test("invalid or missing source IDs stay out of metadata and do not deduplicate requests", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  for (const [i, userTurnId] of [undefined, "", "bad/id", "bad\n", "é", "a".repeat(513), 1, null, {}].entries()) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const id = `task-${i}-${repeat}`;
      h.bridge.delegate(id, 0, "Same", { userTurnId: userTurnId as string }); t.mock.timers.tick(0);
      assert.deepEqual(h.entries.at(-1), ["talk-delegation", { version: 1, delegationId: id }]);
      h.consume(h.sent.length - 1); h.answer("Result"); h.bridge.settled();
    }
  }
  assert.equal(h.sent.length, 18);
  assert.deepEqual(h.events, []);
  h.bridge.close();
});

test("without source IDs, identical queued bodies remain ambiguous and distinct tasks still submit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  h.bridge.delegate("a", 0, "Same"); h.bridge.delegate("b", 0, "Same");
  h.bridge.delegate("c", 0, "Different"); t.mock.timers.tick(0);
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.events, []);
  h.consume(0); h.answer("PRIVATE ambiguous progress", "toolUse");
  h.consume(1); h.answer("PRIVATE ambiguous answer");
  h.consume(2); h.answer("Distinct result");
  h.bridge.settled(); h.bridge.close();
  assert.doesNotMatch(JSON.stringify([...h.spoken, ...h.quiet]), /PRIVATE/);
  assert.ok([...h.spoken, ...h.quiet].some((entry) => entry.text === "Distinct result"));
  assert.deepEqual(h.entries, ["a", "b", "c"].map((delegationId) => ["talk-delegation", { version: 1, delegationId }]));
});

test("256 delegation bound retains oldest source dedup and accepts wire-boundary IDs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  const sources = ["_", "a".repeat(512), ...Array.from({ length: 254 }, (_, i) => `source-${i}`)];
  for (const [i, source] of sources.entries()) {
    delegate(h, `task-${i}`, "Same", source); t.mock.timers.tick(0);
    h.consume(i); h.answer("Result"); h.bridge.settled();
  }
  delegate(h, "old-duplicate", " \r\nSame\r\n", sources[0]);
  assert.equal(h.errors.length, 0);
  delegate(h, "overflow", "Task", "new-source"); t.mock.timers.tick(0);
  assert.equal(h.sent.length, 256);
  assert.equal(h.events.filter((event) => event.startsWith("accepted")).length, 256);
  assert.match(h.errors[0].message, /delegation limit/);
  h.bridge.close();
});

test("every voice update stays within 450 valid UTF-8 bytes, including grouped responses", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ idle: false });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0); h.consume(1); h.answer("é🐈".repeat(500)); h.bridge.settled();
  for (const update of [...h.quiet, ...h.spoken]) {
    assert.ok(Buffer.byteLength(update.text) <= 450);
    assert.equal(Buffer.from(update.text).toString("utf8"), update.text);
  }
  h.bridge.close();
});

test("reentrant pending observer sees reservation and can close before dispatch", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ observer: { pending(id) {
    delegate(h, "duplicate", "Inspect tests", id); h.bridge.close();
  } } });
  delegate(h); t.mock.timers.tick(10_000);
  assert.deepEqual(h.events, ["pending:task", "released:task"]);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.errors, []);
});

test("observer exceptions cannot derail dispatch, consumption, release or detachment", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fail = () => { throw new Error("observer failed"); };
  const h = harness({ idle: false, observer: { pending: fail, accepted: fail, released: fail, detached: fail } });
  delegate(h, "a", "First"); delegate(h, "b", "Second"); t.mock.timers.tick(0);
  h.consume(0); h.answer("Result"); h.setPending(true); h.bridge.settled();
  delegate(h, "waiting", "Third");
  assert.doesNotThrow(() => h.bridge.close());
  assert.deepEqual(h.events, ["pending:a", "pending:b", "accepted:a", "pending:waiting", "detached:b", "released:waiting"]);
  assert.deepEqual(h.errors, []);
});

test("live errors are contained and synchronous close during send does not double-notify", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const errors: Error[] = [];
  const bridge = createTalkBridge({
    appendEntry() {},
    sendUserMessage() { bridge.close(); throw new Error("send failed"); },
  }, { isIdle: () => true }, { commentary() {}, thinking() {} }, (error) => errors.push(error), {
    pending() { events.push("pending"); }, released() { events.push("released"); }, detached() { events.push("detached"); },
  });
  bridge.delegate("task", 0, "Task", { userTurnId: "source" }); t.mock.timers.tick(10_000);
  bridge.close();
  assert.deepEqual(events, ["pending", "detached"]);
  const failingLive = createTalkBridge({ appendEntry() { throw new Error("metadata"); }, sendUserMessage() {} },
    { isIdle: () => true }, { commentary() { throw new Error("live"); }, thinking() {} }, (error) => errors.push(error));
  failingLive.delegate("failed", 0, "Task"); t.mock.timers.tick(0);
  assert.match(errors[0].message, /Could not return Pi's result/);
  failingLive.close();
});
