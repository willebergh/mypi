import assert from "node:assert/strict";
import test from "node:test";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  applySubagentEvent,
  compactContextBar,
  createSubagentState,
  formatElapsed,
  formatSubagentCounters,
  parseSubagentTelemetry,
  subagentCounterWidths,
} from "../extensions/subagents/core.ts";
import { mapWithConcurrency } from "../extensions/subagents/runner.ts";

test("tracks a subagent through turns, tools, usage, and completion", () => {
  const state = createSubagentState(
    1,
    { task: "Inspect auth", label: "scout" },
    { cwd: "/repo", model: "provider/model", thinking: "high" },
  );
  state.startedAt = 1_000;

  applySubagentEvent(state, { type: "agent_start" } as JsonAgentSessionEvent);
  applySubagentEvent(
    state,
    { type: "turn_start", turnIndex: 0, timestamp: 1_000 } as JsonAgentSessionEvent,
  );
  applySubagentEvent(
    state,
    {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "src/auth.ts" },
    } as JsonAgentSessionEvent,
  );
  assert.equal(state.status, "running");
  assert.equal(state.activity, "using read");
  assert.equal(state.turns, 1);

  applySubagentEvent(
    state,
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Auth lives in src/auth.ts" }],
        model: "model",
        stopReason: "stop",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 0,
          cost: { total: 0.01 },
        },
      },
    } as JsonAgentSessionEvent,
  );
  applySubagentEvent(state, { type: "agent_settled" } as JsonAgentSessionEvent);

  assert.equal(state.status, "completed");
  assert.equal(state.result, "Auth lives in src/auth.ts");
  assert.deepEqual(state.usage, {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 0,
    cost: 0.01,
  });
  assert.equal(formatElapsed({ ...state, endedAt: 62_000 }), "1m01s");
});

test("formats compact context bars", () => {
  assert.equal(
    compactContextBar(0, 272_000),
    "[░░░0.0%░░░░░░░░░░░░░░░░0/272k░░░]",
  );
  assert.equal(
    compactContextBar(253_000, 272_000),
    "[███93.0%████████████253k/272k█░░]",
  );
  assert.equal(
    compactContextBar(271_728, 272_000),
    "[███99.9%████████████272k/272k███]",
  );
});

test("aligns subagent resource counters", () => {
  const first = createSubagentState(1, { task: "One" }, { cwd: "/repo" });
  const second = createSubagentState(2, { task: "Two" }, { cwd: "/repo" });
  first.agentFiles = 1;
  first.loadedSkills = 12;
  first.todosCompleted = 2;
  first.todosTotal = 5;
  second.agentFiles = 10;
  second.loadedSkills = 3;
  second.todosCompleted = 12;
  second.todosTotal = 15;
  const widths = subagentCounterWidths([first, second]);

  assert.equal(formatSubagentCounters(first, widths), "A( 1) · S(12) · T( 2/ 5)");
  assert.equal(formatSubagentCounters(second, widths), "A(10) · S( 3) · T(12/15)");
  assert.equal(
    formatSubagentCounters(first, widths).length,
    formatSubagentCounters(second, widths).length,
  );
});

test("captures todo and extension telemetry", () => {
  const state = createSubagentState(1, { task: "Build" }, { cwd: "/repo" });
  applySubagentEvent(
    state,
    {
      type: "tool_execution_end",
      toolCallId: "todo-1",
      toolName: "todo",
      args: {},
      result: {
        content: [{ type: "text", text: "Updated" }],
        details: {
          state: {
            items: [
              { id: 1, text: "One", completed: true },
              { id: 2, text: "Two", completed: false },
            ],
            nextId: 3,
          },
        },
      },
      isError: false,
    } as JsonAgentSessionEvent,
  );
  assert.equal(state.todosCompleted, 1);
  assert.equal(state.todosTotal, 2);
  assert.deepEqual(
    parseSubagentTelemetry({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "mypi-subagent-telemetry",
      statusText: '{"agentFiles":5,"loadedSkills":2}',
    }),
    { agentFiles: 5, loadedSkills: 2 },
  );
});

test("preserves compaction failures", () => {
  const state = createSubagentState(1, { task: "Build" }, { cwd: "/repo" });
  applySubagentEvent(
    state,
    {
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Summary failed",
    } as JsonAgentSessionEvent,
  );
  applySubagentEvent(state, { type: "agent_settled" } as JsonAgentSessionEvent);
  assert.equal(state.status, "failed");
  assert.equal(state.error, "Summary failed");
});

test("keeps context progress stable when streaming usage resets", () => {
  const state = createSubagentState(1, { task: "Build" }, { cwd: "/repo" });
  applySubagentEvent(
    state,
    {
      type: "message_update",
      usage: {
        input: 81_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 81_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      assistantMessageEvent: { type: "text_delta", delta: "Working" },
    } as JsonAgentSessionEvent,
  );
  applySubagentEvent(
    state,
    {
      type: "message_update",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        id: "call-1",
        toolName: "bash",
      },
    } as JsonAgentSessionEvent,
  );
  assert.equal(state.contextTokens, 81_000);
});

test("limits concurrent subagent operations while preserving result order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([30, 5, 10, 1], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index;
  });

  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3]);
});
