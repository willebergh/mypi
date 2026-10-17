import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createTalkTaskChannel } from "../extensions/talk/task-channel.ts";

// Only legacy nonce guard tests synthesize protocol replies from metadata.
const legacyReply = (context: string) => JSON.stringify({ talk_task_answer: JSON.parse(context).token });
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const contexts: string[] = [], spoken: string[] = [], interrupted: string[] = [];
  const confirmed: { id: string; offset: number; input: string }[] = [];
  const c = createTalkTaskChannel({
    context: (text) => contexts.push(text), speak: (text) => spoken.push(text), changed() {},
    confirmed: (task) => confirmed.push(task), interrupted: (text) => interrupted.push(text),
  });
  t.after(() => c.cancel());
  return { c, contexts, spoken, confirmed, interrupted,
    reply: () => legacyReply(contexts.at(-1)!),
    readback: () => { c.transcript("assistant", spoken.at(-1)!); c.turn("assistant", spoken.at(-1)!); },
  };
}

test("task commits raw partial Yes after prompt final, without any user final", (t) => {
  const h = setup(t), { c } = h;
  c.propose("fresh", 1.5, "Inspect the tests");
  const reply = "Yes";
  c.transcript("user", "Yes");
  assert.equal(c.delegate(reply), true);
  assert.equal(c.commits, 0);
  h.readback();
  c.delegate(reply); // Premature speech was cleared.
  assert.equal(c.commits, 0);
  c.transcript("user", "Y"); c.transcript("user", "es");
  c.delegate(reply);
  assert.equal(c.commits, 1);
  assert.deepEqual(h.confirmed, [{ id: "fresh", offset: 1.5, input: "Inspect the tests" }]);
  assert.equal(c.delegate(reply), false); c.turn("user", "No");
  assert.equal(c.delegate(reply), false);
  assert.equal(c.commits, 1);
  assert.equal(h.confirmed.length, 1);
  assert.deepEqual(c.view(), []);
  const control = JSON.parse(h.contexts[0]);
  assert.equal(control.type, "talk.task_confirmation");
  assert.equal(control.phase, "confirm");
  assert.equal(control.mode, "spoken-reply");
  assert.equal(Object.hasOwn(control, "reply"), false);
  assert.ok(Buffer.byteLength(h.contexts[0]) <= 450);
});

test("old assistant, missing start, and premature Yes cannot unlock a task", (t) => {
  const h = setup(t), { c } = h;
  c.transcript("assistant", "old output");
  c.propose("a", 0, "Read tests");
  c.transcript("user", "yes");
  c.turn("assistant", h.spoken.at(-1)!); // Even an exact final from the old turn is ineligible.
  c.turn("assistant", "final without start");
  c.delegate(h.reply());
  assert.equal(c.commits, 0);
  c.transcript("assistant", h.spoken.at(-1)!);
  c.transcript("user", "yes"); c.delegate(h.reply());
  c.turn("assistant", h.spoken.at(-1)!);
  c.delegate(h.reply());
  assert.equal(c.commits, 0);
  c.transcript("user", "ja"); c.delegate(h.reply());
  assert.equal(h.confirmed.length, 1);
});

test("repeat rotates nonce and requires its own readback; fixed deadline never extends", (t) => {
  const h = setup(t), { c } = h;
  c.propose("a", 0, "Read tests"); h.readback();
  const old = h.reply();
  t.mock.timers.tick(100_000);
  c.transcript("user", "repeat"); c.delegate(old);
  assert.equal(c.commits, 1);
  assert.notEqual(h.reply(), old);
  c.transcript("user", "yes"); c.delegate(old); c.delegate(h.reply());
  assert.equal(c.commits, 1);
  h.readback(); c.delegate(h.reply());
  assert.equal(c.commits, 1);
  t.mock.timers.tick(20_000);
  assert.equal(c.pending, false);
  c.transcript("user", "yes"); assert.equal(c.delegate(h.reply()), true);
  assert.equal(h.confirmed.length, 0);
});

