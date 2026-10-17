import assert from "node:assert/strict";
import test from "node:test";
import { createTranscriptPreview } from "../extensions/dictation/preview.ts";

function editor(initial: string, cursor = initial.length) {
  let value = initial;
  return {
    getEditorText: () => value,
    setEditorText(text: string) { value = text; cursor = value.length; },
    pasteToEditor(text: string) { value = value.slice(0, cursor) + text + value.slice(cursor); cursor += text.length; },
  };
}

test("live preview replaces only its insertion range in a multiline draft", () => {
  const ui = editor("before\nafter", 7);
  const preview = createTranscriptPreview(ui);
  assert.equal(preview.update("hel"), true);
  assert.equal(ui.getEditorText(), "before\nhel after");
  preview.update("Hello!");
  assert.equal(ui.getEditorText(), "before\nHello! after");
  preview.accept();
  preview.rollback();
  assert.equal(ui.getEditorText(), "before\nHello! after");
});

test("repeated draft text cannot confuse the insertion range", () => {
  const ui = editor("hello ");
  const preview = createTranscriptPreview(ui);
  preview.update("hello");
  preview.update("hello world");
  assert.equal(ui.getEditorText(), "hello hello world ");
  preview.rollback();
  assert.equal(ui.getEditorText(), "hello ");
});

test("empty correction removes provisional text without deleting the draft", () => {
  const ui = editor("draft");
  const preview = createTranscriptPreview(ui);
  preview.update("noise");
  preview.update("");
  assert.equal(ui.getEditorText(), "draft");
  preview.rollback();
  assert.equal(ui.getEditorText(), "draft");
});

test("rollback preserves independent edits", () => {
  const ui = editor("draft");
  const preview = createTranscriptPreview(ui);
  preview.update("hello");
  ui.setEditorText("edited");
  assert.equal(preview.update("hello world"), false);
  preview.rollback();
  assert.equal(ui.getEditorText(), "edited");
});
