import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/subagents/index.ts";
import { OperationScheduler } from "../extensions/subagents/runner.ts";
import { createTalkBridge } from "../extensions/talk/bridge.ts";
import { createTalkTerminalContext } from "../extensions/talk/terminal-context.ts";
import { createSubagentState } from "../extensions/subagents/core.ts";
import {
  SUBAGENT_COMPLETION_TYPE, createSubagentOperation, subagentStartDetails,
  subagentCompletionDetails, readSubagentStart, readSubagentCompletion,
} from "../extensions/subagents/protocol.ts";

type Message = MessageEndEvent["message"];
const user = (text: string) => ({ role: "user", content: text }) as Message;
const assistant = (text: string, stopReason = "stop") => ({
  role: "assistant", stopReason, content: [{ type: "text", text }, { type: "thinking", thinking: "PRIVATE THINKING" }],
}) as Message;
const state = (id: number) => createSubagentState(id, { task: "PRIVATE CHILD TASK" }, { cwd: "/repo" });

function harness() {
  const sent: string[] = [];
  const spoken: string[] = [];
  const quiet: string[] = [];
  const accepted: string[] = [];
  let pending = false;
  const bridge = createTalkBridge({
    appendEntry() {},
    sendUserMessage(prompt) {
      bridge.input(prompt as string, "extension");
      sent.push(prompt as string);
    },
  }, { isIdle: () => false, hasPendingMessages: () => pending }, {
    commentary(_id, text) { spoken.push(text); },
    thinking(_id, text) { quiet.push(text); },
  }, () => assert.fail("unexpected bridge delivery failure"), { accepted(id) { accepted.push(id); } });
  return {
    bridge, sent, spoken, quiet, accepted,
    pending(value: boolean) { pending = value; },
    consume(index = 0) { bridge.message(user(sent[index])); },
    answer(text: string, reason = "stop") { bridge.message(assistant(text, reason)); },
    start(toolCallId: string, ids: number[], parentToolCallId?: string) {
      const operation = createSubagentOperation(toolCallId);
      bridge.toolStart({ type: "tool_execution_start", toolName: "subagent", toolCallId, args: {}, parentToolCallId });
      bridge.toolEnd({ type: "tool_execution_end", toolName: "subagent", toolCallId,
        result: { details: subagentStartDetails(operation, ids.map(state)) }, isError: false, parentToolCallId });
      return operation;
    },
  };
}
function completion(operation: ReturnType<typeof createSubagentOperation>, id: number, status: "completed" | "failed" | "aborted" = "completed", deliveryId = `delivery-${id}`) {
  return {
    role: "custom", customType: SUBAGENT_COMPLETION_TYPE, display: true,
    content: "PRIVATE RAW SUBAGENT REPORT",
    details: subagentCompletionDetails(operation, deliveryId, { ...state(id), status, result: "PRIVATE RAW RESULT" }),
  } as Message;
}
function submit(h: ReturnType<typeof harness>, id: string) {
  h.bridge.delegate(id, 0, `Inspect ${id}`, { userTurnId: `turn-${id}` });
}
function noPrivate(h: ReturnType<typeof harness>) {
  assert.doesNotMatch([...h.spoken, ...h.quiet].join("\n"), /PRIVATE/);
}

test("successful native return survives settlement; custom startup is not consumption; parent final is sent once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
  const op = h.start("native-1", [31]);
  h.answer("Waiting for the delegated review."); h.bridge.settled(); h.bridge.settled();
  assert.deepEqual(h.spoken, ["Pi commentary (work in progress):\nWaiting for the delegated review."]);
  const done = completion(op, 31);
  assert.equal(typeof h.bridge.beforeStart(undefined, done), "string");
  h.answer("PRIVATE NOT CONSUMED");
  h.bridge.message(done); h.answer("Verified parent answer");
  assert.equal(h.spoken.length, 1, "final still waits for settlement");
  h.bridge.settled(); h.bridge.settled();
  h.bridge.message(done); h.answer("PRIVATE DUPLICATE PARENT"); h.bridge.settled();
  assert.deepEqual(h.spoken, ["Pi commentary (work in progress):\nWaiting for the delegated review.", "Verified parent answer"]);
  assert.deepEqual(h.accepted, ["turn-a"]);
  noPrivate(h); h.bridge.close();
});

