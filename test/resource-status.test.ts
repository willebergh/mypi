import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import resourceStatus from "../extensions/resource-status/index.ts";
import { renderCompactContextBar } from "../extensions/resource-status/context-bar.ts";
import {
  EXTENSION_LOADED_EVENT,
  NESTED_AGENTS_CHANGED_EVENT,
  OPENAI_USAGE_CHANGED_EVENT,
  SKILL_LOADED_EVENT,
  SKILLS_CHANGED_EVENT,
  SUBAGENTS_CHANGED_EVENT,
  TODOS_CHANGED_EVENT,
  isAgentInstructionFile,
} from "../extensions/resource-status/protocol.ts";
import {
  aggregateContextBarLayout,
  compactContextBar,
  compactContextBarLayout,
  compactProgressBarLayout,
  compactTokens,
  contextProgress,
  progressBar,
  resourceSummary,
  sortedUniqueLabels,
} from "../extensions/resource-status/core.ts";

test("formats stable resource summaries", () => {
  assert.equal(isAgentInstructionFile("AGENTS.md"), true);
  assert.equal(isAgentInstructionFile("AGENTS.override.md"), true);
  assert.equal(isAgentInstructionFile("CLAUDE.md"), true);
  assert.equal(isAgentInstructionFile("README.md"), false);

  assert.deepEqual(
    sortedUniqueLabels([
      { id: "b", label: "Beta" },
      { id: "a", label: "Alpha" },
      { id: "a", label: "Alpha updated" },
    ]),
    ["Alpha updated", "Beta"],
  );
  assert.equal(resourceSummary("Skills", []), "Skills (0): none");
  assert.equal(resourceSummary("Skills", ["one", "two"]), "Skills (2): one · two");

  assert.deepEqual(contextProgress(
    { tokens: 136_000, contextWindow: 272_000, percent: 50 },
    80,
  ), {
    percent: 50,
    tokens: 136_000,
    contextWindow: 272_000,
    barWidth: 32,
    filled: 16,
    tokenLabel: "136k/272k",
  });
  assert.deepEqual(progressBar(75, 80, 24), {
    percent: 75,
    barWidth: 32,
    filled: 24,
  });
  assert.equal(
    compactContextBar(253_000, 272_000, 93.9),
    "[███93.9%████████████253k/272k█░░]",
  );

  const visibleBar = (layout: { cells: string[] }) =>
    `[${layout.cells.map((cell) => cell === "░" ? " " : cell).join("")}]`;
  assert.equal(compactTokens(1_360_000), "1.36M");
  assert.equal(
    visibleBar(aggregateContextBarLayout(378_080, 1_360_000)),
    "[█27.8%               378k/1.36M ]",
  );
  assert.equal(
    visibleBar(compactProgressBarLayout(46, "↻4d 21h", "Weekly")),
    "[█Weekly████████46.0%    ↻4d 21h ]",
  );
  const modelBars = [
    ["5.6-sol", 176_000, "[█5.6-sol       27.8%  176k/272k ]"],
    ["5.6-lunar", 76_000, "[█5.6-lunar     27.8%   76k/272k ]"],
    ["5.6-terra", 76_000, "[█5.6-terra     27.8%   76k/272k ]"],
    ["6-astra", 76_000, "[█6-astra       27.8%   76k/272k ]"],
  ] as const;
  for (const [model, tokens, expected] of modelBars) {
    assert.equal(
      visibleBar(compactContextBarLayout(tokens, 272_000, 27.8, model)),
      expected,
    );
  }

  const styled = renderCompactContextBar(
    {
      fg: (_color: string, text: string) => text,
      inverse: (text: string) => `<bg>${text}</bg>`,
    } as any,
    136_000,
    272_000,
    50,
  );
  assert.match(styled, /<bg>5<\/bg><bg>0<\/bg><bg>\.<\/bg><bg>0<\/bg><bg>%<\/bg>/);
  assert.match(
    styled,
    /<bg>1<\/bg><bg>3<\/bg><bg>6<\/bg><bg>k<\/bg><bg>\/<\/bg>/,
  );
  assert.match(styled, /<bg> <\/bg>/);
});

