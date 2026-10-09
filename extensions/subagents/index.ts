import path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type RpcClient,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  announceExtension,
  NESTED_AGENTS_CHANGED_EVENT,
  SKILL_LOADED_EVENT,
  type NestedAgentsChangedPayload,
  type SkillLoadedPayload,
} from "../resource-status/protocol.ts";
import { renderCompactContextBar } from "../resource-status/context-bar.ts";
import {
  cloneSubagentState,
  createSubagentState,
  formatElapsed,
  formatSubagentCounters,
  subagentCounterWidths,
  SUBAGENT_TELEMETRY_STATUS_KEY,
  type SubagentState,
  type SubagentTask,
} from "./core.ts";
import { mapWithConcurrency, runSubagent } from "./runner.ts";

const TOOL_NAME = "subagent";
const WIDGET_KEY = "mypi-subagents";
const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_RESULT_BYTES = 20 * 1_024;
const TOTAL_RESULT_BYTES = 50 * 1_024;

const ThinkingLevel = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
);

const TaskParameters = Type.Object({
  task: Type.String({ description: "Self-contained task for the subagent" }),
  label: Type.Optional(
    Type.String({ description: "Short name shown in the live agent widget" }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory; defaults to the parent session cwd" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model pattern selected for this task; omit only to intentionally inherit the parent model",
    }),
  ),
  thinking: Type.Optional(ThinkingLevel),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool allowlist; defaults to the child's normal active tools",
    }),
  ),
});

const SubagentParameters = Type.Object({
  tasks: Type.Array(TaskParameters, {
    minItems: 1,
    maxItems: MAX_TASKS,
    description: "Independent tasks to run concurrently",
  }),
  maxConcurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_CONCURRENCY,
      description: `Maximum simultaneous agents; default ${MAX_CONCURRENCY}`,
    }),
  ),
});

interface SubagentDetails {
  states: SubagentState[];
}

function statusIcon(state: SubagentState): string {
  switch (state.status) {
    case "queued":
      return "○";
    case "starting":
    case "thinking":
    case "running":
      return "◌";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "aborted":
      return "■";
  }
}

function activitySummary(state: SubagentState): string {
  const parts = [state.activity];
  const elapsed = formatElapsed(state);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

function registerChildTelemetry(pi: ExtensionAPI): void {
  if (process.env.MYPI_SUBAGENT !== "1") return;

  let ctx: ExtensionContext | undefined;
  let baseAgentFiles = new Set<string>();
  let nestedAgentFiles = new Set<string>();
  const loadedSkills = new Set<string>();
  const publish = () => {
    if (!ctx) return;
    ctx.ui.setStatus(
      SUBAGENT_TELEMETRY_STATUS_KEY,
      JSON.stringify({
        agentFiles: new Set([...baseAgentFiles, ...nestedAgentFiles]).size,
        loadedSkills: loadedSkills.size,
      }),
    );
  };

  pi.events.on(NESTED_AGENTS_CHANGED_EVENT, (data) => {
    const payload = data as NestedAgentsChangedPayload;
    nestedAgentFiles = new Set(
      (payload?.files ?? []).map((file) =>
        path.resolve(ctx?.cwd ?? process.cwd(), file),
      ),
    );
    publish();
  });

  pi.events.on(SKILL_LOADED_EVENT, (data) => {
    const skill = data as SkillLoadedPayload;
    if (!skill?.path) return;
    loadedSkills.add(path.resolve(skill.path));
    publish();
  });

  pi.on("session_start", async (_event, sessionCtx) => {
    if (sessionCtx.mode !== "rpc") return;
    ctx = sessionCtx;
    publish();
  });

  pi.on("before_agent_start", async (event) => {
    baseAgentFiles = new Set(
      event.systemPromptOptions.contextFiles
        .map((file) => file.path)
        .filter((file) => path.basename(file).toLowerCase() === "agents.md")
        .map((file) => path.resolve(ctx?.cwd ?? process.cwd(), file)),
    );
    publish();
  });
}

function truncateUtf8(text: string, maximumBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) return text;
  let value = bytes.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  value += "\n\n[Subagent output truncated]";
  return value;
}

