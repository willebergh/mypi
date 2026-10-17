import { createHash } from "node:crypto";
import type { SubagentsChangedPayload, TodosChangedPayload } from "../resource-status/protocol.ts";
import type { SubagentState, SubagentStatus } from "../subagents/core.ts";
import type { TodoItem } from "../todos/core.ts";
import { safeLiveUpdate } from "./context.ts";

const statuses = new Set<SubagentStatus>([
  "queued", "starting", "thinking", "running", "completed", "failed", "aborted",
]);
const active = (status: SubagentStatus) =>
  status === "starting" || status === "thinking" || status === "running";
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
const optionalTime = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

// Sanitize before clipping, flatten label whitespace, and never split a code point.
function label(text: string, budget = 96): string {
  let result = "";
  let bytes = 0;
  for (const char of text) {
    const safe = safeLiveUpdate(char.replace(/\u061c/gu, "")).replace(/\s/gu, " ");
    const size = Buffer.byteLength(safe);
    if (bytes + size > budget) break;
    result += safe;
    bytes += size;
  }
  return result.trim();
}

function agentPayload(payload: unknown): SubagentsChangedPayload | undefined {
  if (!object(payload) || !Array.isArray(payload.states) || payload.states.length > 128) return;
  const ids = new Set<number>();
  for (const state of payload.states) {
    if (!object(state) || !integer(state.id) || ids.has(state.id) ||
        typeof state.task !== "string" || typeof state.label !== "string" ||
        typeof state.status !== "string" || !statuses.has(state.status as SubagentStatus) ||
        !optionalTime(state.startedAt) ||
        (state.model !== undefined && typeof state.model !== "string")) return;
    ids.add(state.id);
  }
  // Only the validated status projection is consumed; telemetry and outputs are ignored.
  return payload as unknown as SubagentsChangedPayload;
}

function todoPayload(payload: unknown): TodosChangedPayload | undefined {
  if (!object(payload) || !object(payload.state)) return;
  const state = payload.state;
  if (!integer(state.nextId) || state.nextId < 1 || !Array.isArray(state.items) || state.items.length > 256) return;
  const ids = new Set<number>();
  for (const item of state.items) {
    if (!object(item) || !integer(item.id) || ids.has(item.id) ||
        typeof item.text !== "string" || typeof item.completed !== "boolean" ||
        !optionalTime(item.completedAt)) return;
    ids.add(item.id);
  }
  return payload as unknown as TodosChangedPayload;
}

type AgentFact = Pick<SubagentState, "id" | "status" | "startedAt"> & {
  name: string;
  taskKey: string;
  started: boolean;
  settled: Set<SubagentStatus>;
};
type TodoFact = Pick<TodoItem, "id" | "completed"> & { name: string; textKey: string };

