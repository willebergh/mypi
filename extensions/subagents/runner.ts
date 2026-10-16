import path from "node:path";
import {
  getPackageDir,
  RpcClient,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { OutputTokenRate } from "../resource-status/core.ts";
import {
  applySubagentEvent,
  cloneSubagentState,
  parseSubagentTelemetry,
  type SubagentState,
  type SubagentTask,
} from "./core.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const EXCLUDED_CHILD_TOOLS = [
  "subagent",
  "list_subagents",
  "cancel_subagents",
  "ask_user",
  "mcp",
];

export class QueuedOperationCancelledError extends Error {
  constructor() {
    super("Queued operation was cancelled");
    this.name = "QueuedOperationCancelledError";
  }
}

export interface ScheduledOperation<T> {
  promise: Promise<T>;
  /** Returns true only when an operation was removed before it started. */
  cancel(): boolean;
}

interface QueueEntry<T> {
  started: boolean;
  operation(): Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Shared concurrency gate for background subagents across every start call. */
export class OperationScheduler {
  private active = 0;
  private readonly pending: QueueEntry<unknown>[] = [];
  private readonly concurrency: number;

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Scheduler concurrency must be a positive integer");
    }
    this.concurrency = concurrency;
  }

  schedule<T>(operation: () => Promise<T>): ScheduledOperation<T> {
    let entry: QueueEntry<T>;
    const promise = new Promise<T>((resolve, reject) => {
      entry = { started: false, operation, resolve, reject };
      this.pending.push(entry as QueueEntry<unknown>);
    });
    this.drain();

    return {
      promise,
      cancel: () => {
        if (entry.started) return false;
        const index = this.pending.indexOf(entry as QueueEntry<unknown>);
        if (index < 0) return false;
        this.pending.splice(index, 1);
        entry.reject(new QueuedOperationCancelledError());
        return true;
      },
    };
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) return;
      entry.started = true;
      this.active += 1;
      void Promise.resolve()
        .then(entry.operation)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

export interface RunSubagentOptions {
  task: SubagentTask;
  state: SubagentState;
  trustedProject: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onChange(state: SubagentState): void;
  onClient?(client: RpcClient): void;
  onClientDone?(client: RpcClient): void;
}

function childEnvironment(): Record<string, string> {
  return {
    MYPI_SUBAGENT: "1",
    CMUX_PI_HOOKS_DISABLED: "1",
    CMUX_WORKSPACE_ID: "",
    CMUX_SURFACE_ID: "",
    CMUX_TAB_ID: "",
    CMUX_PANEL_ID: "",
  };
}

function childArguments(
  task: SubagentTask,
  trustedProject: boolean,
): string[] {
  const args = [
    "--no-session",
    trustedProject ? "--approve" : "--no-approve",
    "--exclude-tools",
    EXCLUDED_CHILD_TOOLS.join(","),
  ];
  if (task.thinking) args.push("--thinking", task.thinking);
  if (task.tools !== undefined) {
    if (task.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", task.tools.join(","));
  }
  return args;
}

function hasStatus(state: SubagentState, status: SubagentState["status"]): boolean {
  return state.status === status;
}

function errorText(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = stderr.trim();
  if (!detail || message.includes(detail)) return message;
  const tail = detail.length > 2_000 ? detail.slice(-2_000) : detail;
  return `${message}\n${tail}`;
}

/** Waits for settlement while polling RPC state so a dead child frees its slot promptly. */
async function promptAndWait(
  client: RpcClient,
  task: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let liveness: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (liveness) clearInterval(liveness);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = () => finish(new Error("Subagent run aborted"));
    const unsubscribe = client.onEvent((event) => {
      if (event.type === "agent_settled") finish();
    });
    const timeout = setTimeout(
      () => finish(new Error("Timeout waiting for subagent to settle")),
      timeoutMs,
    );
    const startLivenessPolling = () => {
      if (liveness || settled) return;
      liveness = setInterval(() => {
        if (checking || settled) return;
        checking = true;
        void client.getState().then(
          (state) => {
            checking = false;
            if (!state.isStreaming) {
              finish(new Error("Subagent stopped without a settlement event"));
            }
          },
          (error) => finish(error),
        );
      }, 1_000);
      liveness.unref?.();
    };
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });

    if (signal?.aborted) {
      finish(new Error("Subagent run aborted"));
      return;
    }
    void client.prompt(task).then(
      async () => {
        if (settled) return;
        const state = await client.getState();
        if (settled) return;
        if (!state.isStreaming) {
          finish(new Error("Subagent prompt was rejected before starting"));
          return;
        }
        startLivenessPolling();
      },
      finish,
    ).catch(finish);
  });
}

