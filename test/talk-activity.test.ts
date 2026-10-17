import assert from "node:assert/strict";
import test from "node:test";
import { createTalkActivity } from "../extensions/talk/activity.ts";
import type { SubagentState } from "../extensions/subagents/core.ts";
import type { TodoItem } from "../extensions/todos/core.ts";

function agent(overrides: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 1, label: "Review", task: "Review the changes", cwd: "PRIVATE_CWD",
    status: "queued", activity: "PRIVATE_ACTIVITY", turns: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextTokens: 0, agentFiles: 0, loadedSkills: 0, todosCompleted: 0, todosTotal: 0,
    result: "PRIVATE_RESULT", error: "PRIVATE_ERROR", ...overrides,
  };
}
const todo = (id: number, text = "Review tests", completed = false): TodoItem => ({ id, text, completed });
const todos = (items: TodoItem[], nextId = 20) => ({ state: { items, nextId } });
function bounded(text: string, limit = 450) {
  assert.ok(Buffer.byteLength(text) <= limit);
  assert.equal(Buffer.from(text).toString("utf8"), text);
  assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  assert.doesNotMatch(text, /PRIVATE_/);
}

test("queued agents start once, token/status churn is quiet, terminal transitions are once", () => {
  for (const terminal of ["completed", "failed", "aborted"] as const) {
    const activity = createTalkActivity();
    const state = agent();
    assert.deepEqual(activity.subagents({ states: [state] }), []);
    state.status = "starting";
    assert.deepEqual(activity.subagents({ states: [state] }), ["Agent #1 (Review) started."]);
    state.startedAt = 100;
    for (const status of ["thinking", "running", "thinking", "queued", "starting"] as const) {
      state.status = status;
      state.activity = "PRIVATE_THINKING";
      assert.deepEqual(activity.subagents({ states: [{ ...state }] }), []);
    }
    state.status = terminal;
    assert.deepEqual(activity.subagents({ states: [state] }), [`Agent #1 (Review) ${terminal}.`]);
    assert.deepEqual(activity.subagents({ states: [{ ...state }] }), []);
    assert.doesNotMatch(activity.snapshot(), /Review|PRIVATE_/);
  }
});

test("initial completed agents are baseline; initial active agents start and facts remain without a voice consumer", () => {
  const activity = createTalkActivity();
  assert.deepEqual(activity.subagents({ states: [agent({ status: "completed" })] }), []);
  assert.deepEqual(activity.subagents({ states: [agent({ status: "completed" })] }), []);
  activity.subagents({ states: [agent({ id: 2, status: "thinking", label: "Current" })] });
  assert.match(activity.snapshot(), /1 active/);
  assert.match(activity.snapshot(), /Current.*thinking/);
  assert.deepEqual(activity.subagents({ states: [agent({ id: 2, status: "running", label: "Current" })] }), []);
});

test("agent ID reuse detects task and start identity, missing starts do not manufacture a run", () => {
  const activity = createTalkActivity();
  const send = (changes: Partial<SubagentState>) => activity.subagents({ states: [agent(changes)] });
  assert.equal(send({ status: "running", startedAt: 1 }).length, 1);
  assert.equal(send({ status: "completed", startedAt: 1 }).length, 1);
  assert.deepEqual(send({ status: "completed", startedAt: 1 }), []);
  assert.equal(send({ status: "starting", startedAt: 2 }).length, 1);
  assert.deepEqual(send({ status: "thinking" }), []);
  assert.equal(send({ status: "running", task: "New batch", startedAt: 2 }).length, 1);
  assert.deepEqual(send({ status: "running", task: "New batch", startedAt: 2 }), []);
  assert.deepEqual(activity.subagents({ states: [] }), []);
  assert.equal(send({ status: "running", task: "New batch", startedAt: 2 }).length, 1);
  assert.deepEqual(send({ status: "completed", task: "Different already finished" }), []);
});

test("todos add and complete once across clones, edits update facts, removal/reopen correct counts", () => {
  const activity = createTalkActivity();
  assert.deepEqual(activity.todos(todos([todo(1)])), ["Todo #1 added: Review tests."]);
  assert.deepEqual(activity.todos(todos([todo(1)])), []);
  assert.deepEqual(activity.todos(todos([todo(1, "Updated tests")])), ["Todo #1 edited: Updated tests."]);
  assert.match(activity.snapshot(), /Updated tests/);
  assert.deepEqual(activity.todos(todos([todo(1, "Updated tests", true)])), ["Todo #1 completed: Updated tests."]);
  assert.deepEqual(activity.todos(todos([todo(1, "Updated tests", true)])), []);
  assert.match(activity.snapshot(), /0 pending, 1 completed/);
  assert.deepEqual(activity.todos(todos([todo(1, "Updated tests")])), ["Todo #1 reopened: Updated tests."]);
  assert.match(activity.snapshot(), /1 pending, 0 completed/);
  assert.deepEqual(activity.todos(todos([])), ["Todos cleared: 1 removed (0 completed, 1 pending)."]);
  assert.match(activity.snapshot(), /0 pending, 0 completed/);
  assert.doesNotMatch(activity.snapshot(), /Updated tests/);
  assert.deepEqual(activity.todos(todos([todo(1, "New task")], 2)), ["Todo #1 added: New task."]);
});