function modelOutput(states: SubagentState[]): string {
  let remaining = TOTAL_RESULT_BYTES;
  const sections: string[] = [];
  for (const state of states) {
    const raw =
      state.status === "completed"
        ? state.result || "(no text output)"
        : state.error || `Agent ${state.status}`;
    const output = truncateUtf8(raw, Math.min(PER_RESULT_BYTES, remaining));
    remaining = Math.max(0, remaining - Buffer.byteLength(output, "utf8"));
    sections.push(
      `### ${state.label} — ${state.status}\n\n${output}`,
    );
    if (remaining === 0) {
      sections.push("[Remaining subagent outputs omitted from model context]");
      break;
    }
  }
  return sections.join("\n\n---\n\n");
}

export default function subagentsExtension(pi: ExtensionAPI) {
  registerChildTelemetry(pi);

  let states: SubagentState[] = [];
  let nextId = 1;
  let requestRender: (() => void) | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  const activeClients = new Set<RpcClient>();

  const refresh = () => requestRender?.();
  const snapshot = (): SubagentDetails => ({
    states: states.map(cloneSubagentState),
  });
  const hasActiveAgents = () =>
    states.some((state) =>
      ["queued", "starting", "thinking", "running"].includes(state.status),
    );
  const syncTimer = () => {
    if (hasActiveAgents() && !elapsedTimer) {
      elapsedTimer = setInterval(refresh, 1_000);
      elapsedTimer.unref?.();
    } else if (!hasActiveAgents() && elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  };
  const updateState = (next: SubagentState) => {
    const index = states.findIndex((state) => state.id === next.id);
    if (index >= 0) states[index] = next;
    syncTimer();
    refresh();
  };

  pi.on("session_start", async (_event, ctx) => {
    announceExtension(pi.events, { id: "subagents", label: "subagents" });
    states = [];
    nextId = 1;

    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        return {
          invalidate() {},
          dispose() {
            requestRender = undefined;
          },
          render(width: number): string[] {
            if (states.length === 0) return [];
            const availableWidth = Math.max(1, width);
            const active = states.filter((state) =>
              ["queued", "starting", "thinking", "running"].includes(state.status),
            ).length;
            const lines = [
              truncateToWidth(
                theme.fg(
                  "accent",
                  `Agents (${active} active · ${states.length} total)`,
                ),
                availableWidth,
              ),
            ];

            const counterWidths = subagentCounterWidths(states);
            for (const state of states) {
              const color =
                state.status === "completed"
                  ? "success"
                  : state.status === "failed" || state.status === "aborted"
                    ? "error"
                    : state.status === "queued"
                      ? "dim"
                      : "warning";
              const prefix =
                theme.fg(color, statusIcon(state)) +
                " " +
                theme.fg("accent", state.label) +
                theme.fg("dim", "  ");
              const left = prefix + theme.fg("dim", activitySummary(state));
              const right =
                renderCompactContextBar(
                  theme,
                  state.contextTokens,
                  state.contextWindow,
                ) +
                theme.fg(
                  "dim",
                  ` · ${formatSubagentCounters(state, counterWidths)}`,
                );
              const rightWidth = visibleWidth(right);
              const minimumGap = 2;

              if (rightWidth + minimumGap >= availableWidth) {
                lines.push(truncateToWidth(left, availableWidth, "…"));
                const rightLine = truncateToWidth(right, availableWidth, "");
                lines.push(
                  " ".repeat(
                    Math.max(0, availableWidth - visibleWidth(rightLine)),
                  ) + rightLine,
                );
                continue;
              }

              const truncatedLeft = truncateToWidth(
                left,
                availableWidth - rightWidth - minimumGap,
                "…",
              );
              lines.push(
                truncatedLeft +
                  " ".repeat(
                    availableWidth - visibleWidth(truncatedLeft) - rightWidth,
                  ) +
                  right,
              );
            }
            return lines;
          },
        };
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = undefined;
    await Promise.allSettled(
      [...activeClients].map(async (client) => {
        await client.abort().catch(() => undefined);
        await client.stop().catch(() => undefined);
      }),
    );
    activeClients.clear();
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagents",
    description:
      "Run one or more independent generic coding agents with isolated context windows. Use this for parallel research, review, or clearly separable work. Each task must be self-contained. Agents share the working tree, so do not run overlapping file mutations in parallel.",
    promptSnippet: "Delegate independent tasks to isolated generic coding agents",
    promptGuidelines: [
      "Use subagent for independent parallel research or clearly separable implementation work; keep each delegated task self-contained and avoid parallel edits to the same files.",
      "Select each subagent's model deliberately from these available choices: openai-codex/gpt-6-luna for focused, straightforward, high-volume work where speed and cost matter most; openai-codex/gpt-6.1-sol for a strong balance of intelligence and cost, including most complex work; openai-codex/gpt-6-astra for the most demanding reasoning, coding, or judgment. Set model explicitly based on the task. Do not inherit the parent model merely by default; omit model only when using the parent model is an intentional choice.",
    ],
    parameters: SubagentParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, onUpdate, ctx) {
      const tasks = parameters.tasks as SubagentTask[];
      const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      const defaults = {
        cwd: ctx.cwd,
        model: parentModel,
        thinking: ctx.thinkingLevel,
        contextWindow: ctx.model?.contextWindow,
      };
      states = tasks.map((task) =>
        createSubagentState(nextId++, task, defaults),
      );
      syncTimer();
      refresh();

      const publishUpdate = () => {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `${states.filter((state) => state.status === "completed").length}/${states.length} subagents completed`,
            },
          ],
          details: snapshot(),
        });
      };

      const results = await mapWithConcurrency(
        tasks,
        parameters.maxConcurrency ?? MAX_CONCURRENCY,
        async (task, index) =>
          runSubagent({
            task: {
              ...task,
              model: task.model || parentModel,
              thinking: task.thinking || ctx.thinkingLevel,
            },
            state: states[index],
            trustedProject:
              ctx.isProjectTrusted() &&
              path.resolve(states[index].cwd) === path.resolve(ctx.cwd),
            signal,
            onChange(next) {
              updateState(next);
              publishUpdate();
            },
            onClient(client) {
              activeClients.add(client);
            },
            onClientDone(client) {
              activeClients.delete(client);
            },
          }),
      );

      states = results;
      syncTimer();
      refresh();
      return {
        content: [{ type: "text", text: modelOutput(results) }],
        details: snapshot(),
      };
    },
    renderCall(args, theme) {
      const count = args.tasks?.length ?? 0;
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`);
      for (const [index, task] of (args.tasks ?? []).slice(0, 4).entries()) {
        text += `\n  ${theme.fg("muted", `${index + 1}.`)} ${theme.fg("accent", task.label || `agent-${index + 1}`)} ${theme.fg("dim", task.task)}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      const counterWidths = subagentCounterWidths(details.states);
      const lines = details.states.map((state) => {
        const color =
          state.status === "completed"
            ? "success"
            : state.status === "failed" || state.status === "aborted"
              ? "error"
              : "warning";
        return (
          `${theme.fg(color, statusIcon(state))} ${theme.fg("accent", state.label)}  ` +
          theme.fg("dim", `${activitySummary(state)} · `) +
          renderCompactContextBar(
            theme,
            state.contextTokens,
            state.contextWindow,
          ) +
          theme.fg(
            "dim",
            ` · ${formatSubagentCounters(state, counterWidths)}`,
          )
        );
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
