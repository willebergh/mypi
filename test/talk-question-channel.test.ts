import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { normalizeQuestions } from "../extensions/ask-user/core.ts";
import { createTalkQuestionChannel } from "../extensions/talk/question-channel.ts";

// Legacy guard fixtures only; normal spoken replies never copy a control token.
const legacyReply = (context: string) => JSON.stringify({ talk_answer: JSON.parse(context).token });
const questions = () => normalizeQuestions([{ id: "choice", question: "Which choice?", options: [
  { label: "Yes" }, { label: "No" },
] }]);
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const contexts: string[] = [];
  const spoken: string[] = [];
  const c = createTalkQuestionChannel({
    context: (text) => contexts.push(text), speak: (text) => spoken.push(text), changed() {},
  });
  t.after(() => c.cancel());
  return { c, contexts, spoken,
    reply: () => legacyReply(contexts.at(-1)!),
    readback: () => { c.transcript("assistant", spoken.at(-1)!); c.turn("assistant", spoken.at(-1)!); },
  };
}

test("plain One and Yes handoffs use actual speech and canonical readback without user finals", async (t) => {
  const h = setup(t); const { c } = h;
  const qs = questions();
  const pending = c.ask(qs);
  assert.equal(JSON.parse(h.contexts[0]).phase, "answer");
  assert.equal(c.commits, 0);
  c.transcript("user", "One");
  assert.match(c.view().at(-1)!, /answer: heard reply; waiting for voice handoff/);
  assert.equal(c.delegate("One"), true);
  assert.equal(c.commits, 1);
  assert.equal(h.spoken.at(-1), "You chose: Yes. Say Yes to confirm or No to change.");
  assert.equal(JSON.parse(h.contexts.at(-1)!).phase, "confirm");
  assert.match(c.view().at(-1)!, /confirm: waiting for readback to finish/);
  h.readback();
  assert.match(c.view().at(-1)!, /confirm: listening/);
  c.transcript("user", "Yes [breath");
  assert.equal(c.delegate("Yes"), true);
  assert.equal(c.commits, 2);
  const result = (await pending)!;
  assert.strictEqual(result.questions, qs);
  assert.deepEqual(result.answers, [{ id: "choice", question: "Which choice?", skipped: false,
    answers: [{ label: "Yes", custom: false }] }]);
  assert.equal(result.cancelled, false);
  assert.deepEqual(c.view(), []);
  assert.equal(c.delegate("Yes"), false);
  assert.equal(c.commits, 2);
  for (const text of h.contexts) {
    assert.ok(Buffer.byteLength(text) <= 450);
    const control = JSON.parse(text);
    assert.equal(control.type, "talk.question");
    assert.equal(control.mode, "spoken-reply");
    assert.equal(Object.hasOwn(control, "reply"), false);
  }
});

test("stale/double commits and late user finals cannot confirm or contaminate a fresh generation", async (t) => {
  const h = setup(t); const { c } = h;
  const p = c.ask(questions()); const first = h.reply();
  c.transcript("user", "One"); c.delegate(first);
  const confirm = h.reply();
  c.delegate(first); c.turn("user", "One Quiet handoffs Hello");
  h.readback();
  c.delegate(confirm);
  assert.match(c.view().at(-1)!, /Waiting for a voice reply matching heard speech.*listening/);
  c.transcript("user", "yes");
  c.delegate(first);
  assert.equal(c.pending, true);
  c.delegate(confirm);
  assert.equal((await p)?.cancelled, false);
  const next = c.ask(questions());
  c.transcript("user", "two"); c.delegate(confirm);
  assert.match(c.view().at(-1)!, /heard reply; waiting for voice handoff/);
  c.delegate(h.reply()); h.readback(); c.transcript("user", "yes"); c.delegate(h.reply());
  assert.equal((await next)?.answers[0].answers[0].label, "No");
});

test("delegation payloads and assistant/model text never supply answers; recognized invalid replies stay local", async (t) => {
  const h = setup(t); const { c } = h;
  const p = c.ask(questions());
  const token = JSON.parse(h.reply()).talk_answer;
  c.transcript("assistant", "One"); c.turn("assistant", "One");
  c.turn("user", "One");
  for (const input of [h.reply(), JSON.stringify({ talk_answer: token, answer: "One" }),
    JSON.stringify({ talk_answer: { answer: "One" } }), JSON.stringify({ talk_answer: token, __proto__: null }),
    '{"talk_answer":"wrong","__proto__":{"polluted":true}}',
    '{"talk_answer":"wrong","answer":"' + "x".repeat(5000) + '"}']) {
    assert.equal(c.delegate(input), true);
  }
  assert.equal(h.spoken.length, 1);
  for (const input of ["Please inspect the project", "{}", "null", "[]", '"One"', "{broken}", '{"task":"One"}']) {
    assert.equal(c.delegate(input), true);
  }
  c.transcript("user", "two");
  assert.equal(c.delegate(JSON.stringify({ talk_answer: token, answer: "One" })), true);
  assert.equal(h.spoken.length, 1);
  c.delegate(h.reply()); h.readback(); c.transcript("user", "yes"); c.delegate(h.reply());
  assert.equal((await p)?.answers[0].answers[0].label, "No");
});

