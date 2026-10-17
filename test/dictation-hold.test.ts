import assert from "node:assert/strict";
import test from "node:test";
import { Editor, type TUI } from "@earendil-works/pi-tui";
import { createSpaceHold, isModifierOnlyEvent } from "../extensions/dictation/hold-space.ts";

const press = "\x1b[32;1:1u";
const repeat = "\x1b[32;1:2u";
const release = "\x1b[32;1:3u";

function setup() {
  const calls: string[] = [];
  const hold = createSpaceHold({
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
  });
  return { calls, hold };
}

test("standalone modifier reports are consumed instead of inserting private-use glyphs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  for (let code = 57441; code <= 57454; code++) {
    for (const event of [1, 2, 3]) {
      const data = `\x1b[${code};2:${event}u`;
      assert.equal(isModifierOnlyEvent(data), true);
      assert.deepEqual(hold.input(data), { consume: true });
    }
  }
  t.mock.timers.tick(2000);
  assert.deepEqual(calls, []);
  assert.equal(isModifierOnlyEvent("A"), false);
  assert.equal(isModifierOnlyEvent("\uE061"), false, "literal pasted text must not be treated as a key report");
  assert.equal(isModifierOnlyEvent("\x1b[97;2u"), false);
  assert.equal(isModifierOnlyEvent(press), false);
});

test("modifier-only reports do not interrupt a pending Space hold", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  hold.input(press);
  t.mock.timers.tick(600);
  hold.input("\x1b[57441;2u");
  t.mock.timers.tick(400);
  hold.input(release);
  assert.deepEqual(calls, ["start", "stop"]);
});

test("quick Space taps go straight to the native editor before any release or timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  assert.equal(hold.input(press), undefined, "do not consume the native insertion/render path");
  t.mock.timers.tick(999);
  assert.deepEqual(hold.input(repeat), { consume: true });
  assert.deepEqual(hold.input(release), { consume: true });
  t.mock.timers.tick(2000);
  assert.deepEqual(calls, []);
});

test("continuous hold starts at one second, ignores repeats, and stops once on release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  assert.equal(hold.input(press), undefined);
  t.mock.timers.tick(500);
  assert.deepEqual(hold.input(repeat), { consume: true });
  t.mock.timers.tick(499);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["start"]);
  assert.deepEqual(hold.input(repeat), { consume: true });
  t.mock.timers.tick(3000);
  hold.input(release);
  hold.input(release);
  assert.deepEqual(calls, ["start", "stop"]);
});

test("separate taps never accumulate hold time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  for (let i = 0; i < 3; i++) {
    assert.equal(hold.input(press), undefined);
    t.mock.timers.tick(600);
    assert.deepEqual(hold.input(release), { consume: true });
  }
  assert.deepEqual(calls, []);
});

test("other typing cancels the hold; modified Space and paste pass through", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  assert.equal(hold.input(" "), undefined);
  assert.equal(hold.input("b"), undefined);
  assert.deepEqual(hold.input(repeat), { consume: true });
  assert.deepEqual(hold.input(release), { consume: true });
  t.mock.timers.tick(2000);
  assert.deepEqual(calls, []);
  assert.equal(hold.input("\x1b[32;2:1u"), undefined);
  assert.equal(hold.input("hello world"), undefined);
});

test("cancel removes the hold timer and resets after recording", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  hold.input(press);
  hold.cancel();
  t.mock.timers.tick(2000);
  hold.input(release);
  assert.deepEqual(calls, []);
  hold.input(press);
  t.mock.timers.tick(1000);
  hold.input(release);
  hold.input(press);
  hold.input(release);
  assert.deepEqual(calls, ["start", "stop"]);
});

test("native editor inserts Space immediately at the cursor without duplicate or rollback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  const identity = (text: string) => text;
  const editor = new Editor({ requestRender() {} } as TUI, {
    borderColor: identity,
    selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
  });
  const input = (data: string) => {
    if (!hold.input(data)?.consume) editor.handleInput(data);
  };
  editor.setText("beforeafter");
  for (let i = 0; i < 5; i++) input("\x1b[D");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
  input(press);
  assert.equal(editor.getText(), "before after", "visible text changes on key-down, without a timer tick");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
  input(repeat);
  input(press); // Duplicate press reports must not insert another space.
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, ["start"]);
  assert.equal(editor.getText(), "before after", "starting dictation keeps the one ordinary space");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 7 });
  input(release);
  input(release);
  assert.equal(editor.getText(), "before after");
  assert.deepEqual(calls, ["start", "stop"]);
});
