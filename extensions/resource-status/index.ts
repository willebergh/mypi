import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseSkillBlock,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
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
  contextProgress,
  progressBar,
  resourceSummary,
  sortedUniqueLabels,
} from "./core.ts";
import {
  EXTENSION_LOADED_EVENT,
  NESTED_AGENTS_CHANGED_EVENT,
  OPENAI_USAGE_CHANGED_EVENT,
  SKILL_LOADED_EVENT,
  SKILLS_CHANGED_EVENT,
  announceExtension,
  type ExtensionLoadedPayload,
  type NestedAgentsChangedPayload,
  type SkillLoadedPayload,
  type SkillsChangedPayload,
} from "./protocol.ts";

const WIDGET_KEY = "mypi-resource-status";

export default function resourceStatus(pi: ExtensionAPI) {
  const extensions = new Map<string, ExtensionLoadedPayload>();
  const skills = new Map<string, string>();
  const loadedSkillPaths = new Set<string>();
  let loadedAgentDirectories: string[] = [];
  let openAiUsage: OpenAiUsageState = { status: "inactive" };
  let requestRender: (() => void) | undefined;

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
    const skill = parseSkillBlock(event.prompt);
    if (skill) await reportLoadedSkill(skill.location, ctx.cwd, skill.name);
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

  pi.on("session_start", async (_event, ctx) => {
    loadedSkillPaths.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SKILL_LOADED_EVENT) {
        continue;
      }
      const skill = entry.data as SkillLoadedPayload | undefined;
      if (!skill?.name || !skill.path) continue;
      skills.set(skill.path, skill.name);
      loadedSkillPaths.add(skill.path);
    }

    announceExtension(pi.events, {
      id: "resource-status",
      label: "resource-status",
    });

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
            const extensionLabels = sortedUniqueLabels([...extensions.values()]);
            const skillEntries = [...skills.entries()]
              .filter(([skillPath]) => loadedSkillPaths.has(skillPath))
              .sort((left, right) => left[1].localeCompare(right[1]));
            const extensionLine = resourceSummary("Extensions", extensionLabels);
            const agentDirectoriesLine =
              loadedAgentDirectories.length === 0
                ? theme.fg("dim", resourceSummary("Agent dirs", []))
                : theme.fg(
                    "dim",
                    `Agent dirs (${loadedAgentDirectories.length}): `,
                  ) +
                  loadedAgentDirectories
                    .map((directory) =>
                      theme.bg("selectedBg", theme.fg("text", directory)),
                    )
                    .join(theme.fg("dim", " · "));
            const skillLine =
              skillEntries.length === 0
                ? theme.fg("dim", resourceSummary("Skills", []))
                : theme.fg("dim", `Skills (${skillEntries.length}): `) +
                  skillEntries
                    .map(([, name]) =>
                      theme.bg("selectedBg", theme.fg("text", name)),
                    )
                    .join(theme.fg("dim", " · "));
            const availableWidth = Math.max(1, width);
            const usage = ctx.getContextUsage();
            const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
            let contextLine: string;

            if (!usage || !contextWindow) {
              contextLine = theme.fg("dim", "Context: unavailable");
            } else {
              const progress = contextProgress(
                { ...usage, contextWindow },
                availableWidth,
              );
              const percentLabel =
                progress.percent === null
                  ? "?"
                  : `${progress.percent.toFixed(1)}%`;
              const color =
                progress.percent === null
                  ? "dim"
                  : progress.percent >= 90
                    ? "error"
                    : progress.percent >= 70
                      ? "warning"
                      : "success";
              contextLine =
                theme.fg("dim", "Context [") +
                theme.fg(color, "█".repeat(progress.filled)) +
                theme.fg(
                  "dim",
                  "░".repeat(progress.barWidth - progress.filled),
                ) +
                theme.fg(
                  "dim",
                  `] ${percentLabel} · ${progress.tokenLabel}`,
                );
            }

            const openAiLines: string[] = [];
            if (openAiUsage.status === "ready") {
              const windows = [
                openAiUsage.snapshot.primary,
                openAiUsage.snapshot.secondary,
              ].filter((window): window is UsageWindow => Boolean(window));
              const plan = openAiUsage.snapshot.planType
                ? ` (${openAiUsage.snapshot.planType})`
                : "";

              if (windows.length === 0) {
                openAiLines.push(theme.fg("dim", `OpenAI${plan}: limits unavailable`));
              } else {
                for (const window of windows) {
                  const remaining =
                    window.remainingPercent ??
                    (window.usedPercent === undefined
                      ? null
                      : 100 - window.usedPercent);
                  const percentLabel =
                    remaining === null
                      ? "?%"
                      : `${remaining >= 10 ? remaining.toFixed(0) : remaining.toFixed(1)}%`;
                  const reset = formatDuration(
                    usageWindowResetSeconds(window, Date.now()),
                  );
                  const prefix = `OpenAI${plan} ${window.label} [`;
                  const suffix = `] ${percentLabel} left${reset ? ` · ↻${reset}` : ""}`;
                  const progress = progressBar(
                    remaining,
                    availableWidth,
                    visibleWidth(prefix) + visibleWidth(suffix),
                  );
                  const color =
                    progress.percent === null
                      ? "dim"
                      : progress.percent <= 10
                        ? "error"
                        : progress.percent <= 30
                          ? "warning"
                          : "success";
                  openAiLines.push(
                    truncateToWidth(
                      theme.fg("dim", prefix) +
                        theme.fg(color, "█".repeat(progress.filled)) +
                        theme.fg(
                          "dim",
                          "░".repeat(progress.barWidth - progress.filled),
                        ) +
                        theme.fg("dim", suffix),
                      availableWidth,
                    ),
                  );
                }
              }
            } else {
              const text = formatOpenAiUsageState(openAiUsage);
              if (text) {
                openAiLines.push(
                  ...wrapTextWithAnsi(
                    theme.fg(openAiUsage.status === "error" ? "error" : "dim", text),
                    availableWidth,
                  ),
                );
              }
            }

            return [
              ...wrapTextWithAnsi(
                theme.fg("dim", extensionLine),
                availableWidth,
              ),
              ...wrapTextWithAnsi(
                theme.fg("dim", agentDirectoriesLine),
                availableWidth,
              ),
              ...wrapTextWithAnsi(skillLine, availableWidth),
              truncateToWidth(contextLine, availableWidth),
              ...openAiLines,
            ];
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
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