test("old active assistant final is not the current readback; premature/same-utterance Yes is discarded", async (t) => {
  const h = setup(t); const { c } = h;
  c.transcript("assistant", "An old question");
  c.transcript("user", "old input before ask");
  const p = c.ask(questions());
  c.transcript("user", "One"); c.delegate(h.reply());
  const confirm = h.reply();
  c.transcript("user", "Yes"); c.delegate(confirm);
  c.turn("assistant", "An old question");
  assert.match(c.view().at(-1)!, /waiting for readback to finish/);
  c.delegate(confirm);
  c.transcript("assistant", h.spoken.at(-1)!);
  c.transcript("user", "yes"); c.delegate(confirm);
  c.turn("assistant", h.spoken.at(-1)!);
  c.delegate(confirm); // Old Yes has been discarded.
  assert.equal(c.pending, true);
  assert.match(c.view().at(-1)!, /listening/);
  c.turn("assistant", "duplicate final");
  c.transcript("user", "Yes please");
  c.turn("user", "One"); // Late original final is ignored.
  c.delegate(confirm);
  assert.equal((await p)?.cancelled, false);
});

test("barge-in is retained during first fresh question output, without treating Yes as approval", async (t) => {
  const h = setup(t); const { c } = h;
  c.transcript("user", "tail before ask");
  const p = c.ask(questions());
  c.transcript("user", "One");
  c.transcript("assistant", "Which choice?");
  c.delegate(h.reply());
  assert.match(h.spoken.at(-1)!, /You chose: Yes/);
  c.turn("assistant", "Which choice?");
  c.turn("assistant", "readback final without a start");
  c.transcript("user", "yes"); c.delegate(h.reply());
  assert.match(c.view().at(-1)!, /waiting for readback to finish/);
  h.readback();
  c.transcript("user", "yes"); c.delegate(h.reply());
  assert.equal((await p)?.cancelled, false);
});

test("actual long topics and unknown confirmation speech use the original parser and result schema", async (t) => {
  const h = setup(t); const { c } = h;
  const request = "I just sent " + "x".repeat(4096 - Buffer.byteLength("I just sent "));
  for (const phase of ["answer", "confirm"]) {
    const p = c.ask(questions());
    if (phase === "confirm") {
      c.transcript("user", "one"); c.delegate(h.reply()); h.readback();
    }
    const actual = (phase === "confirm" ? "Yes, " : "") + request;
    c.transcript("user", actual); c.delegate(h.reply());
    const result = (await p)!;
    assert.equal(result.userRequest, request);
    assert.equal(result.cancelled, phase === "answer");
  }
  const p = c.ask(questions());
  c.transcript("user", "one"); c.delegate(h.reply()); h.readback();
  c.transcript("user", "yes but don't do it"); c.delegate(h.reply());
  assert.equal((await p)?.userRequest, "yes but don't do it");
});

test("escape, abort, idle timeout, invalid requests, and oversized/unsafe actual input clear state", async (t) => {
  const h = setup(t); const { c } = h;
  assert.equal(await c.ask([]), undefined);
  assert.deepEqual(c.view(), []);
  for (const speech of ["keyboard", "terminal", "\x1b[2J", "x".repeat(321), "界".repeat(2000)]) {
    const p = c.ask(questions());
    c.transcript("user", speech); c.delegate(h.reply());
    assert.equal(await p, undefined);
    assert.deepEqual(c.view(), []);
  }
  const cancelled = c.ask(questions());
  c.transcript("user", "cancel"); c.delegate(h.reply());
  assert.equal((await cancelled)?.cancelled, true);
  const abort = new AbortController();
  const p = c.ask(questions(), abort.signal); abort.abort();
  assert.equal((await p)?.cancelled, true);
  assert.equal((await c.ask(questions(), abort.signal))?.cancelled, true);
  const timeout = c.ask(questions());
  c.transcript("user", "One");
  t.mock.timers.tick(120_000);
  assert.equal(await timeout, undefined);
  assert.deepEqual(c.view(), []);
  const escaped = c.ask(questions()); c.cancel();
  assert.equal(await escaped, undefined);
});