test("parallel active steering, duplicate deliveries and nested native child starts preserve pending ownership", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
  h.answer("Delegating", "toolUse");
  const first = h.start("native-1", [1, 2]);
  const one = completion(first, 1);
  // Active custom steering has no before_agent_start; message_end is the receipt.
  h.bridge.message(one); h.bridge.message(one);
  h.answer("Checking the first result", "toolUse");
  const nested = h.start("codemode/1", [3], "codemode");
  h.bridge.message(completion(first, 2));
  h.answer("Waiting on the follow-up child"); h.bridge.settled();
  const progressCount = h.spoken.length;
  h.bridge.beforeStart(undefined, one); h.bridge.message(one);
  h.answer("PRIVATE DUPLICATE-ONLY RUN"); h.bridge.settled();
  assert.equal(h.spoken.length, progressCount, "idle redelivery must not revoke the pending nested child");
  h.bridge.message(completion(nested, 3)); h.answer("All verified by the parent"); h.bridge.settled(); h.bridge.settled();
  assert.equal(h.spoken.length, progressCount + 1);
  assert.equal(h.spoken.at(-1), "All verified by the parent");
  noPrivate(h); h.bridge.close();
});

test("native queued voice users and co-consumed independent completions have one grouped parent answer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); submit(h, "a"); submit(h, "b"); t.mock.timers.tick(0);
  h.consume(0); const a = h.start("a", [1]); h.answer("A is waiting");
  h.consume(1); const b = h.start("b", [2]); h.answer("B is waiting"); h.bridge.settled();
  h.bridge.message(completion(a, 1)); h.bridge.message(completion(b, 2));
  h.answer("Combined verified result"); h.bridge.settled();
  assert.match(h.spoken.at(-1)!, /^Shared response to grouped voice requests .*Combined verified result/);
  assert.equal(h.spoken.filter((text) => text.includes("Combined verified result")).length, 1);
  noPrivate(h); h.bridge.close();
});

test("completion steering into another explicitly voice-owned active scope groups both parents safely", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); submit(h, "a"); submit(h, "b"); t.mock.timers.tick(0);
  h.consume(0); const a = h.start("a", [1]); h.answer("A is waiting");
  h.consume(1); h.answer("Working on B", "toolUse"); const b = h.start("b", [2]);
  h.bridge.message(completion(a, 1)); h.bridge.message(completion(b, 2));
  h.answer("Both verified"); h.bridge.settled();
  assert.match(h.spoken.at(-1)!, /Shared response to grouped voice requests .*Both verified/);
  noPrivate(h); h.bridge.close();
});

test("a voice follow-up joins an active background scope without before_agent_start", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); submit(h, "a"); submit(h, "b"); t.mock.timers.tick(0);
  h.consume(0); const op = h.start("a", [1]); h.answer("Working", "toolUse");
  h.consume(1); h.bridge.message(completion(op, 1)); h.answer("Shared final"); h.bridge.settled();
  assert.match(h.spoken.at(-1)!, /Shared response to grouped voice requests .*Shared final/);
  assert.deepEqual(h.accepted, ["turn-a", "turn-b"]);
  h.bridge.close();
});

test("foreign submission fences dormant and active async scopes before native user consumption", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const source of ["interactive", "rpc", "extension"]) for (const dormant of [false, true]) {
    const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
    const op = h.start("a", [1]);
    if (dormant) { h.answer("Waiting"); h.bridge.settled(); }
    const count = h.spoken.length;
    h.bridge.input("Foreign typed work", source);
    h.bridge.message(completion(op, 1)); h.answer("PRIVATE FOREIGN ANSWER"); h.bridge.settled();
    assert.equal(h.spoken.length, count);
    submit(h, "new"); t.mock.timers.tick(0); h.consume(1); h.answer("New owned result"); h.bridge.settled();
    assert.equal(h.spoken.at(-1), "New owned result");
    noPrivate(h); h.bridge.close();
  }
});