test("cancel, stale IDs, topic interruption and fresh proposal keep separate ownership", (t) => {
  const h = setup(t), { c } = h;
  c.propose("old", 0, "Old work"); h.readback();
  const old = h.reply();
  c.transcript("user", "cancel"); c.delegate(old); c.delegate(old);
  assert.equal(c.commits, 1);
  c.propose("next", 1, "Next work"); h.readback();
  const next = h.reply();
  assert.notEqual(next, old);
  c.transcript("user", "Inspect another project instead");
  c.delegate(old); assert.equal(c.commits, 1);
  c.delegate(next);
  assert.deepEqual(h.interrupted, ["Inspect another project instead"]);
  assert.equal(h.confirmed.length, 0);
  c.propose("fresh", 2, "Fresh work");
  c.turn("user", "yes"); c.delegate(next);
  h.readback(); c.delegate(h.reply());
  assert.equal(c.commits, 2);
  c.transcript("user", "yes"); c.delegate(h.reply());
  assert.deepEqual(h.confirmed.map((task) => task.id), ["fresh"]);
  c.cancel(); c.cancel();
  assert.equal(c.commits, 3);
});

test("protocol input never supplies speech, including unknown keys, prototypes and overflows", (t) => {
  const h = setup(t), { c } = h;
  c.propose("a", 0, "Read tests"); h.readback();
  const token = JSON.parse(h.reply()).talk_task_answer;
  c.transcript("assistant", "yes"); c.turn("assistant", "yes");
  c.turn("user", "yes");
  for (const input of [h.reply(), JSON.stringify({ talk_task_answer: token, answer: "yes" }),
    '{"talk_task_answer":{},"__proto__":{"polluted":true}}',
    '{"talk_task_answer":"wrong","extra":"' + "x".repeat(5000) + '"}']) {
    assert.equal(c.delegate(input), true);
  }
  for (const input of ["{}", "null", "[]", "Read tests", '{"talk_answer":"other"}']) {
    assert.equal(c.delegate(input), true);
  }
  assert.equal(c.commits, 0);
  c.transcript("user", "yes"); c.delegate(h.reply());
  assert.equal(c.commits, 1);
});

test("callbacks cannot manufacture consent; commits are visible before confirmed callbacks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reply = "", prompt = "", count = 0;
  let c: ReturnType<typeof createTalkTaskChannel>;
  const attack = () => { c.transcript("user", "yes"); c.delegate(reply); };
  c = createTalkTaskChannel({
    context(text) { reply = legacyReply(text); attack(); },
    speak(text) { prompt = text; attack(); }, changed: attack,
    confirmed() { assert.equal(c.commits, 1); count++; attack(); c.propose("bad", 0, "Bad work"); },
  });
  t.after(() => c.cancel());
  c.propose("a", 0, "Read tests");
  assert.equal(c.commits, 0);
  c.transcript("assistant", prompt); c.turn("assistant", prompt);
  c.delegate(reply); assert.equal(c.commits, 0);
  c.transcript("user", "yes"); c.delegate(reply);
  assert.equal(count, 1);
  assert.equal(c.pending, false);
});

test("task readback requires the entire current prompt final and fresh raw consent", (t) => {
  const h = setup(t), { c } = h;
  c.propose("old", 0, "Inspect version 1.0");
  const previous = h.spoken.at(-1)!;
  c.cancel();
  c.propose("new", 1, "Inspect version 2.0");
  const current = h.spoken.at(-1)!;
  assert.equal(current, "Inspect version 2.0\nStart this new task? Say Yes or No.");
  const reply = h.reply();
  c.transcript("user", "yes");
  for (const final of ["Ready to help", previous, "Start this new task? Say Yes or No."]) {
    c.transcript("assistant", current);
    c.turn("assistant", final);
    c.delegate(reply);
    assert.equal(c.commits, 0);
    assert.match(c.view().at(-1)!, /waiting for readback to finish/);
  }
  c.turn("assistant", current);
  c.delegate(reply);
  assert.equal(c.commits, 0);
  const normalized = "ＩＮＳＰＥＣＴ VERSION ２．０！\n START THIS NEW TASK — SAY YES OR NO";
  c.transcript("assistant", normalized); c.turn("assistant", normalized);
  assert.match(c.view().at(-1)!, /listening/);
  c.delegate(reply);
  assert.equal(c.commits, 0); // Pre-readback Yes is not eligible.
  c.transcript("user", "yes"); c.delegate(reply);
  assert.deepEqual(h.confirmed, [{ id: "new", offset: 1, input: "Inspect version 2.0" }]);
});