test("reentrant context/speak/changed cannot manufacture input or consume a buffered reply", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reply = "", prompt = "";
  let c: ReturnType<typeof createTalkQuestionChannel>;
  const attack = () => {
    c.transcript("user", "yes");
    c.delegate(reply);
  };
  c = createTalkQuestionChannel({
    context(text) { reply = legacyReply(text); attack(); },
    speak(text) { prompt = text; attack(); }, changed: attack,
  });
  t.after(() => c.cancel());
  const p = c.ask(questions());
  assert.match(c.view().at(-1)!, /answer: listening/);
  c.transcript("user", "one"); c.delegate(reply);
  assert.match(c.view().join("\n"), /You chose: Yes/);
  c.transcript("assistant", prompt); c.turn("assistant", prompt);
  c.delegate(reply);
  assert.equal(c.pending, true);
  c.transcript("user", "yes"); c.delegate(reply);
  assert.equal((await p)?.cancelled, false);
});

test("context cancellation and callback failures cannot strand tools or speak stale prompts", async () => {
  for (const failing of ["context", "speak", "changed"]) {
    const c = createTalkQuestionChannel({
      context() { if (failing === "context") throw Error("context"); },
      speak() { if (failing === "speak") throw Error("speak"); },
      changed() { if (failing === "changed") throw Error("changed"); },
    });
    assert.equal(await c.ask(questions()), undefined);
    assert.equal(c.pending, false);
    assert.deepEqual(c.view(), []);
  }
  let c: ReturnType<typeof createTalkQuestionChannel>;
  c = createTalkQuestionChannel({ context() { c.cancel(); }, speak() { assert.fail("stale prompt"); }, changed() {} });
  assert.equal(await c.ask(questions()), undefined);
});


test("repeat rotates every prompt nonce and ignored commits preserve raw speech", async (t) => {
  const h = setup(t), { c } = h;
  const p = c.ask(questions());
  const first = h.reply();
  c.transcript("user", "repeat"); c.delegate(first);
  const repeated = h.reply();
  assert.notEqual(repeated, first);
  assert.equal(c.commits, 1);
  c.transcript("user", "one"); c.delegate(first);
  assert.equal(c.commits, 1);
  c.delegate(repeated);
  assert.equal(c.commits, 2);
  h.readback();
  const before = h.contexts.length;
  c.transcript("user", "repeat"); c.delegate(h.reply());
  // The helper publishes the question and then its canonical readback.
  assert.equal(h.contexts.length, before + 2);
  const intermediate = legacyReply(h.contexts.at(-2)!);
  assert.notEqual(intermediate, h.reply());
  c.transcript("user", "yes"); c.delegate(intermediate); c.delegate(h.reply());
  assert.equal(c.commits, 3);
  h.readback(); c.delegate(h.reply());
  assert.equal(c.commits, 3);
  c.transcript("user", "yes"); c.delegate(h.reply());
  assert.equal((await p)?.cancelled, false);
  assert.equal(c.commits, 4);
});

test("only the current canonical final unlocks confirmation, not unrelated or previous candidates", async (t) => {
  const h = setup(t), { c } = h;
  const p = c.ask(normalizeQuestions([{ id: "color", question: "Which?", options: [
    { label: "Blue 2.0" }, { label: "Red 3.0" },
  ] }]));
  c.transcript("user", "one"); c.delegate(h.reply());
  const previous = h.spoken.at(-1)!;
  h.readback();
  c.transcript("user", "two"); c.delegate(h.reply());
  const current = h.spoken.at(-1)!;
  const reply = h.reply();
  c.transcript("user", "yes");
  for (const final of ["I will inspect the project now", previous, current + " extra words"]) {
    c.transcript("assistant", current); // The final, not partial text, must match.
    c.turn("assistant", final);
    c.delegate(reply);
    assert.equal(c.commits, 2);
    assert.match(c.view().at(-1)!, /waiting for readback to finish/);
  }
  c.turn("assistant", current); // Unrelated finals do not leave a reusable start.
  c.delegate(reply);
  assert.equal(c.commits, 2);
  const normalized = "YOU CHOSE — Ｒｅｄ ３．０！ SAY YES TO CONFIRM / OR NO TO CHANGE";
  c.transcript("assistant", normalized); c.turn("assistant", normalized);
  assert.match(c.view().at(-1)!, /listening/);
  c.delegate(reply); // The premature Yes is cleared only by the matching final.
  assert.equal(c.commits, 2);
  c.transcript("user", "yes"); c.delegate(reply);
  assert.equal((await p)?.answers[0].answers[0].label, "Red 3.0");
});

