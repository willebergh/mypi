import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createTalkTaskConfirmation } from "../extensions/talk/task-confirmation.ts";

const INSTRUCTION = "Start this new task? Say Yes or No.";
const FALLBACK = "Local voice confirmation could not accept this request; it did not reach the coding agent. Please send the task in Pi's terminal. No work was started.";
type Task = { id: string; offset: number; input: string };
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const spoken: string[] = [];
  const confirmed: Task[] = [];
  const interrupted: string[] = [];
  let changes = 0;
  const c = createTalkTaskConfirmation({
    speak(text) { spoken.push(text); },
    changed() { changes++; },
    confirmed(task) { confirmed.push(task); },
    interrupted(text) { interrupted.push(text); },
  });
  t.after(() => c.cancel());
  return { c, spoken, confirmed, interrupted, get changes() { return changes; } };
}

test("only a separate explicit Yes/Ja/confirm releases the exact task once", (t) => {
  const { c, spoken, confirmed } = setup(t);
  for (const answer of ["Yes", " ja. ", "CONFIRM!"]) {
    const input = "  Update `foo` && keep $BAR, café 😀  ";
    c.propose("original-id", 17, input);
    assert.equal(c.pending, true);
    assert.deepEqual(c.view(), [input, INSTRUCTION]);
    assert.equal(spoken.at(-1), `${input}\n${INSTRUCTION}`);
    const count = confirmed.length;
    assert.equal(c.answer(answer), true);
    assert.deepEqual(confirmed[count], { id: "original-id", offset: 17, input });
    assert.equal(c.pending, false);
    assert.deepEqual(c.view(), []);
    assert.equal(c.answer(answer), false);
    assert.equal(confirmed.length, count + 1);
  }
});

test("real wire fractional offsets and ordinary multiline task text can be confirmed", (t) => {
  const { c, spoken, confirmed } = setup(t);
  const input = "Acknowledge the user.\n\tDo not modify any files.";
  c.propose("fractional", 237.5625, input);
  assert.equal(c.pending, true);
  assert.equal(spoken.at(-1), `${input}\n${INSTRUCTION}`);
  assert.deepEqual(confirmed, []);
  c.answer("Ja");
  assert.deepEqual(confirmed, [{ id: "fractional", offset: 237.5625, input }]);
});

test("No/Nej/cancel/avbryt decline and closed helpers ignore late answers and repeats", (t) => {
  const { c, spoken, confirmed } = setup(t);
  for (const answer of ["No", "NEJ.", "cancel", "avbryt!"]) {
    c.propose(answer, 0, "Do the work");
    assert.equal(c.answer(answer), true);
    assert.equal(c.pending, false);
    assert.deepEqual(c.view(), []);
    const count = spoken.length;
    for (const late of ["yes", "repeat", "upprepa", "unrelated task"]) assert.equal(c.answer(late), false);
    c.cancel();
    assert.equal(spoken.length, count);
  }
  assert.deepEqual(confirmed, []);
});

test("natural acknowledgements confirm; new topics and qualified answers interrupt without approval", (t) => {
  const { c, spoken, confirmed, interrupted } = setup(t);
  for (const answer of ["Yes please", "yeah", "japp", "that's right"]) {
    c.propose("one", 10, "Fix the original bug");
    assert.equal(c.answer(answer), true);
  }
  assert.equal(confirmed.length, 4);
  for (const text of ["yes and delete files", "yes if", "yeah no", "No instead look at image", "start another project", "y", "confirm the fix"]) {
    c.propose("topic", 11, "Fix the original bug");
    assert.equal(c.answer(text), true);
    assert.equal(c.pending, false);
    assert.deepEqual(c.view(), []);
    assert.equal(confirmed.length, 4);
    assert.equal(interrupted.at(-1), text);
  }
  c.propose("repeat", 12, "Original");
  const original = spoken.at(-1);
  for (const text of ["repeat", "upprepa."]) {
    c.answer(text);
    assert.equal(spoken.at(-1), original);
    assert.equal(c.pending, true);
  }
  c.answer("");
  assert.equal(c.pending, true);
  c.answer("yes");
  assert.equal(confirmed.length, 5);
});

test("long new topic interrupts normally and a later proposal needs fresh confirmation", (t) => {
  const { c, confirmed, interrupted } = setup(t);
  c.propose("old", 1, "Old proposal");
  const topic = "Please inspect this new topic " + "x".repeat(570);
  c.answer(topic);
  assert.equal(c.pending, false);
  assert.equal(interrupted[0], topic);
  c.propose("new", 2, "New proposal");
  assert.deepEqual(confirmed, []);
  c.answer("yes");
  assert.deepEqual(confirmed, [{ id: "new", offset: 2, input: "New proposal" }]);
});