export function createTalkActivity(): {
  subagents(payload: unknown): string[];
  todos(payload: unknown): string[];
  toolStart(payload: unknown): string[];
  toolEnd(payload: unknown): string[];
  snapshot(): string;
  reset(): void;
} {
  let agents = new Map<number, AgentFact>();
  let items = new Map<number, TodoFact>();
  let todosKnown = false;
  // Insertion-ordered, bounded memory deduplicates starts/ends without retaining payloads.
  const toolCalls = new Map<string, { name: string; running: boolean }>();
  const toolLimit = 256;
  const toolEvent = (payload: unknown): { id: string; name: string; isError?: boolean } | undefined => {
    if (!object(payload)) return;
    const id = payload.toolCallId;
    const name = payload.toolName;
    const isError = payload.isError;
    if (typeof id !== "string" || id.length === 0 || id.length > 512 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(id) ||
        typeof name !== "string" || name.length === 0 || name.length > 96 || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/u.test(name) ||
        (isError !== undefined && typeof isError !== "boolean")) return;
    return { id, name, isError: isError as boolean | undefined };
  };
  const rememberToolCall = (id: string, fact: { name: string; running: boolean }) => {
    toolCalls.set(id, fact);
    while (toolCalls.size > toolLimit) toolCalls.delete(toolCalls.keys().next().value!);
  };

  return {
    subagents(payload) {
      const parsed = agentPayload(payload);
      if (!parsed) return [];
      const next = new Map<number, AgentFact>();
      const updates: string[] = [];
      for (const state of parsed.states) {
        // Retain a fixed-size identity, not full task context. An undefined start
        // timestamp becoming known is normal startup, not a second run.
        const taskKey = createHash("sha256").update(state.task).digest("hex");
        const previous = agents.get(state.id);
        const same = previous?.taskKey === taskKey &&
          (previous.startedAt === undefined || state.startedAt === undefined || previous.startedAt === state.startedAt);
        const name = label(state.label) || label(state.task) || `agent-${state.id}`;
        const fact: AgentFact = {
          id: state.id, name, taskKey, status: state.status,
          startedAt: state.startedAt ?? (same ? previous.startedAt : undefined),
          started: same ? previous.started : false,
          settled: new Set(same ? previous.settled : []),
        };
        if (active(state.status) && !fact.started) {
          updates.push(safeLiveUpdate(`Agent #${state.id} (${name}) started.`));
          fact.started = true;
        } else if (!active(state.status) && state.status !== "queued") {
          if (same && !fact.settled.has(state.status)) {
            updates.push(safeLiveUpdate(`Agent #${state.id} (${name}) ${state.status}.`));
          }
          // Initial terminal states are a baseline, never a just-finished event.
          fact.settled.add(state.status);
          fact.started = true;
        }
        next.set(state.id, fact);
      }
      agents = next;
      return updates;
    },
    todos(payload) {
      const parsed = todoPayload(payload);
      if (!parsed) return [];
      const next = new Map<number, TodoFact>();
      const updates: string[] = [];
      for (const item of parsed.state.items) {
        const previous = items.get(item.id);
        const name = label(item.text) || "untitled";
        const textKey = createHash("sha256").update(item.text).digest("hex");
        if (!previous) {
          // Completed items first observed are baseline facts, not new completions.
          if (!item.completed) updates.push(safeLiveUpdate(`Todo #${item.id} added: ${name}.`));
        } else {
          const edited = textKey !== previous.textKey;
          if (edited || item.completed !== previous.completed) {
            const action = item.completed !== previous.completed
              ? (item.completed ? "completed" : "reopened")
              : "edited";
            updates.push(safeLiveUpdate(`Todo #${item.id} ${action}: ${name}.`));
          }
        }
        next.set(item.id, { id: item.id, name, completed: item.completed, textKey });
      }
      if (todosKnown) {
        const removed = [...items.values()].filter((item) => !next.has(item.id));
        if (parsed.state.items.length === 0 && removed.length > 0) {
          const completed = removed.filter((item) => item.completed).length;
          updates.push(safeLiveUpdate(`Todos cleared: ${removed.length} removed (${completed} completed, ${removed.length - completed} pending).`));
        } else {
          for (const item of removed) updates.push(safeLiveUpdate(`Todo #${item.id} removed: ${item.name}.`));
        }
      }
      items = next;
      todosKnown = true;
      return updates;
    },
    toolStart(payload) {
      const event = toolEvent(payload);
      if (!event) return [];
      const previous = toolCalls.get(event.id);
      if (previous) return [];
      rememberToolCall(event.id, { name: event.name, running: true });
      return [safeLiveUpdate(`Tool ${event.name} started.`)];
    },
    toolEnd(payload) {
      const event = toolEvent(payload);
      if (!event) return [];
      const previous = toolCalls.get(event.id);
      if (!previous || previous.name !== event.name || !previous.running) return [];
      rememberToolCall(event.id, { name: previous.name, running: false });
      return [safeLiveUpdate(event.isError === true
        ? `Tool ${event.name} reported an error.`
        : `Tool ${event.name} returned (tool status only; task completion unconfirmed).`)];
    },
    snapshot() {
      const current = [...agents.values()].filter((agent) => agent.status === "queued" || active(agent.status));
      const completed = [...items.values()].filter((item) => item.completed).length;
      const summary = [
        `Agents: ${current.length} active (${current.filter((agent) => agent.status === "queued").length} queued).`,
        todosKnown ? `Todos: ${items.size - completed} pending, ${completed} completed.` : "Todos: no status received.",
        `Tools: ${[...toolCalls.values()].filter((tool) => tool.running).length} running.`,
      ];
      let bytes = Buffer.byteLength(summary.join("\n"));
      // Counts always survive clipping. Detail lines are whole, bounded facts.
      const details = [
        ...current.map((agent) => `Agent #${agent.id} (${agent.name}): ${agent.status}.`),
        ...[...items.values()].filter((item) => !item.completed).map((item) => `Todo #${item.id}: ${item.name}.`),
        ...[...toolCalls.values()].filter((tool) => tool.running).map((tool) => `Tool ${tool.name}: running.`),
      ];
      for (const line of details) {
        const size = Buffer.byteLength(line) + 1;
        if (bytes + size > 1200) {
          if (bytes + 17 <= 1200) summary.push("Details omitted.");
          break;
        }
        summary.push(line);
        bytes += size;
      }
      return summary.join("\n");
    },
    reset() {
      agents.clear();
      items.clear();
      todosKnown = false;
      toolCalls.clear();
    },
  };
}
