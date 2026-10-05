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
} from "../extensions/resource-status/protocol.ts";
import {
  compactContextBar,
  contextProgress,
  progressBar,
  resourceSummary,
  sortedUniqueLabels,
} from "../extensions/resource-status/core.ts";

test("formats stable resource summaries", () => {
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
    model: { contextWindow: 272_000 },
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
    },
  );
  assert.deepEqual(component.render(200), [
    "Session: Refactor auth",
    "Context [███50.0%████████░░░░136k/272k░░░]",
  ]);
  assert.doesNotMatch(component.render(200).join("\n"), /Extensions/);

  events.emit(NESTED_AGENTS_CHANGED_EVENT, {
    files: ["packages/ui/AGENTS.md"],
  });
  assert.equal(component.render(200)[1], "Agent dirs (1): {packages/ui}");

  events.emit(SKILL_LOADED_EVENT, {
    name: "shadcn",
    path: "/repo/packages/ui/.agents/skills/shadcn/SKILL.md",
  });
  assert.equal(component.render(200)[2], "Skills (1): {shadcn}");

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
  assert.equal(component.render(200)[2], "Skills (1): {shadcn}");

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
  assert.deepEqual(component.render(200).slice(-2), [
    "5h [████████░░░░░░░░░░░░░░░░░░░░░░░░]",
    "Weekly [████████████████████████░░░░░░░░]",
  ]);

  const wrapped = component.render(24);
  assert.ok(wrapped.length > 4);
  assert.ok(wrapped.every((line: string) => visibleWidth(line) <= 24));
  assert.match(wrapped.join("\n"), /shadcn/);
  assert.doesNotMatch(wrapped.join("\n"), /testing/);
});
