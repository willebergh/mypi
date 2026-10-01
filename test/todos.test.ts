import assert from "node:assert/strict";
import test from "node:test";
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