test("initial completed todos and repeated list calls do not invent completion events; clear permits ID reuse", () => {
  const activity = createTalkActivity();
  const first = todos([todo(1, "Old", true)], 2);
  assert.deepEqual(activity.todos(first), []);
  assert.deepEqual(activity.todos(structuredClone(first)), []);
  assert.match(activity.snapshot(), /0 pending, 1 completed/);
  assert.deepEqual(activity.todos(todos([], 1)), ["Todos cleared: 1 removed (1 completed, 0 pending)."]);
  assert.deepEqual(activity.todos(todos([todo(1, "Fresh")], 2)), ["Todo #1 added: Fresh."]);
  activity.reset();
  assert.doesNotMatch(activity.snapshot(), /Fresh|Old/);
  assert.match(activity.snapshot(), /0 active/);
  assert.match(activity.snapshot(), /no status received/);
  assert.equal(activity.todos(todos([todo(1, "Fresh")], 2)).length, 1);
  activity.subagents({ states: [agent({ status: "running" })] });
  activity.reset();
  assert.doesNotMatch(activity.snapshot(), /Review/);
  assert.equal(activity.subagents({ states: [agent({ status: "running" })] }).length, 1);
});

test("malformed payloads are ignored atomically, including duplicates and nonfinite/fractional IDs", () => {
  const activity = createTalkActivity();
  activity.subagents({ states: [agent({ status: "running" })] });
  activity.todos(todos([todo(1)]));
  const before = activity.snapshot();
  const badAgents: unknown[] = [null, undefined, 1, [], {}, { states: {} }, { states: [null] },
    { states: [agent(), agent()] }, { states: [agent({ status: "mystery" as never })] },
    { states: [agent({ task: 4 as never })] }, { states: [agent({ label: null as never })] },
    { states: [agent({ startedAt: NaN })] }, { states: [agent({ model: {} as never })] }];
  const badTodos: unknown[] = [null, [], {}, { state: null }, { state: { items: [] } },
    todos([todo(1), todo(1)]), todos([null as never]), todos([todo(1)], NaN),
    todos([todo(1)], 0), todos([{ ...todo(1), completed: "true" as never }]),
    todos([{ ...todo(1), text: null as never }]), todos([{ ...todo(1), completedAt: Infinity }])];
  for (const id of [NaN, Infinity, -Infinity, 1.5, "1", null]) {
    badAgents.push({ states: [agent({ id: 2 }), agent({ id: id as number })] });
    badTodos.push(todos([todo(2), todo(id as number)]));
  }
  for (const payload of badAgents) {
    assert.deepEqual(activity.subagents(payload), []);
    assert.equal(activity.snapshot(), before);
  }
  for (const payload of badTodos) {
    assert.deepEqual(activity.todos(payload), []);
    assert.equal(activity.snapshot(), before);
  }
});

test("caps accept 128 agents/256 todos, reject oversized batches, and bound snapshot with exact counts", () => {
  const activity = createTalkActivity();
  const states = Array.from({ length: 128 }, (_, id) => agent({ id, status: "running", label: "😀".repeat(100) }));
  const items = Array.from({ length: 256 }, (_, id) => todo(id, "😀".repeat(100), id % 2 === 0));
  const updates = [...activity.subagents({ states }), ...activity.todos(todos(items, 257))];
  assert.equal(updates.length, 256);
  updates.forEach((text) => bounded(text));
  const snapshot = activity.snapshot();
  bounded(snapshot, 1200);
  assert.match(snapshot, /128 active/);
  assert.match(snapshot, /128 pending, 128 completed/);
  assert.match(snapshot, /Details omitted/);
  assert.deepEqual(activity.subagents({ states: [...states, agent({ id: 999 })] }), []);
  assert.deepEqual(activity.todos(todos([...items, todo(999)], 1000)), []);
  assert.equal(activity.snapshot(), snapshot);
});