test("oversized task protocol replies never become ordinary work or echo payloads", (t) => {
  const h = setup(t), { c } = h;
  const inputs = [
    " ".repeat(4200) + '{"talk_task_answer":"stale"}',
    '{"padding":"' + "x".repeat(4300) + '","talk_task_answer":"stale"}',
  ];
  for (const input of inputs) {
    assert.ok(Buffer.byteLength(input) < 8192);
    assert.equal(c.delegate(input), true);
    assert.equal(c.pending, false);
    assert.deepEqual(c.view(), []);
  }
  assert.equal(c.delegate(" ".repeat(4200) + '{"talk_answer":"stale"}'), false);
  assert.deepEqual(h.spoken, []);
  assert.deepEqual(h.contexts, []);
  c.propose("a", 0, "Read tests");
  const before = [...h.spoken];
  for (const input of inputs) assert.equal(c.delegate(input), true);
  assert.equal(c.commits, 0);
  assert.deepEqual(h.confirmed, []);
  assert.deepEqual(h.interrupted, []);
  assert.deepEqual(h.spoken, before);
  assert.ok(!c.view().join("\n").includes("stale"));
});

test("ordinary task replies require a fresh entire heard suffix and preserve actual text", (t) => {
  const h = setup(t), { c } = h;
  c.propose("a", 0, "Read tests");
  assert.equal(c.delegate("Yes"), true);
  c.transcript("user", "Yes"); c.delegate("Yes");
  assert.equal(c.commits, 0);
  h.readback(); c.delegate("Yes");
  assert.equal(c.commits, 0);
  c.transcript("user", "Yes but don't do it");
  for (const input of ["Yes", "No", "{broken", "x".repeat(8000)]) {
    assert.equal(c.delegate(input), true);
    assert.equal(c.commits, 0);
  }
  c.delegate("YES BUT DON'T DO IT");
  assert.deepEqual(h.interrupted, ["Yes but don't do it"]);
  assert.deepEqual(h.confirmed, []);
  assert.equal(c.delegate('{"talk_task_answer":"stale"}'), true);
  assert.equal(c.delegate("Read another project"), false);
});

test("fallbacks, callback failures and context cancellation never approve or strand a task", () => {
  for (const failing of ["context", "speak", "changed"]) {
    const c = createTalkTaskChannel({
      context() { if (failing === "context") throw Error(); },
      speak() { if (failing === "speak") throw Error(); },
      changed() { if (failing === "changed") throw Error(); },
      confirmed() { assert.fail("approval"); },
    });
    c.propose("a", 0, "Read tests");
    assert.equal(c.pending, false);
    assert.equal(c.commits, 0);
  }
  let c: ReturnType<typeof createTalkTaskChannel>;
  c = createTalkTaskChannel({ context() { c.cancel(); }, speak() { assert.fail("stale prompt"); },
    changed() {}, confirmed() { assert.fail("approval"); } });
  c.propose("a", 0, "Read tests"); assert.equal(c.pending, false);
  const spoken: string[] = [];
  const fallback = createTalkTaskChannel({ context() { assert.fail("fallback nonce"); },
    speak: (text) => spoken.push(text), changed() {}, confirmed() { assert.fail("approval"); } });
  fallback.propose("", 0, "invalid");
  assert.equal(spoken.length, 1);
  assert.equal(fallback.pending, false);
});