export async function runSubagent(
  options: RunSubagentOptions,
): Promise<SubagentState> {
  const { state, task, signal, onChange } = options;
  const cliPath = path.join(getPackageDir(), "dist", "cli.js");
  const client = new RpcClient({
    cliPath,
    cwd: state.cwd,
    env: childEnvironment(),
    model: task.model || state.model,
    args: childArguments(task, options.trustedProject),
  });

  const publish = () => onChange(cloneSubagentState(state));
  state.status = "starting";
  state.activity = "starting process";
  state.startedAt = Date.now();
  publish();

  let visibleSignature = `${state.status}\0${state.activity}\0${state.turns}`;
  let lastContextPublish = 0;
  const tokenRate = new OutputTokenRate();
  const unsubscribe = client.onEvent((event: JsonAgentSessionEvent) => {
    const telemetry = parseSubagentTelemetry(event);
    if (telemetry) {
      state.agentFiles = telemetry.agentFiles;
      state.loadedSkills = telemetry.loadedSkills;
      publish();
      return;
    }

    if (event.type === "turn_start") {
      tokenRate.start();
    } else if (event.type === "message_start" && event.message.role === "assistant") {
      tokenRate.start();
    } else if (event.type === "message_update") {
      state.tokensPerSecond = tokenRate.update(event.usage.output);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      state.tokensPerSecond = tokenRate.finish(event.message.usage.output);
    }

    applySubagentEvent(state, event);
    const nextSignature = `${state.status}\0${state.activity}\0${state.turns}`;
    const now = Date.now();
    const contextChanged =
      event.type === "message_update" && now - lastContextPublish >= 500;
    if (
      nextSignature !== visibleSignature ||
      event.type === "message_end" ||
      event.type === "tool_execution_end" ||
      contextChanged
    ) {
      visibleSignature = nextSignature;
      if (contextChanged) lastContextPublish = now;
      publish();
    }
  });
  const abort = () => {
    void client.abort().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    if (signal?.aborted) throw new Error("Subagent run aborted");
    await client.start();
    options.onClient?.(client);
    const childState = await client.getState();
    if (childState.model) {
      state.model = `${childState.model.provider}/${childState.model.id}`;
      state.contextWindow = childState.model.contextWindow;
      publish();
    }
    if (signal?.aborted) throw new Error("Subagent run aborted");

    await promptAndWait(
      client,
      task.task,
      signal,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    if (signal?.aborted || hasStatus(state, "aborted")) {
      state.status = "aborted";
      state.activity = "aborted";
      state.error ||= "Agent was aborted";
    } else if (!hasStatus(state, "failed")) {
      state.result = (await client.getLastAssistantText()) || state.result || "";
      state.status = "completed";
      state.activity = "completed";
    }
  } catch (error) {
    if (signal?.aborted) {
      state.status = "aborted";
      state.activity = "aborted";
      state.error = "Agent was aborted";
    } else {
      state.status = "failed";
      state.activity = "failed";
      state.error = errorText(error, client.getStderr());
    }
  } finally {
    state.endedAt = Date.now();
    publish();
    signal?.removeEventListener("abort", abort);
    unsubscribe();
    options.onClientDone?.(client);
    await client.stop();
  }

  return cloneSubagentState(state);
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, values.length)) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await operation(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
