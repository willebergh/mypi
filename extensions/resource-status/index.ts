import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  CustomEditor,
  parseSkillBlock,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { readSkillName } from "../monorepo-skills/core.ts";
import {
  formatDuration,
  formatOpenAiUsageState,
  usageWindowResetSeconds,
  type OpenAiUsageState,
  type UsageWindow,
} from "../openai-usage/core.ts";
import {
  resourceSummary,
  sortedUniqueLabels,
} from "./core.ts";
import type { SubagentState } from "../subagents/core.ts";
import { formatElapsed } from "../subagents/core.ts";
import { isTodoState, type TodoState } from "../todos/core.ts";
import {
  renderAggregateContextBar,
  renderCompactContextBar,
  renderCompactProgressBar,
} from "./context-bar.ts";
import {
  EXTENSION_LOADED_EVENT,
  NESTED_AGENTS_CHANGED_EVENT,
  OPENAI_USAGE_CHANGED_EVENT,
  SKILL_LOADED_EVENT,
  SKILLS_CHANGED_EVENT,
  SUBAGENTS_CHANGED_EVENT,
  TODOS_CHANGED_EVENT,
  announceExtension,
  type ExtensionLoadedPayload,
  type NestedAgentsChangedPayload,
  type SkillLoadedPayload,
  type SkillsChangedPayload,
  type SubagentsChangedPayload,
  type TodosChangedPayload,
  isAgentInstructionFile,
} from "./protocol.ts";

const WIDGET_KEY = "mypi-resource-status";

interface SessionRowControls {
  isSelected(): boolean;
  select(): void;
  deselect(): void;
  edit(): void;
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function compactModelLabel(model: string | undefined): string {
  if (!model) return "Model";
  const id = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return id.replace(/^gpt-/, "");
}

function subagentIcon(state: SubagentState): string {
  if (state.status === "completed") return "✓";
  if (state.status === "failed") return "✗";
  if (state.status === "aborted") return "■";
  if (state.status === "queued") return "○";
  return "◌";
}

class SessionNavigationEditor extends CustomEditor {
  private readonly sessionRow: SessionRowControls;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    sessionRow: SessionRowControls,
  ) {
    super(tui, theme, keybindings);
    this.sessionRow = sessionRow;
  }

  handleInput(data: string): void {
    if (this.sessionRow.isSelected()) {
      if (matchesKey(data, "enter")) {
        this.sessionRow.edit();
        return;
      }
      if (matchesKey(data, "up") || matchesKey(data, "escape")) {
        this.sessionRow.deselect();
        return;
      }
      if (matchesKey(data, "down")) return;

      this.sessionRow.deselect();
      super.handleInput(data);
      return;
    }

    if (matchesKey(data, "down") && this.getText().length === 0) {
      this.sessionRow.select();
      return;
    }

    super.handleInput(data);
  }
}