test("unknown, missing, copied, partial or wrong-operation producer metadata never authenticates", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const kind of ["missing", "json", "partial", "foreign-operation", "foreign-child"]) {
    const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
    const op = h.start("a", [1]); h.answer("Waiting"); h.bridge.settled();
    const done = completion(kind === "foreign-operation" ? createSubagentOperation("foreign") : op, kind === "foreign-child" ? 99 : 1);
    if (done.role !== "custom") throw new Error("fixture");
    if (kind === "missing") done.details = undefined;
    if (kind === "json") done.details = JSON.parse(JSON.stringify(done.details));
    if (kind === "partial") (done.details as { state: { id: number } }).state.id = 99;
    assert.equal(h.bridge.beforeStart(undefined, done), undefined);
    h.bridge.message(done); h.answer("PRIVATE UNOWNED ANSWER"); h.bridge.settled();
    assert.equal(h.spoken.length, 1);
    noPrivate(h); h.bridge.close();
  }
});

test("missing/foreign successful tool-return receipts quarantine rather than inventing background ownership", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const details of [undefined, { states: [state(1)], operationId: "pretend" }, subagentStartDetails(createSubagentOperation("wrong-tool"), [state(1)])]) {
    const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
    h.bridge.toolStart({ type: "tool_execution_start", toolName: "subagent", toolCallId: "actual", args: {} });
    h.bridge.toolEnd({ type: "tool_execution_end", toolName: "subagent", toolCallId: "actual", result: { details }, isError: false });
    h.answer("PRIVATE UNCORRELATED RESULT"); h.bridge.settled();
    assert.deepEqual(h.spoken, []); noPrivate(h); h.bridge.close();
  }
});

test("failed tool starts create no pending children; canceled child and parent abort revoke async authority", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failed = harness(); submit(failed, "a"); t.mock.timers.tick(0); failed.consume();
  failed.bridge.toolStart({ type: "tool_execution_start", toolName: "subagent", toolCallId: "failed", args: {} });
  failed.bridge.toolEnd({ type: "tool_execution_end", toolName: "subagent", toolCallId: "failed", result: {}, isError: true });
  failed.answer("No child was started"); failed.bridge.settled(); failed.bridge.settled();
  assert.deepEqual(failed.spoken, ["No child was started"]); failed.bridge.close();
  for (const abort of [false, true]) {
    const h = harness(); submit(h, "a"); submit(h, "queued"); t.mock.timers.tick(0); h.consume();
    const op = h.start("a", [1]);
    h.pending(true);
    if (abort) { h.bridge.settled(true); }
    else h.bridge.message(completion(op, 1, "aborted"));
    h.answer("PRIVATE CANCELED RESULT"); h.bridge.settled();
    noPrivate(h);
    h.consume(1); h.answer("Queued work is still native"); h.pending(false); h.bridge.settled();
    assert.equal(h.spoken.at(-1), "Queued work is still native"); h.bridge.close();
  }
});

test("failed child outcome is context only; eligible parent can report the verified failure", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
  const op = h.start("a", [1]); h.answer("Waiting"); h.bridge.settled();
  h.bridge.message(completion(op, 1, "failed")); h.answer("The review failed; no fix is confirmed."); h.bridge.settled();
  assert.equal(h.spoken.at(-1), "The review failed; no fix is confirmed."); noPrivate(h); h.bridge.close();
});

test("close/interruption and a new call cannot inherit old completion authority", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const close of [false, true]) {
    const old = harness(); submit(old, "old"); t.mock.timers.tick(0); old.consume();
    const op = old.start("old", [1]);
    if (close) old.bridge.close(); else old.bridge.interrupted();
    const fresh = harness();
    old.bridge.message(completion(op, 1)); old.answer("PRIVATE OLD ANSWER"); old.bridge.settled();
    fresh.bridge.message(completion(op, 1)); fresh.answer("PRIVATE RESTART ANSWER"); fresh.bridge.settled();
    assert.deepEqual(old.spoken, []); assert.deepEqual(fresh.spoken, []);
    noPrivate(old); noPrivate(fresh); old.bridge.close(); fresh.bridge.close();
  }
});

