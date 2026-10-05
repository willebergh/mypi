import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { compactContextBar } from "../resource-status/core.ts";

export { compactContextBar } from "../resource-status/core.ts";

export type SubagentStatus =
  | "queued"
  | "starting"
  | "thinking"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SubagentState {
  id: number;
  label: string;
  task: string;
  cwd: string;
  status: SubagentStatus;
  activity: string;
  startedAt?: number;
  endedAt?: number;
  turns: number;
  usage: SubagentUsage;
  model?: string;
  contextTokens: number;
  contextWindow?: number;
  agentFiles: number;
  loadedSkills: number;
  todosCompleted: number;
  todosTotal: number;
  result?: string;
  error?: string;
}

export interface SubagentTask {
  task: string;
  label?: string;
  cwd?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
}

export interface SubagentDefaults {
  cwd: string;
  model?: string;
  thinking?: SubagentTask["thinking"];
  tools?: string[];
  contextWindow?: number;
}

export function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function createSubagentState(
  id: number,
  task: SubagentTask,
  defaults: SubagentDefaults,
): SubagentState {
  return {
    id,
    label: task.label?.trim() || `agent-${id}`,
    task: task.task,
    cwd: task.cwd || defaults.cwd,
    status: "queued",
    activity: "queued",
    turns: 0,
    usage: emptyUsage(),
    model: task.model || defaults.model,
    contextTokens: 0,
    contextWindow: defaults.contextWindow,
    agentFiles: 0,
    loadedSkills: 0,
    todosCompleted: 0,
    todosTotal: 0,
  };
}

function addUsage(state: SubagentState, message: unknown): void {
  if (!message || typeof message !== "object") return;
  const typed = message as Record<string, unknown>;
  const usage = typed.usage;
  if (!usage || typeof usage !== "object") return;
  const values = usage as Record<string, unknown>;
  const cost = values.cost;
  state.usage.input += typeof values.input === "number" ? values.input : 0;
  state.usage.output += typeof values.output === "number" ? values.output : 0;
  state.usage.cacheRead += typeof values.cacheRead === "number" ? values.cacheRead : 0;
  state.usage.cacheWrite += typeof values.cacheWrite === "number" ? values.cacheWrite : 0;
  if (cost && typeof cost === "object") {
    const total = (cost as Record<string, unknown>).total;
    state.usage.cost += typeof total === "number" ? total : 0;
  }
  if (typeof values.totalTokens === "number") {
    state.contextTokens = Math.max(state.contextTokens, values.totalTokens);
  }
}

function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const typed = message as Record<string, unknown>;
  if (typed.role !== "assistant" || !Array.isArray(typed.content)) return undefined;
  const parts = typed.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function applySubagentEvent(
  state: SubagentState,
  event: JsonAgentSessionEvent,
): void {
  switch (event.type) {
    case "agent_start":
      state.status = "running";
      state.activity = "starting agent";
      break;
    case "turn_start":
      state.status = "thinking";
      state.activity = "thinking";
      state.turns += 1;
      break;
    case "message_update": {
      if (typeof event.usage.totalTokens === "number") {
        state.contextTokens = Math.max(
          state.contextTokens,
          event.usage.totalTokens,
        );
      }
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_start" || update.type === "thinking_delta") {
        state.status = "thinking";
        state.activity = "thinking";
      } else if (update.type === "text_start" || update.type === "text_delta") {
        state.status = "running";
        state.activity = "responding";
      } else if (update.type === "toolcall_start") {
        state.status = "running";
        state.activity = `preparing ${update.toolName}`;
      }
      break;
    }
    case "tool_execution_start":
    case "tool_execution_update":
      state.status = "running";
      state.activity = `using ${event.toolName}`;
      break;
    case "tool_execution_end": {
      state.status = "running";
      state.activity = event.isError
        ? `${event.toolName} failed`
        : `${event.toolName} finished`;
      if (event.toolName === "todo") {
        const details = event.result?.details as Record<string, unknown> | undefined;
        const todoState = details?.state as Record<string, unknown> | undefined;
        const items = todoState?.items;
        if (Array.isArray(items)) {
          state.todosTotal = items.length;
          state.todosCompleted = items.filter(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              (item as Record<string, unknown>).completed === true,
          ).length;
        }
      }
      break;
    }
    case "message_end": {
      const message = event.message as unknown;
      if (
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).role === "assistant"
      ) {
        addUsage(state, message);
        const text = assistantText(message);
        if (text) state.result = text;
        const typed = message as Record<string, unknown>;
        if (typeof typed.model === "string") state.model = typed.model;
        if (typed.stopReason === "error") {
          state.status = "failed";
          state.activity = "failed";
          state.error =
            typeof typed.errorMessage === "string"
              ? typed.errorMessage
              : "Agent request failed";
        } else if (typed.stopReason === "aborted") {
          state.status = "aborted";
          state.activity = "aborted";
          state.error = "Agent was aborted";
        }
      }
      break;
    }
    case "auto_retry_start":
      state.status = "running";
      state.activity = `retrying (${event.attempt}/${event.maxAttempts})`;
      break;
    case "compaction_start":
      state.status = "running";
      state.activity = "compacting context";
      break;
    case "compaction_end":
      if (event.willRetry) {
        state.status = "running";
        state.activity = "retrying compaction";
      } else if (event.aborted) {
        state.status = "aborted";
        state.activity = "compaction aborted";
        state.error = event.errorMessage || "Context compaction was aborted";
      } else if (event.errorMessage) {
        state.status = "failed";
        state.activity = "compaction failed";
        state.error = event.errorMessage;
      } else if (event.result) {
        state.status = "running";
        state.activity = "context compacted";
        if (typeof event.result.estimatedTokensAfter === "number") {
          state.contextTokens = event.result.estimatedTokensAfter;
        }
      }
      break;
    case "agent_settled":
      if (state.status !== "failed" && state.status !== "aborted") {
        state.status = "completed";
        state.activity = "completed";
      }
      break;
  }
}

export function formatElapsed(state: SubagentState, now = Date.now()): string {
  if (state.startedAt === undefined) return "";
  const elapsed = Math.max(0, (state.endedAt ?? now) - state.startedAt);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export interface SubagentTelemetry {
  agentFiles: number;
  loadedSkills: number;
}

export const SUBAGENT_TELEMETRY_STATUS_KEY = "mypi-subagent-telemetry";

export function parseSubagentTelemetry(event: unknown): SubagentTelemetry | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as Record<string, unknown>;
  if (
    value.type !== "extension_ui_request" ||
    value.method !== "setStatus" ||
    value.statusKey !== SUBAGENT_TELEMETRY_STATUS_KEY ||
    typeof value.statusText !== "string"
  ) {
    return undefined;
  }
  try {
    const telemetry = JSON.parse(value.statusText) as Record<string, unknown>;
    if (
      typeof telemetry.agentFiles === "number" &&
      typeof telemetry.loadedSkills === "number"
    ) {
      return {
        agentFiles: telemetry.agentFiles,
        loadedSkills: telemetry.loadedSkills,
      };
    }
  } catch {
    // Ignore malformed child telemetry.
  }
  return undefined;
}

export function cloneSubagentState(state: SubagentState): SubagentState {
  return { ...state, usage: { ...state.usage } };
}