test("Unicode labels and task fallback are clipped safely; only allowed facts leave the collector", () => {
  const activity = createTalkActivity();
  const text = '\0\x1b\u061c\u202e\u2066\ud800😀\n\t' + "界😀".repeat(200) + "PRIVATE_TASK_TAIL";
  const updates = activity.subagents({ states: [agent({ status: "running", label: "", task: text })],
    action: "PRIVATE_ACTION", thinking: "PRIVATE_THINKING", toolOutput: "PRIVATE_OUTPUT" });
  updates.push(...activity.todos({ ...todos([todo(1, text)]), output: "PRIVATE_OUTPUT" }));
  updates.forEach((value) => bounded(value));
  bounded(activity.snapshot(), 1200);
  assert.doesNotMatch(activity.snapshot(), /\n\s*😀/);
  assert.ok(updates.every((value) => value.includes("😀")));
  assert.ok(updates.every((value) => !value.includes("\n")));
  activity.subagents({ states: [agent({ status: "running", label: "\0", task: "\0" })] });
  assert.match(activity.snapshot(), /agent-1/);
});

test("tool execution events expose only bounded tool facts, deduplicate IDs, and track parallel calls", () => {
  const activity = createTalkActivity();
  const payload = (toolCallId: string, toolName = "read", isError?: boolean) => ({
    toolCallId, toolName, isError,
    get args(): never { throw new Error("args must not be read"); },
    get result(): never { throw new Error("result must not be read"); },
    get partialResult(): never { throw new Error("partial result must not be read"); },
  });
  assert.deepEqual(activity.toolEnd(payload("unknown")), []);
  assert.deepEqual(activity.toolStart(payload("secret-id", "read")), ["Tool read started."]);
  assert.deepEqual(activity.toolStart(payload("secret-id", "read")), []);
  assert.deepEqual(activity.toolStart(payload("other", "bash")), ["Tool bash started."]);
  assert.deepEqual(activity.toolEnd(payload("secret-id", "write")), []);
  assert.match(activity.snapshot(), /Tools: 2 running/);
  const returned = activity.toolEnd(payload("secret-id"));
  assert.deepEqual(returned, ["Tool read returned (tool status only; task completion unconfirmed)."]);
  assert.deepEqual(activity.toolEnd(payload("secret-id")), []);
  assert.deepEqual(activity.toolEnd(payload("other", "bash", true)), ["Tool bash reported an error."]);
  assert.match(activity.snapshot(), /Tools: 0 running/);
  assert.doesNotMatch([...returned, activity.snapshot()].join("\n"), /secret-id|args|result/);
  activity.reset();
  assert.match(activity.snapshot(), /Tools: 0 running/);
  assert.deepEqual(activity.toolEnd(payload("secret-id")), []);
});

test("tool events reject unsafe fields and retain at most 256 recent calls", () => {
  const activity = createTalkActivity();
  for (const event of [null, {}, { toolCallId: "x", toolName: "bad name" },
    { toolCallId: "x", toolName: "x", isError: "yes" },
    { toolCallId: "x\u202e", toolName: "read" },
    { toolCallId: "x\n", toolName: "read" },
    { toolCallId: "x".repeat(513), toolName: "read" },
    { toolCallId: "x", toolName: "x".repeat(97) },
    { toolCallId: "x", toolName: "💥" }]) {
    assert.deepEqual(activity.toolStart(event), []);
    assert.deepEqual(activity.toolEnd(event), []);
  }
  for (let i = 0; i < 300; i++) activity.toolStart({ toolCallId: `id-${i}`, toolName: "namespace:tool.read" });
  assert.match(activity.snapshot(), /Tools: 256 running/);
  bounded(activity.snapshot(), 1200);
  assert.deepEqual(activity.toolEnd({ toolCallId: "id-0", toolName: "namespace:tool.read" }), []);
  assert.deepEqual(activity.toolEnd({ toolCallId: "id-299", toolName: "namespace:tool.read" }).length, 1);
});

test("IDs accept finite integers, and captured facts do not alias later payload mutations", () => {
  const activity = createTalkActivity();
  const state = agent({ id: -2, status: "running" });
  const item = todo(-3);
  assert.equal(activity.subagents({ states: [state] }).length, 1);
  assert.equal(activity.todos(todos([item])).length, 1);
  const before = activity.snapshot();
  state.label = "PRIVATE_MUTATED";
  state.status = "completed";
  item.text = "PRIVATE_MUTATED";
  item.completed = true;
  assert.equal(activity.snapshot(), before);
  assert.equal(activity.subagents({ states: [state] }).length, 1);
  assert.equal(activity.todos(todos([item])).length, 1);
});