test("foreign custom steering fences async ownership; saved Talk reference history does not", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const customType of ["foreign-work", "talk-history"]) {
    const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
    const op = h.start("a", [1]);
    h.bridge.message({ role: "custom", customType, content: "PRIVATE CUSTOM", display: false } as Message);
    h.bridge.message(completion(op, 1)); h.answer("Parent result"); h.bridge.settled();
    assert.equal(h.spoken.includes("Parent result"), customType === "talk-history");
    noPrivate(h); h.bridge.close();
  }
});

test("correlation bounds quarantine rather than evict old provenance or guess", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); submit(h, "a"); t.mock.timers.tick(0); h.consume();
  const first = h.start("first", [1]);
  for (let n = 0; n < 64; n++) h.start(`batch-${n}`, Array.from({ length: 16 }, (_, i) => n * 16 + i + 2));
  h.bridge.message(completion(first, 1)); h.answer("PRIVATE OVERFLOW ANSWER"); h.bridge.settled();
  assert.deepEqual(h.spoken, []); noPrivate(h); h.bridge.close();
});

test("actual subagent producer binds successful returned child IDs to later custom delivery details", async (t) => {
  let resolve!: (value: ReturnType<typeof state>) => void;
  const promise = new Promise<ReturnType<typeof state>>((done) => { resolve = done; });
  // No runner/process/provider: exercise only the producer's native result and
  // completion construction, with a manually settled scheduled operation.
  t.mock.method(OperationScheduler.prototype, "schedule", (() => ({ promise, cancel: () => false })) as typeof OperationScheduler.prototype.schedule);
  const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
  const deliveries: Array<{ customType: string; details?: unknown }> = [];
  subagentsExtension({
    on() {}, events: { on() {}, emit() {} }, registerMessageRenderer() {},
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { tools.push(tool); },
    sendMessage(message: { customType: string; details?: unknown }) { deliveries.push(message); },
  } as unknown as ExtensionAPI);
  const tool = tools.find((candidate) => candidate.name === "subagent")!;
  const result = await tool.execute("native-source", { tasks: [{ task: "Review" }] }, undefined, undefined, {
    cwd: "/repo", thinkingLevel: "off", isProjectTrusted: () => false,
  } as unknown as ExtensionContext);
  const started = readSubagentStart(result.details)!;
  assert.deepEqual(started.childIds, [1]);
  assert.equal(started.toolCallId, "native-source");
  resolve({ ...state(1), status: "completed" }); await Promise.resolve();
  assert.equal(deliveries[0].customType, SUBAGENT_COMPLETION_TYPE);
  const consumed = readSubagentCompletion(deliveries[0].details)!;
  assert.equal(consumed.operationId, started.operationId);
  assert.equal(consumed.toolCallId, "native-source");
  assert.equal(consumed.childId, 1);
});

test("internal producer fields are not JSON, persisted correlation, or task-text claims", () => {
  const op = createSubagentOperation("native");
  const started = subagentStartDetails(op, [state(1)]);
  const done = subagentCompletionDetails(op, "delivery", { ...state(1), status: "completed" });
  assert.equal(readSubagentStart(started)?.operationId, op.operationId);
  assert.equal(readSubagentCompletion(done)?.operationId, op.operationId);
  for (const details of [started, done]) {
    assert.doesNotMatch(JSON.stringify(details), new RegExp(op.operationId));
    assert.equal(readSubagentStart(JSON.parse(JSON.stringify(details))), undefined);
    assert.equal(readSubagentCompletion({ ...details }), undefined);
  }
  started.states[0].id = 9;
  assert.equal(readSubagentStart(started), undefined);
  done.state.status = "aborted";
  assert.equal(readSubagentCompletion(done), undefined);
});

test("consumed background context revokes terminal-mirror reply ownership without enabling speech", () => {
  const quiet: string[] = [];
  const mirror = createTalkTerminalContext(() => ({ thinking(_id, text) { quiet.push(text); } }), () => assert.fail("mirror failure"));
  mirror.input("Typed request", "interactive"); mirror.message(user("Typed request"));
  mirror.message(completion(createSubagentOperation("unowned"), 1));
  mirror.message(assistant("PRIVATE UNOWNED PARENT")); mirror.settled();
  assert.equal(quiet.length, 1); assert.doesNotMatch(quiet.join("\n"), /PRIVATE/); mirror.close();
});