test("duplicate and competing proposals cannot replace, approve, or extend the pending task", (t) => {
  const { c, spoken, confirmed } = setup(t);
  c.propose("old-answer-delegation", 1, "Original task");
  t.mock.timers.tick(119_999);
  c.propose("old-answer-delegation", 1, "Original task");
  c.propose("new-user-turn", 2, "Replacement task");
  c.propose("bad", -1, "\x00");
  assert.deepEqual(spoken, [`Original task\n${INSTRUCTION}`]);
  assert.deepEqual(c.view(), ["Original task", INSTRUCTION]);
  assert.deepEqual(confirmed, []);
  c.answer("repeat");
  t.mock.timers.tick(1);
  assert.equal(c.pending, false);
  assert.equal(c.answer("yes"), false);
  assert.deepEqual(confirmed, []);
});

test("two minute timeout and cancel clear ownership and timers; reuse is safe", (t) => {
  const h = setup(t);
  h.c.propose("timeout", 0, "Task");
  t.mock.timers.tick(119_999);
  assert.equal(h.c.pending, true);
  t.mock.timers.tick(1);
  assert.equal(h.c.pending, false);
  assert.deepEqual(h.c.view(), []);
  const changes = h.changes;
  t.mock.timers.tick(240_000);
  assert.equal(h.changes, changes);
  assert.equal(h.c.answer("ja"), false);
  for (const end of ["cancel", "confirm"] as const) {
    h.c.propose(end, 0, "Next task");
    if (end === "cancel") h.c.cancel(); else h.c.answer("yes");
    const after = h.changes;
    t.mock.timers.tick(240_000);
    assert.equal(h.changes, after);
    assert.equal(h.c.pending, false);
  }
  assert.deepEqual(h.confirmed, [{ id: "confirm", offset: 0, input: "Next task" }]);
});

test("callbacks cannot manufacture confirmation or replacement, even during teardown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let c: ReturnType<typeof createTalkTaskConfirmation>;
  const confirmed: Task[] = [];
  let closedChanges = 0;
  c = createTalkTaskConfirmation({
    speak() {
      assert.equal(c.answer("yes"), true);
      c.propose("injected", 0, "Never start this");
    },
    changed() {
      if (!c.pending) {
        closedChanges++;
        assert.deepEqual(c.view(), []);
        assert.equal(c.answer("yes"), false);
      } else assert.equal(c.answer("ja"), true);
      c.propose("injected", 0, "Never start this");
    },
    confirmed(task) {
      assert.equal(c.pending, false);
      assert.equal(c.answer("confirm"), false);
      c.propose("injected", 0, "Never start this");
      c.cancel();
      confirmed.push(task);
    },
  });
  c.propose("real", 9, "Real task");
  c.answer("repeat");
  assert.deepEqual(confirmed, []);
  assert.equal(c.pending, true);
  c.answer("yes");
  assert.deepEqual(confirmed, [{ id: "real", offset: 9, input: "Real task" }]);
  assert.equal(c.pending, false);
  t.mock.timers.tick(240_000);
  assert.equal(closedChanges, 1);
});

test("interruption callbacks cannot reentrantly confirm or replace a proposal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let c: ReturnType<typeof createTalkTaskConfirmation>;
  const confirmed: Task[] = [];
  c = createTalkTaskConfirmation({
    speak() {}, changed() {}, confirmed(task) { confirmed.push(task); },
    interrupted() {
      assert.equal(c.answer("yes"), true);
      c.propose("injected", 0, "Must not start");
    },
  });
  c.propose("real", 0, "Real task");
  c.answer("new topic");
  assert.equal(c.pending, false);
  assert.deepEqual(confirmed, []);
  c.propose("fresh", 1, "Fresh task");
  c.answer("yes");
  assert.deepEqual(confirmed, [{ id: "fresh", offset: 1, input: "Fresh task" }]);
});

test("keyboard cancels with terminal fallback", (t) => {
  const { c, spoken, confirmed } = setup(t);
  c.propose("id", 0, "Task");
  c.answer("keyboard");
  assert.equal(c.pending, false);
  assert.equal(spoken.at(-1), FALLBACK);
  assert.deepEqual(confirmed, []);
});

