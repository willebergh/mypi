import assert from "node:assert/strict";
import test from "node:test";
import todosExtension from "../extensions/todos/index.ts";
import {
  applyTodoAction,
  emptyTodoState,
  isTodoState,
} from "../extensions/todos/core.ts";

test("supports the complete todo lifecycle", () => {
  let state = emptyTodoState();

  ({ state } = applyTodoAction(state, { action: "add", text: "Build extension" }));
  ({ state } = applyTodoAction(state, { action: "add", text: "Test extension" }));
  assert.deepEqual(state.items.map((item) => item.id), [1, 2]);

  ({ state } = applyTodoAction(state, {
    action: "edit",
    id: 1,
    text: "Build todo extension",
  }));
  assert.equal(state.items[0].text, "Build todo extension");

  ({ state } = applyTodoAction(state, { action: "complete", id: 1 }));
  assert.equal(state.items[0].completed, true);

  ({ state } = applyTodoAction(state, { action: "remove", id: 2 }));
  assert.deepEqual(state.items.map((item) => item.id), [1]);

  const listed = applyTodoAction(state, { action: "list" });
  assert.equal(listed.message, "[x] #1: Build todo extension");

  ({ state } = applyTodoAction(state, { action: "clear" }));
  assert.deepEqual(state, emptyTodoState());
});

test("validates todo operations without mutating the prior state", () => {
  const state = applyTodoAction(emptyTodoState(), {
    action: "add",
    text: "Keep me",
  }).state;

  assert.throws(
    () => applyTodoAction(state, { action: "edit", id: 1, text: "  " }),
    /Non-empty todo text/,
  );
  assert.throws(
    () => applyTodoAction(state, { action: "remove", id: 999 }),
    /not found/,
  );
  assert.equal(state.items[0].text, "Keep me");
});

test("recognizes persisted todo state", () => {
  assert.equal(isTodoState({ items: [], nextId: 1 }), true);
  assert.equal(isTodoState({ items: [{ id: 1, text: "x" }], nextId: 2 }), false);
});

test("hides the todo widget while the list is empty", async () => {
  const lifecycle = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  let tool: any;
  let widgetFactory: any;
  const api = {
    events: { emit() {} },
    on(name: string, handler: (event: unknown, ctx: any) => Promise<void>) {
      lifecycle.set(name, handler);
    },
    registerTool(value: any) {
      tool = value;
    },
    registerCommand() {},
  };
  todosExtension(api as any);

  await lifecycle.get("session_start")?.({}, {
    mode: "tui",
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget(_key: string, factory: any) {
        widgetFactory = factory;
      },
    },
  });

  const component = widgetFactory(
    { requestRender() {} },
    {
      fg: (_color: string, value: string) => value,
      strikethrough: (value: string) => value,
    },
  );
  assert.deepEqual(component.render(80), []);

  await tool.execute("call-1", { action: "add", text: "Visible" });
  assert.match(component.render(80).join("\n"), /Visible/);

  await tool.execute("call-2", { action: "clear" });
  assert.deepEqual(component.render(80), []);
});