test("oversized reserved replies are intercepted across the whole input, even while idle", (t) => {
  const h = setup(t), { c } = h;
  const inputs = [
    " ".repeat(4200) + '{"talk_answer":"stale"}',
    '{"padding":"' + "x".repeat(4300) + '","talk_answer":"stale"}',
  ];
  for (const input of inputs) {
    assert.ok(Buffer.byteLength(input) < 8192);
    assert.equal(c.delegate(input), true);
    assert.equal(c.pending, false);
    assert.equal(c.commits, 0);
    assert.deepEqual(c.view(), []);
  }
  assert.equal(c.delegate(" ".repeat(4200) + '{"talk_task_answer":"stale"}'), false);
  assert.deepEqual(h.spoken, []);
  assert.deepEqual(h.contexts, []);
  void c.ask(questions());
  const before = [...h.spoken];
  for (const input of inputs) assert.equal(c.delegate(input), true);
  assert.deepEqual(h.spoken, before);
  assert.equal(c.commits, 0);
  assert.ok(!c.view().join("\n").includes("stale"));
});

test("plain replies reject stale choices, forged labels, and truncated confirmation bodies", async (t) => {
  const h = setup(t), { c } = h;
  const p = c.ask(questions());
  // No raw audio, assistant speech, or user finals can authorize input.
  for (const input of ["One", "{}", "{broken", "x".repeat(8000)]) {
    assert.equal(c.delegate(input), true);
  }
  c.transcript("assistant", "One"); c.turn("assistant", "One");
  c.turn("user", "One"); c.delegate("One");
  assert.equal(c.commits, 0);
  c.transcript("user", "One");
  c.delegate("No"); // A plausible option label is not evidence of speech.
  assert.equal(c.commits, 0);
  c.delegate("One");
  c.transcript("user", "Yes"); c.delegate("Yes");
  assert.equal(c.commits, 1); // Still waiting for canonical readback.
  h.readback();
  c.delegate("Yes"); // Premature raw Yes was discarded.
  assert.equal(c.commits, 1);
  c.transcript("user", "Yes but don't do it");
  c.delegate("One"); // Previous generation's choice cannot match fresh speech.
  c.delegate("Yes"); // Nor may the model drop the rest of a spoken reply.
  assert.equal(c.commits, 1);
  assert.match(c.view().at(-1)!, /Waiting for a voice reply matching heard speech/);
  assert.ok(!c.view().at(-1)!.includes("don't do it"));
  c.delegate("YES BUT DON'T DO IT");
  assert.equal((await p)?.userRequest, "Yes but don't do it");
});

test("a normal suffix handoff ignores earlier attempts and preserves actual heard spelling", async (t) => {
  const h = setup(t), { c } = h;
  const p = c.ask(normalizeQuestions([{ id: "mode", question: "Which mode?", options: [
    { label: "Loud" }, { label: "Quiet" },
  ] }]));
  c.transcript("user", "One "); c.transcript("user", "Quiet");
  assert.equal(c.delegate("Quiet"), true);
  assert.equal(h.spoken.at(-1), "You chose: Quiet. Say Yes to confirm or No to change.");
  h.readback();
  c.transcript("user", "Yes"); c.delegate("One");
  assert.equal(c.commits, 1);
  c.delegate("Yes");
  assert.deepEqual((await p)?.answers[0].answers, [{ label: "Quiet", custom: false }]);
});

test("oversized ordinary matching speech stays local without committing or extending the deadline", async (t) => {
  const h = setup(t), { c } = h;
  const p = c.ask(questions());
  t.mock.timers.tick(100_000);
  const input = "x".repeat(5000);
  c.transcript("user", input);
  assert.equal(c.delegate(input), true);
  assert.equal(c.commits, 0);
  assert.equal(c.pending, true);
  t.mock.timers.tick(20_000);
  assert.equal(await p, undefined);
  assert.equal(c.delegate('{"talk_answer":"stale"}'), true);
  assert.equal(c.delegate("ordinary project work"), false);
});

test("question commit count is published before source changed callbacks reenter", async () => {
  let reply = "", prompt = "", expected = 0;
  let c: ReturnType<typeof createTalkQuestionChannel>;
  c = createTalkQuestionChannel({
    context(text) { reply = legacyReply(text); }, speak(text) { prompt = text; },
    changed() { assert.equal(c.commits, expected); c.delegate(reply); },
  });
  const p = c.ask(questions());
  c.transcript("user", "one"); expected = 1; c.delegate(reply);
  c.transcript("assistant", prompt); c.turn("assistant", prompt);
  c.transcript("user", "yes"); expected = 2; c.delegate(reply);
  assert.equal((await p)?.cancelled, false);
});
