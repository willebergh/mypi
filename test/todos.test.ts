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
  assert.equal(typeof state.items[0].completedAt, "number");

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
  assert.equal(
    isTodoState({
      items: [{ id: 1, text: "x", completed: true, completedAt: 123 }],
      nextId: 2,
    }),
    true,
  );
  assert.equal(
    isTodoState({
      items: [{ id: 1, text: "x", completed: true, completedAt: "now" }],
      nextId: 2,
    }),
    false,
  );
  assert.equal(isTodoState({ items: [{ id: 1, text: "x" }], nextId: 2 }), false);
});

test("publishes todo state for the unified dashboard", async () => {
  const lifecycle = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  const published: Array<{ name: string; data: any }> = [];
  let tool: any;
  const api = {
    events: {
      emit(name: string, data: unknown) {
        published.push({ name, data });
      },
    },
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
    sessionManager: { getBranch: () => [] },
  });
  assert.deepEqual(published.at(-1)?.data.state.items, []);

  await tool.execute("call-1", { action: "add", text: "Visible" });
  assert.equal(published.at(-1)?.data.state.items[0].text, "Visible");

  await tool.execute("call-2", { action: "clear" });
  assert.deepEqual(published.at(-1)?.data.state.items, []);
});