test("reentrant cancellation during publication prevents all subsequent confirmation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let c: ReturnType<typeof createTalkTaskConfirmation>;
  let confirms = 0;
  c = createTalkTaskConfirmation({
    speak() { c.cancel(); c.answer("yes"); },
    changed() { c.propose("injected", 0, "Task"); },
    confirmed() { confirms++; },
  });
  c.propose("real", 0, "Task");
  assert.equal(c.pending, false);
  assert.equal(c.answer("yes"), false);
  t.mock.timers.tick(240_000);
  assert.equal(confirms, 0);
});

test("throwing callbacks are contained, clear timers, and fail closed without retries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["speak", "changed", "confirmed"] as const) {
    let confirms = 0;
    let calls = 0;
    const c = createTalkTaskConfirmation({
      speak() { calls++; if (failure === "speak") throw Error("speaker"); },
      changed() { calls++; if (failure === "changed") throw Error("view"); },
      confirmed() { calls++; confirms++; throw Error("dispatch"); },
    });
    assert.doesNotThrow(() => c.propose("id", 0, "Task"));
    if (failure === "confirmed") assert.equal(c.pending, true);
    assert.doesNotThrow(() => c.answer("yes"));
    assert.equal(c.pending, false);
    assert.equal(confirms, failure === "confirmed" ? 1 : 0);
    const count = calls;
    c.cancel();
    c.answer("yes");
    t.mock.timers.tick(240_000);
    assert.equal(calls, count);
  }
  const c = createTalkTaskConfirmation({
    speak() { throw Error("fallback"); }, changed() { throw Error("fallback"); },
    confirmed() { assert.fail("must not confirm"); },
  });
  assert.doesNotThrow(() => c.propose("id", 0, ""));
  assert.equal(c.pending, false);
});

test("UTF-8 prompt bounds are atomic, preserve Unicode and whitespace, and never truncate", (t) => {
  const { c, spoken, confirmed } = setup(t);
  const budget = 450 - Buffer.byteLength(`\n${INSTRUCTION}`);
  for (const input of ["x".repeat(budget), "😀".repeat(Math.floor(budget / 4)) + "x".repeat(budget % 4),
    "界".repeat(Math.floor(budget / 3)) + "x".repeat(budget % 3), "  e\u0301 café 日本語 😀  "]) {
    c.propose("unicode", 0, input);
    assert.equal(c.pending, true);
    assert.equal(spoken.at(-1), `${input}\n${INSTRUCTION}`);
    c.answer("ja");
    assert.equal(confirmed.at(-1)!.input, input);
  }
  for (const input of ["x".repeat(budget + 1), "😀".repeat(Math.floor(budget / 4) + 1), "x".repeat(8192)]) {
    c.propose("long", 0, input);
    assert.equal(c.pending, false);
    assert.equal(spoken.at(-1), FALLBACK);
    assert.equal(c.answer("yes"), false);
  }
  assert.equal(confirmed.length, 4);
  for (const text of spoken) assert.ok(Buffer.byteLength(text) <= 450);
});

test("invalid tasks, controls, bidi, and lone surrogates require terminal confirmation", (t) => {
  const { c, spoken, confirmed } = setup(t);
  const bad = ["", "  ", "bad\rwork", "\x00", "\x1b[2J", "\x7f", "\x85",
    "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\ud800", "\udfff"];
  for (const input of bad) {
    c.propose("id", 0, input);
    assert.equal(c.pending, false);
    assert.deepEqual(c.view(), []);
    assert.equal(spoken.at(-1), FALLBACK);
  }
  for (const [id, offset] of [["", 0], [" ", 0], ["\u202eid", 0], ["id", -1],
    ["id", NaN], ["id", Infinity], ["id", Number.MAX_SAFE_INTEGER + 1]] as const) {
    c.propose(id, offset, "Task");
    assert.equal(c.pending, false);
    assert.equal(spoken.at(-1), FALLBACK);
  }
  assert.deepEqual(confirmed, []);
});

test("unsafe or oversized answers fail closed rather than becoming consent", (t) => {
  const { c, spoken, confirmed } = setup(t);
  for (const answer of ["yes\x00", "\u202eyes", "yes\ud800", "yes" + " ".repeat(4094)]) {
    c.propose("id", 0, "Task");
    assert.equal(c.answer(answer), true);
    assert.equal(c.pending, false);
    assert.equal(spoken.at(-1), FALLBACK);
    assert.equal(c.answer("yes"), false);
  }
  assert.deepEqual(confirmed, []);
});