test("renders and refreshes the below-editor resource widget", async () => {
  const lifecycle = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  const bus = new Map<string, Array<(data: unknown) => void>>();
  let widgetFactory: any;
  let widgetOptions: any;
  let footerFactory: any;
  let editorFactory: any;
  let renders = 0;

  const events = {
    on(name: string, handler: (data: unknown) => void) {
      const handlers = bus.get(name) ?? [];
      handlers.push(handler);
      bus.set(name, handlers);
      return () => undefined;
    },
    emit(name: string, data: unknown) {
      for (const handler of bus.get(name) ?? []) handler(data);
    },
  };
  const api = {
    events,
    appendEntry() {},
    getSessionName: () => "Refactor auth",
    setSessionName() {},
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
      return () => undefined;
    },
  };
  resourceStatus(api as any);

  events.emit(EXTENSION_LOADED_EVENT, { id: "nested-agents", label: "nested-agents" });
  events.emit(SKILLS_CHANGED_EVENT, {
    skills: [{ name: "shadcn", path: "/repo/packages/ui/.agents/skills/shadcn/SKILL.md" }],
  });

  const ctx = {
    mode: "tui",
    model: {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      contextWindow: 272_000,
    },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({
      tokens: 136_000,
      contextWindow: 272_000,
      percent: 50,
    }),
    ui: {
      setWidget(_key: string, factory: any, options: any) {
        widgetFactory = factory;
        widgetOptions = options;
      },
      setFooter(factory: any) {
        footerFactory = factory;
      },
      setEditorComponent(factory: any) {
        editorFactory = factory;
      },
      async input() {
        return undefined;
      },
    },
  };
  for (const handler of lifecycle.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  assert.deepEqual(widgetOptions, { placement: "belowEditor" });
  assert.equal(typeof editorFactory, "function");
  assert.deepEqual(footerFactory().render(200), []);
  const component = widgetFactory(
    { requestRender: () => renders++ },
    {
      fg: (_color: string, value: string) => value,
      bg: (_color: string, value: string) => `{${value}}`,
      inverse: (value: string) => value,
      strikethrough: (value: string) => value,
    },
  );
  const initial = component.render(200);
  assert.equal(initial.length, 1);
  assert.match(initial[0], /^Session: Refactor auth\s+0s · A\(0\) · S\(0\) · T\(0\/0\) · /);
  assert.match(initial[0], /\[█5\.6-sol       50\.0%  136k\/272k \]$/);
  assert.doesNotMatch(initial.join("\n"), /Extensions/);

  events.emit(NESTED_AGENTS_CHANGED_EVENT, {
    files: ["packages/ui/AGENTS.md"],
  });
  assert.match(component.render(200).join("\n"), /Agent dirs: packages\/ui/);

  events.emit(SKILL_LOADED_EVENT, {
    name: "shadcn",
    path: "/repo/packages/ui/.agents/skills/shadcn/SKILL.md",
  });
  assert.match(component.render(200).join("\n"), /Skills: shadcn/);

  events.emit(SKILLS_CHANGED_EVENT, {
    skills: [
      {
        name: "shadcn",
        path: "/repo/packages/ui/.agents/skills/shadcn/SKILL.md",
      },
      { name: "testing", path: "/repo/testing/SKILL.md" },
    ],
  });
  assert.equal(renders, 3);
  assert.match(component.render(200).join("\n"), /Skills: shadcn/);

  events.emit(OPENAI_USAGE_CHANGED_EVENT, {
    status: "ready",
    snapshot: {
      planType: "plus",
      updatedAt: Date.now(),
      primary: {
        label: "5h",
        remainingPercent: 75,
        resetAfterSeconds: 7_200,
      },
      secondary: {
        label: "weekly",
        remainingPercent: 25,
        resetAfterSeconds: 259_200,
      },
    },
  });
  assert.equal(renders, 4);
  const usageLines = component
    .render(200)
    .filter((line: string) => line.trimStart().startsWith("[█"));
  assert.deepEqual(usageLines.slice(-2).map((line: string) => line.trimStart()), [
    "[█5h█████       25.0%        ↻2h ]",
    "[█Weekly████████75.0%████    ↻3d ]",
  ]);

  const endedAt = Date.now();
  events.emit(SUBAGENTS_CHANGED_EVENT, {
    states: [
      {
        id: 1,
        label: "Chart architecture",
        task: "Inspect charts",
        cwd: "/repo",
        status: "completed",
        activity: "completed",
        startedAt: endedAt - 155_000,
        endedAt,
        turns: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        model: "openai-codex/gpt-5.6-sol",
        contextTokens: 76_000,
        contextWindow: 272_000,
        agentFiles: 5,
        loadedSkills: 1,
        todosCompleted: 3,
        todosTotal: 3,
      },
    ],
  });
  events.emit(TODOS_CHANGED_EVENT, {
    state: {
      items: [
        { id: 1, text: "Completed and hidden", completed: true },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: index + 2,
          text: `Active todo ${index + 1}`,
          completed: false,
        })),
      ],
      nextId: 8,
    },
  });
  const dashboard = component.render(200).join("\n");
  assert.match(dashboard, /^Session: Refactor auth.*T\(1\/7\)/m);
  assert.match(dashboard, /^Agents\s+2m35s · A\(5\)/m);
  assert.match(dashboard, /✓ Chart architecture  completed/);
  assert.match(dashboard, /Todos \(1\/7 completed\)/);
  assert.match(dashboard, /✓ #1 Completed and hidden/);
  assert.match(dashboard, /○ #2 Active todo 1/);
  assert.match(dashboard, /○ #5 Active todo 4/);
  assert.doesNotMatch(dashboard, /Active todo 5/);
  assert.doesNotMatch(dashboard, /Active todo 6/);
  assert.match(dashboard, /… 2 more active todos/);

  const wrapped = component.render(24);
  assert.ok(wrapped.length > 4);
  assert.ok(wrapped.every((line: string) => visibleWidth(line) <= 24));
  assert.match(wrapped.join("\n"), /shadcn/);
  assert.match(wrapped.join("\n"), /5\.6-sol/);
  assert.match(wrapped.join("\n"), /272k/);
  assert.doesNotMatch(wrapped.join("\n"), /testing/);
});