export default function resourceStatus(pi: ExtensionAPI) {
  const extensions = new Map<string, ExtensionLoadedPayload>();
  const skills = new Map<string, string>();
  const loadedSkillPaths = new Set<string>();
  let loadedAgentDirectories: string[] = [];
  let baseAgentFiles = new Set<string>();
  let openAiUsage: OpenAiUsageState = { status: "inactive" };
  let subagentStates: SubagentState[] = [];
  let todoState: TodoState = { items: [], nextId: 1 };
  let sessionName: string | undefined;
  let sessionStartedAt = Date.now();
  let sessionRowSelected = false;
  let editingSessionName = false;
  let requestRender: (() => void) | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;

  const refresh = () => requestRender?.();

  pi.events.on(EXTENSION_LOADED_EVENT, (data) => {
    const extension = data as ExtensionLoadedPayload;
    if (!extension?.id || !extension.label) return;
    extensions.set(extension.id, extension);
    refresh();
  });

  pi.events.on(SKILLS_CHANGED_EVENT, (data) => {
    const payload = data as SkillsChangedPayload;
    skills.clear();
    for (const skill of payload?.skills ?? []) {
      if (skill.name && skill.path) skills.set(skill.path, skill.name);
    }
    refresh();
  });

  pi.events.on(NESTED_AGENTS_CHANGED_EVENT, (data) => {
    const payload = data as NestedAgentsChangedPayload;
    loadedAgentDirectories = [
      ...new Set(
        (payload?.files ?? []).map((file) => {
          const directory = path.posix.dirname(file);
          return directory === "." ? "." : directory;
        }),
      ),
    ].sort((a, b) => a.localeCompare(b));
    refresh();
  });

  pi.events.on(OPENAI_USAGE_CHANGED_EVENT, (data) => {
    openAiUsage = data as OpenAiUsageState;
    refresh();
  });

  pi.events.on(SUBAGENTS_CHANGED_EVENT, (data) => {
    const payload = data as SubagentsChangedPayload;
    subagentStates = payload?.states ?? [];
    refresh();
  });

  pi.events.on(TODOS_CHANGED_EVENT, (data) => {
    const payload = data as TodosChangedPayload;
    todoState = payload?.state ?? { items: [], nextId: 1 };
    refresh();
  });

  pi.events.on(SKILL_LOADED_EVENT, (data) => {
    const skill = data as SkillLoadedPayload;
    if (!skill?.name || !skill.path) return;

    skills.set(skill.path, skill.name);
    if (!loadedSkillPaths.has(skill.path)) {
      loadedSkillPaths.add(skill.path);
      pi.appendEntry(SKILL_LOADED_EVENT, skill);
    }
    refresh();
  });

  const reportLoadedSkill = async (
    rawPath: string,
    cwd: string,
    declaredName?: string,
  ) => {
    let skillPath: string;
    try {
      skillPath = await realpath(
        path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath),
      );
    } catch {
      return;
    }

    const knownName = skills.get(skillPath);
    if (!knownName && path.basename(skillPath) !== "SKILL.md") return;
    const name = declaredName ?? knownName ?? (await readSkillName(skillPath));
    pi.events.emit(SKILL_LOADED_EVENT, { name, path: skillPath });
  };

  pi.on("before_agent_start", async (event, ctx) => {
    baseAgentFiles = new Set(
      event.systemPromptOptions.contextFiles
        .map((file) => file.path)
        .filter((file) => isAgentInstructionFile(path.basename(file)))
        .map((file) => path.resolve(ctx.cwd, file)),
    );
    const skill = parseSkillBlock(event.prompt);
    if (skill) await reportLoadedSkill(skill.location, ctx.cwd, skill.name);
    refresh();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return;
    const rawPath = (event.input as Record<string, unknown>).path;
    if (typeof rawPath === "string") {
      await reportLoadedSkill(rawPath, ctx.cwd);
    }
  });

  pi.registerCommand("mypi-resources", {
    description: "Show resources tracked by the mypi status widget",
    handler: async (_args, ctx) => {
      const extensionLabels = sortedUniqueLabels([...extensions.values()]);
      const skillLabels = [...skills.entries()]
        .filter(([skillPath]) => loadedSkillPaths.has(skillPath))
        .map(([, name]) => name)
        .sort((a, b) => a.localeCompare(b));
      ctx.ui.notify(
        `${resourceSummary("Extensions", extensionLabels)}\n${resourceSummary("Agent dirs", loadedAgentDirectories)}\n${resourceSummary("Skills", skillLabels)}`,
        "info",
      );
    },
  });

  pi.on("session_info_changed", async (event) => {
    sessionName = event.name;
    refresh();
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionName = pi.getSessionName();
    sessionStartedAt = Date.now();
    sessionRowSelected = false;
    subagentStates = [];
    todoState = { items: [], nextId: 1 };
    loadedSkillPaths.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SKILL_LOADED_EVENT) {
        const skill = entry.data as SkillLoadedPayload | undefined;
        if (!skill?.name || !skill.path) continue;
        skills.set(skill.path, skill.name);
        loadedSkillPaths.add(skill.path);
        continue;
      }
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "todo"
      ) {
        const details = entry.message.details as
          | { state?: unknown }
          | undefined;
        if (isTodoState(details?.state)) {
          todoState = {
            items: details.state.items.map((item) => ({ ...item })),
            nextId: details.state.nextId,
          };
        }
      }
    }

    announceExtension(pi.events, {
      id: "resource-status",
      label: "resource-status",
    });

    if (ctx.mode !== "tui") return;

    elapsedTimer = setInterval(refresh, 1_000);
    elapsedTimer.unref?.();

    ctx.ui.setFooter(() => ({
      invalidate() {},
      render(): string[] {
        return [];
      },
    }));

    const setSessionRowSelected = (selected: boolean) => {
      sessionRowSelected = selected;
      refresh();
    };
    const editSessionName = async () => {
      if (editingSessionName) return;
      editingSessionName = true;
      try {
        const nextName = await ctx.ui.custom<string | undefined>(
          (_tui, theme, _keybindings, done) => {
            const input = new Input({
              prompt: theme.fg("accent", "Session: "),
              placeholder: "unnamed",
              placeholderStyle: (text) => theme.fg("dim", text),
            });
            input.setValue(sessionName ?? "");
            input.onSubmit = (value) => done(value);
            input.onEscape = () => done(undefined);
            return input;
          },
        );
        if (nextName !== undefined) pi.setSessionName(nextName.trim());
      } finally {
        editingSessionName = false;
        setSessionRowSelected(false);
      }
    };
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new SessionNavigationEditor(tui, theme, keybindings, {
        isSelected: () => sessionRowSelected,
        select: () => setSessionRowSelected(true),
        deselect: () => setSessionRowSelected(false),
        edit: () => void editSessionName(),
      }),
    );

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
            const availableWidth = Math.max(1, width);
            const now = Date.now();
            const skillEntries = [...skills.entries()]
              .filter(([skillPath]) => loadedSkillPaths.has(skillPath))
              .sort((left, right) => left[1].localeCompare(right[1]));
            const usage = ctx.getContextUsage();
            const model = ctx.model;
            const contextWindow = usage?.contextWindow ?? model?.contextWindow;
            const mainCompleted = todoState.items.filter((item) => item.completed).length;
            const mainAgentFiles = baseAgentFiles.size + loadedAgentDirectories.length;
            const aggregate = subagentStates.reduce(
              (total, state) => ({
                elapsed:
                  total.elapsed +
                  Math.max(0, (state.endedAt ?? now) - (state.startedAt ?? now)),
                agentFiles: total.agentFiles + state.agentFiles,
                skills: total.skills + state.loadedSkills,
                todosCompleted: total.todosCompleted + state.todosCompleted,
                todosTotal: total.todosTotal + state.todosTotal,
                contextTokens: total.contextTokens + state.contextTokens,
                contextWindow: total.contextWindow + (state.contextWindow ?? 0),
              }),
              {
                elapsed: 0,
                agentFiles: 0,
                skills: 0,
                todosCompleted: 0,
                todosTotal: 0,
                contextTokens: 0,
                contextWindow: 0,
              },
            );
            const elapsedValues = [
              elapsedLabel(now - sessionStartedAt),
              ...(subagentStates.length > 0
                ? [elapsedLabel(aggregate.elapsed)]
                : []),
              ...subagentStates.map((state) => formatElapsed(state, now)),
            ];
            const elapsedWidth = Math.max(...elapsedValues.map((value) => value.length));
            const agentWidth = Math.max(
              ...[mainAgentFiles, aggregate.agentFiles, ...subagentStates.map((state) => state.agentFiles)]
                .map((value) => `A(${value})`.length),
            );
            const skillWidth = Math.max(
              ...[loadedSkillPaths.size, aggregate.skills, ...subagentStates.map((state) => state.loadedSkills)]
                .map((value) => `S(${value})`.length),
            );
            const todoWidth = Math.max(
              ...[
                `T(${mainCompleted}/${todoState.items.length})`,
                `T(${aggregate.todosCompleted}/${aggregate.todosTotal})`,
                ...subagentStates.map(
                  (state) => `T(${state.todosCompleted}/${state.todosTotal})`,
                ),
              ].map((value) => value.length),
            );
            const metrics = (
              elapsed: string,
              agentFiles: number,
              loadedSkills: number,
              todosCompleted: number,
              todosTotal: number,
              bar: string,
            ) =>
              theme.fg(
                "dim",
                elapsed.padStart(elapsedWidth) +
                  " · " +
                  `A(${agentFiles})`.padEnd(agentWidth) +
                  " · " +
                  `S(${loadedSkills})`.padEnd(skillWidth) +
                  " · " +
                  `T(${todosCompleted}/${todosTotal})`.padEnd(todoWidth) +
                  " · ",
              ) + bar;
            const row = (left: string, right: string): string[] => {
              const rightWidth = visibleWidth(right);
              if (rightWidth + 2 >= availableWidth) {
                const wrappedRight = wrapTextWithAnsi(right, availableWidth);
                return [
                  truncateToWidth(left, availableWidth, "…"),
                  ...wrappedRight.map(
                    (rightLine) =>
                      " ".repeat(
                        Math.max(0, availableWidth - visibleWidth(rightLine)),
                      ) + rightLine,
                  ),
                ];
              }
              const leftLine = truncateToWidth(
                left,
                availableWidth - rightWidth - 2,
                "…",
              );
              return [
                leftLine +
                  " ".repeat(
                    Math.max(2, availableWidth - visibleWidth(leftLine) - rightWidth),
                  ) +
                  right,
              ];
            };

            const mainBar =
              usage && contextWindow
                ? renderCompactContextBar(
                    theme,
                    usage.tokens,
                    contextWindow,
                    usage.percent,
                    compactModelLabel(model?.id),
                  )
                : theme.fg("dim", "[Context unavailable             ]");
            const sessionRows = row(
              theme.fg("dim", `Session: ${sessionName || "Unnamed"}`),
              metrics(
                elapsedValues[0],
                mainAgentFiles,
                loadedSkillPaths.size,
                mainCompleted,
                todoState.items.length,
                mainBar,
              ),
            );
            if (sessionRowSelected) {
              sessionRows[0] = theme.bg(
                "selectedBg",
                sessionRows[0] +
                  " ".repeat(Math.max(0, availableWidth - visibleWidth(sessionRows[0]))),
              );
            }

            const lines = [...sessionRows];
            if (subagentStates.length > 0) {
              const aggregateBar =
                aggregate.contextWindow > 0
                  ? renderAggregateContextBar(
                      theme,
                      aggregate.contextTokens,
                      aggregate.contextWindow,
                    )
                  : theme.fg("dim", "[Context unavailable             ]");
              lines.push(
                ...row(
                  theme.fg("accent", "Agents"),
                  metrics(
                    elapsedLabel(aggregate.elapsed),
                    aggregate.agentFiles,
                    aggregate.skills,
                    aggregate.todosCompleted,
                    aggregate.todosTotal,
                    aggregateBar,
                  ),
                ),
              );

              for (const state of subagentStates) {
                const color =
                  state.status === "completed"
                    ? "success"
                    : state.status === "failed" || state.status === "aborted"
                      ? "error"
                      : state.status === "queued"
                        ? "dim"
                        : "warning";
                const left =
                  "  " +
                  theme.fg(color, subagentIcon(state)) +
                  " " +
                  theme.fg("accent", state.label) +
                  theme.fg("dim", `  ${state.activity}`);
                const bar = renderCompactContextBar(
                  theme,
                  state.contextTokens,
                  state.contextWindow,
                  undefined,
                  compactModelLabel(state.model),
                );
                lines.push(
                  ...row(
                    left,
                    metrics(
                      formatElapsed(state, now),
                      state.agentFiles,
                      state.loadedSkills,
                      state.todosCompleted,
                      state.todosTotal,
                      bar,
                    ),
                  ),
                );
              }
            }

            if (openAiUsage.status === "ready") {
              const windows = [
                openAiUsage.snapshot.primary,
                openAiUsage.snapshot.secondary,
              ].filter((window): window is UsageWindow => Boolean(window));
              for (const window of windows) {
                const used =
                  window.usedPercent ??
                  (window.remainingPercent === undefined
                    ? null
                    : 100 - window.remainingPercent);
                const label = window.label.replace(/^./, (character) =>
                  character.toUpperCase(),
                );
                const reset = formatDuration(
                  usageWindowResetSeconds(window, now),
                );
                const bar = renderCompactProgressBar(
                  theme,
                  used,
                  `↻${reset ?? "?"}`,
                  label,
                );
                lines.push(
                  " ".repeat(Math.max(0, availableWidth - visibleWidth(bar))) + bar,
                );
              }
            } else {
              const text = formatOpenAiUsageState(openAiUsage);
              if (text) {
                lines.push(
                  ...wrapTextWithAnsi(
                    theme.fg(openAiUsage.status === "error" ? "error" : "dim", text),
                    availableWidth,
                  ),
                );
              }
            }

            if (todoState.items.length > 0) {
              lines.push("", theme.fg("accent", `Todos (${mainCompleted}/${todoState.items.length} completed)`));
              const activeTodos = todoState.items.filter((item) => !item.completed);
              let latestCompleted: TodoState["items"][number] | undefined;
              for (const item of todoState.items) {
                if (!item.completed) continue;
                if (!latestCompleted) {
                  latestCompleted = item;
                } else if (
                  item.completedAt !== undefined &&
                  (latestCompleted.completedAt === undefined ||
                    item.completedAt > latestCompleted.completedAt)
                ) {
                  latestCompleted = item;
                } else if (
                  item.completedAt === undefined &&
                  latestCompleted.completedAt === undefined
                ) {
                  latestCompleted = item;
                }
              }
              const activeLimit = latestCompleted ? 4 : 5;
              const visibleIds = new Set([
                ...activeTodos.slice(0, activeLimit).map((item) => item.id),
                ...(latestCompleted ? [latestCompleted.id] : []),
              ]);
              for (const item of todoState.items.filter((item) => visibleIds.has(item.id))) {
                const marker = item.completed
                  ? theme.fg("success", "✓")
                  : theme.fg("dim", "○");
                const id = theme.fg("accent", `#${item.id}`);
                const text = item.completed
                  ? theme.fg("dim", theme.strikethrough(item.text))
                  : theme.fg("text", item.text);
                lines.push(
                  ...wrapTextWithAnsi(
                    `  ${marker} ${id} ${text}`,
                    availableWidth,
                  ),
                );
              }
              if (activeTodos.length > activeLimit) {
                const remaining = activeTodos.length - activeLimit;
                lines.push(
                  theme.fg(
                    "dim",
                    `  … ${remaining} more active todo${remaining === 1 ? "" : "s"}`,
                  ),
                );
              }
            }

            const detailLines: string[] = [];
            if (loadedAgentDirectories.length > 0) {
              detailLines.push(
                theme.fg("dim", `Agent dirs: ${loadedAgentDirectories.join(" · ")}`),
              );
            }
            if (skillEntries.length > 0) {
              detailLines.push(
                theme.fg("dim", `Skills: ${skillEntries.map(([, name]) => name).join(" · ")}`),
              );
            }
            if (detailLines.length > 0) {
              lines.push("");
              for (const detail of detailLines) {
                lines.push(...wrapTextWithAnsi(detail, availableWidth));
              }
            }

            return lines.map((line) => truncateToWidth(line, availableWidth));
          },
        };
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("turn_end", refresh);
  pi.on("agent_settled", refresh);
  pi.on("session_compact", refresh);
  pi.on("model_select", refresh);

  pi.on("session_shutdown", async (_event, ctx) => {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.setEditorComponent(undefined);
    }
  });
}
