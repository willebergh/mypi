import assert from "node:assert/strict";
import test from "node:test";
import { createSpaceHold, isModifierOnlyEvent } from "../extensions/dictation/hold-space.ts";

const press = "\x1b[32;1:1u";
const repeat = "\x1b[32;1:2u";
const release = "\x1b[32;1:3u";

function setup() {
  const calls: string[] = [];
  const hold = createSpaceHold({
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    tap: () => calls.push("space"),
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

test("quick Space taps insert one space without recording", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  assert.deepEqual(hold.input(press), { consume: true });
  t.mock.timers.tick(999);
  hold.input(repeat);
  hold.input(release);
  t.mock.timers.tick(2000);
  assert.deepEqual(calls, ["space"]);
});

test("continuous hold starts at one second, ignores repeats, and stops on release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  hold.input(press);
  t.mock.timers.tick(500);
  hold.input(repeat);
  t.mock.timers.tick(499);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["start"]);
  hold.input(repeat);
  t.mock.timers.tick(3000);
  hold.input(release);
  hold.input(release);
  assert.deepEqual(calls, ["start", "stop"]);
});

test("separate taps never accumulate hold time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  for (let i = 0; i < 3; i++) {
    hold.input(press);
    t.mock.timers.tick(600);
    hold.input(release);
  }
  assert.deepEqual(calls, ["space", "space", "space"]);
});

test("pending space is flushed before other typing, modified Space and paste pass through", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { hold, calls } = setup();
  hold.input(" ");
  assert.equal(hold.input("b"), undefined);
  hold.input(repeat);
  hold.input(release);
  t.mock.timers.tick(2000);
  assert.deepEqual(calls, ["space"]);
  assert.equal(hold.input("\x1b[32;2:1u"), undefined);
  assert.equal(hold.input("hello world"), undefined);
});

test("cancel removes pending holds and resets after recording", (t) => {
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
  assert.deepEqual(calls, ["start", "stop", "space"]);
});
