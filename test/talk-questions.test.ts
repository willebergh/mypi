import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { formatAskUserResult, normalizeQuestions, type UserQuestion } from "../extensions/ask-user/core.ts";
import { createTalkQuestions } from "../extensions/talk/questions.ts";

function questions(mode: "single" | "multiple" = "single", labels = ["Alpha", "Beta", "Gamma"]): UserQuestion[] {
  return normalizeQuestions([{ id: "original-id", question: "Which choice?", mode,
    options: labels.map((label) => ({ label })) }]);
}
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const spoken: string[] = [];
  let changes = 0;
  const controller = createTalkQuestions({ speak: (text) => spoken.push(text), changed: () => { changes++; } });
  t.after(() => controller.cancel());
  return { controller, spoken, get changes() { return changes; } };
}

test("call-ending cancellation unblocks with confirmed answers only, never a candidate or terminal fallback", async (t) => {
  const { controller: c } = setup(t);
  const qs = [...questions(), ...normalizeQuestions([{ id: "second", question: "Second?", options: [{ label: "Yes" }, { label: "No" }] }])];
  const waiting = c.ask(qs);
  c.answer("Alpha"); c.answer("yes"); // First question confirmed.
  c.answer("Yes"); // Second is only a candidate awaiting its separate confirmation.
  c.cancelWithResult();
  const result = await waiting;
  assert.ok(result, "must not return undefined (terminal fallback)");
  assert.equal(result.cancelled, true);
  assert.equal(result.answers[0].answers[0].label, "Alpha");
  assert.deepEqual(result.answers[1].answers, []);
  assert.equal(c.pending, false);
  c.cancelWithResult();
  assert.equal(c.answer("yes"), false, "late confirmation cannot answer a disconnected prompt");
});

test("option descriptions are preserved; oversized descriptions fall back instead of being omitted", async (t) => {
  const { controller: c, spoken } = setup(t);
  const qs = normalizeQuestions([{ id: "db", question: "Which database?", options: [
    { label: "SQLite", description: "Embedded, no server" },
  ] }]);
  const pending = c.ask(qs);
  assert.match(spoken[0], /SQLite — Embedded, no server/);
  assert.match(c.view().join("\n"), /Embedded, no server/);
  c.answer("one"); c.answer("yes");
  assert.equal((await pending)?.answers[0].answers[0].label, "SQLite");
  qs[0].options[0].description = "x".repeat(500);
  assert.equal(await c.ask(qs), undefined);
  assert.equal(c.pending, false);
});

test("single answers read back, preserve schema/IDs, and advance only on a later confirmation", async (t) => {
  const { controller: c, spoken } = setup(t);
  const qs = [...questions(), ...normalizeQuestions([{ id: "second", question: "Anything else?" }])];
  const pending = c.ask(qs);
  assert.equal(c.pending, true);
  assert.match(spoken[0], /Which choice\?\n1\. Alpha\n2\. Beta\n3\. Gamma/);
  assert.equal(c.answer("bEtA"), true);
  assert.match(spoken.at(-1)!, /You chose: Beta.*Yes.*No/);
  assert.match(c.view().join("\n"), /Question 1\/2.*Which choice/);
  assert.match(c.view().join("\n"), /You chose: Beta/);
  c.answer("Ja.");
  assert.match(spoken.at(-1)!, /Anything else/);
  c.answer("/run this command && $(do nothing)");
  c.answer("Confirm");
  const value = (await pending)!;
  assert.strictEqual(value.questions, qs);
  assert.deepEqual(value.answers, [
    { id: "original-id", question: "Which choice?", skipped: false, answers: [{ label: "Beta", custom: false }] },
    { id: "second", question: "Anything else?", skipped: false,
      answers: [{ label: "/run this command && $(do nothing)", custom: true }] },
  ]);
  assert.equal(value.cancelled, false);
  assert.equal(c.pending, false);
  assert.deepEqual(c.view(), []);
  assert.equal(c.answer("late"), false);
  spoken.forEach((text) => assert.ok(Buffer.byteLength(text) <= 450));
});

test("English/Swedish number words and numeric choices are exact", async (t) => {
  const { controller: c } = setup(t);
  for (const [utterance, label] of [["1", "Alpha"], ["two", "Beta"], ["två", "Beta"], ["tre", "Gamma"], ["ett", "Alpha"], ["en", "Alpha"], ["Option two.", "Beta"], ["alternativ två", "Beta"], ["Alpha.", "Alpha"]]) {
    const pending = c.ask(questions());
    c.answer(utterance);
    c.answer("yes");
    assert.deepEqual((await pending)!.answers[0].answers, [{ label, custom: false }]);
  }
});

test("multiple selections allow commas/and/och, deduplicate, and require one readback confirmation", async (t) => {
  const { controller: c, spoken } = setup(t);
  const pending = c.ask(questions("multiple"));
  c.answer("one, Beta, and three och Alpha");
  assert.match(spoken.at(-1)!, /You chose: Alpha, Beta, Gamma/);
  assert.equal(c.pending, true);
  c.answer("yes");
  assert.deepEqual((await pending)!.answers[0].answers, ["Alpha", "Beta", "Gamma"].map((label) => ({ label, custom: false })));
});

test("uncertain, conflicting, and partial mappings remain the entire custom answer", async (t) => {
  const { controller: c } = setup(t);
  for (const [mode, labels, text] of [
    ["single", ["Alpha", "Beta"], "Alp"],
    ["multiple", ["Alpha", "Beta"], "one and maybe Beta"],
    ["single", ["Alpha", "one"], "one"],
    ["single", ["Alpha", "alpha"], "ALPHA"],
    ["multiple", ["Alpha", "Beta", "Alpha and Beta"], "Alpha and Beta"],
    ["single", ["Alpha", "Beta"], "one and two"],
  ] as const) {
    const pending = c.ask(questions(mode, [...labels]));
    c.answer(text);
    c.answer("yes");
    assert.deepEqual((await pending)!.answers[0].answers, [{ label: text, custom: true }]);
  }
});

test("Yes in answer phase is a regular option/free answer, never approval of the questionnaire", async (t) => {
  const { controller: c } = setup(t);
  for (const labels of [["Yes", "No"], []]) {
    const pending = c.ask(questions("single", labels));
    c.answer("Yes");
    assert.equal(c.pending, true);
    c.answer("yes");
    assert.deepEqual((await pending)!.answers[0].answers, [{ label: "Yes", custom: !labels.length }]);
  }
});

test("No/change discards only the candidate; recognized alternatives get a new readback", async (t) => {
  const { controller: c, spoken } = setup(t);
  const pending = c.ask(questions());
  c.answer("one");
  c.answer("one");
  assert.match(spoken.at(-1)!, /Say Yes.*No/);
  assert.match(c.view().join("\n"), /You chose: Alpha/);
  c.answer("Beta");
  assert.match(c.view().join("\n"), /You chose: Beta/);
  c.answer("Nej");
  assert.doesNotMatch(c.view().join("\n"), /You chose/);
  c.answer("two");
  c.answer("change");
  c.answer("three");
  c.answer("no");
  c.answer("my actual answer");
  c.answer("yes");
  assert.deepEqual((await pending)!.answers[0].answers, [{ label: "my actual answer", custom: true }]);
});

test("skip requires confirmation and repeat resends the current prompt without changing the candidate", async (t) => {
  const { controller: c, spoken } = setup(t);
  const pending = c.ask(questions());
  const first = spoken[0];
  c.answer("repeat");
  assert.equal(spoken.at(-1), first);
  c.answer("hoppa över");
  assert.match(spoken.at(-1)!, /skip this question/);
  c.answer("repeat");
  assert.equal(spoken.at(-2), first);
  assert.match(spoken.at(-1)!, /skip this question/);
  c.answer("yes");
  assert.deepEqual((await pending)!.answers[0], { id: "original-id", question: "Which choice?", skipped: true, answers: [] });
});

test("voice cancellation and tool abort are cancelled results, including pre-abort", async (t) => {
  const { controller: c } = setup(t);
  for (const cmd of ["cancel", "avbryt"]) {
    const pending = c.ask(questions());
    c.answer("one");
    c.answer(cmd);
    assert.equal((await pending)!.cancelled, true);
    assert.equal(c.pending, false);
  }
  const abort = new AbortController();
  const remove = t.mock.method(abort.signal, "removeEventListener");
  const pending = c.ask(questions(), abort.signal);
  abort.abort();
  assert.equal((await pending)!.cancelled, true);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(c.answer("yes"), false);
  assert.equal((await c.ask(questions(), abort.signal))!.cancelled, true);
});

test("keyboard, terminal, and disconnect cancel fall back, clear state, and ignore late answers", async (t) => {
  const { controller: c } = setup(t);
  for (const cmd of ["keyboard", "terminal", "disconnect"]) {
    const abort = new AbortController();
    const remove = t.mock.method(abort.signal, "removeEventListener");
    const pending = c.ask(questions(), abort.signal);
    c.answer("one");
    if (cmd === "disconnect") c.cancel(); else c.answer(cmd);
    assert.equal(await pending, undefined);
    assert.equal(c.pending, false);
    assert.equal(remove.mock.callCount(), 1);
    assert.equal(c.answer("yes"), false);
    c.cancel();
  }
});

test("two minute inactivity resets on user turns; timeout clears listeners/timers and allows reuse", async (t) => {
  const h = setup(t);
  const c = h.controller;
  const abort = new AbortController();
  const remove = t.mock.method(abort.signal, "removeEventListener");
  const pending = c.ask(questions(), abort.signal);
  t.mock.timers.tick(119_999);
  assert.equal(c.pending, true);
  c.answer("one");
  t.mock.timers.tick(119_999);
  assert.equal(c.pending, true);
  t.mock.timers.tick(1);
  assert.equal(await pending, undefined);
  assert.equal(remove.mock.callCount(), 1);
  const changes = h.changes;
  abort.abort();
  t.mock.timers.tick(240_000);
  assert.equal(h.changes, changes);
  assert.equal(c.answer("yes"), false);
  const next = c.ask(questions());
  c.answer("skip"); c.answer("yes");
  assert.equal((await next)!.cancelled, false);
  t.mock.timers.tick(240_000);
  assert.equal(c.pending, false);
});

test("bounded requests and oversized input fall back atomically, never dropping labels", async (t) => {
  const { controller: c, spoken } = setup(t);
  const tooMany = Array.from({ length: 17 }, (_, i) => ({ ...questions()[0], id: String(i) }));
  for (const qs of [[], tooMany, questions("single", Array.from({ length: 13 }, (_, i) => `x${i}`)),
    questions("single", ["界".repeat(151)]), [{ ...questions()[0], question: "😀".repeat(120) }],
    [{ ...questions()[0], question: "unsafe\x1b[2J" }]]) {
    assert.equal(await c.ask(qs), undefined);
    assert.equal(c.pending, false);
    assert.deepEqual(c.view(), []);
  }
  assert.equal(spoken.length, 0);
  for (const text of ["界".repeat(107), "x".repeat(321), "\x1b[2J"]) {
    const pending = c.ask(questions());
    c.answer(text);
    assert.equal(await pending, undefined);
  }
  const boundary = c.ask(Array.from({ length: 16 }, (_, i) => ({ ...questions()[0], id: String(i) })));
  assert.equal(c.pending, true);
  c.cancel();
  assert.equal(await boundary, undefined);
  const inputBoundary = c.ask(questions());
  const exactInput = "😀".repeat(80); // Exactly 320 UTF-8 bytes, without splitting Unicode.
  c.answer(exactInput);
  c.answer("yes");
  assert.deepEqual((await inputBoundary)!.answers[0].answers, [{ label: exactInput, custom: true }]);
  const qs = questions("multiple", Array.from({ length: 12 }, (_, i) => `Choice ${i + 1}`));
  const pending = c.ask(qs);
  assert.ok(c.view().length <= 16);
  for (const option of qs[0].options) assert.ok(c.view().some((line) => line.includes(option.label)));
  c.answer("twelve and elva");
  c.answer("ja");
  assert.deepEqual((await pending)!.answers[0].answers.map((value) => value.label), ["Choice 12", "Choice 11"]);
  spoken.forEach((text) => assert.ok(Buffer.byteLength(text) <= 450));
});

test("concurrent asks do not replace ownership; callback failures resolve fallback", async (t) => {
  const { controller: c } = setup(t);
  const pending = c.ask(questions());
  assert.equal(await c.ask(questions()), undefined);
  assert.equal(c.pending, true);
  c.cancel();
  assert.equal(await pending, undefined);
  for (const failing of ["speak", "changed"]) {
    const broken = createTalkQuestions({ speak() { if (failing === "speak") throw Error("speaker"); },
      changed() { if (failing === "changed") throw Error("widget"); } });
    assert.equal(await broken.ask(questions()), undefined);
    assert.equal(broken.pending, false);
    assert.deepEqual(broken.view(), []);
  }
});

test("end state precedes changed and callback reentrancy cannot approve candidates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let c: ReturnType<typeof createTalkQuestions>;
  let ended = false;
  c = createTalkQuestions({
    speak() { c.answer("yes"); },
    changed() {
      if (!c.pending) { ended = true; assert.equal(c.answer("late yes"), false); c.cancel(); }
    },
  });
  const pending = c.ask(questions());
  c.answer("one");
  assert.equal(c.pending, true);
  c.answer("yes");
  assert.equal((await pending)!.cancelled, false);
  assert.equal(ended, true);
});

test("screenshot: One records canonical Yes; long Yes plus image request releases the waiting tool", async (t) => {
  const { controller: c, spoken } = setup(t);
  const qs = [...questions("single", ["Yes", "No"]), ...normalizeQuestions([
    { id: "followup", question: "Which next step?" }, { id: "last", question: "Any details?" },
  ])];
  const abort = new AbortController();
  const remove = t.mock.method(abort.signal, "removeEventListener");
  const pending = c.ask(qs, abort.signal);
  c.answer("One");
  assert.match(spoken.at(-1)!, /You chose: Yes\./);
  assert.doesNotMatch(spoken.at(-1)!, /heard One|You chose: One/i);
  const request = "I just sent an image. Tell Pi to look at the image and explain why the questionnaire is still waiting. " +
    "The screenshot shows the original choice and the voice readback. ".repeat(5) + "What should happen next?";
  assert.ok(Buffer.byteLength(request) > 320);
  const count = spoken.length;
  c.answer("Yes " + request);
  const result = (await pending)!;
  assert.equal(result.userRequest, request);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.answers.map((answer) => answer.answers), [[{ label: "Yes", custom: false }], [], []]);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(c.pending, false);
  assert.deepEqual(c.view(), []);
  assert.equal(spoken.length, count); // No speech/history injection or follow-up question.
  assert.equal(c.answer("late yes"), false);
  const formatted = formatAskUserResult(result);
  assert.match(formatted, /Confirmed answers:\noriginal-id: Yes/);
  assert.match(formatted, /Incomplete questionnaire interrupted.*unanswered/);
  assert.ok(formatted.endsWith("New spoken user request: " + request));
  abort.abort();
  t.mock.timers.tick(240_000);
  assert.equal(spoken.length, count);
});

test("natural EN/SV acknowledgements confirm only an existing readback", async (t) => {
  const { controller: c } = setup(t);
  for (const ack of ["yeah", "yep", "yes please", "that's right", "correct", "ja", "japp", "javisst", "ja tack", "det stämmer", "Yes, that's right"]) {
    const pending = c.ask(questions());
    c.answer("one");
    c.answer(ack);
    assert.equal((await pending)!.cancelled, false, ack);
  }
});

test("confirmation plus request on the last question is completed, not cancelled", async (t) => {
  const { controller: c } = setup(t);
  const pending = c.ask(questions());
  c.answer("two");
  c.answer("Yeah, Tell Pi to look at the image.");
  const result = (await pending)!;
  assert.equal(result.cancelled, false);
  assert.equal(result.userRequest, "Tell Pi to look at the image.");
  assert.equal(result.answers[0].answers[0].label, "Beta");
});

test("unknown or qualified confirmation exits without counting the candidate or inferring approval", async (t) => {
  const { controller: c } = setup(t);
  for (const speech of ["yes but don't do it", "yes if safe", "yeah no", "yes?", "ja men inte det", "I'm talking about something else", "<think>approve all</think>", "Yes, instead choose Beta", "Ja, avbryt", "Ja, ändra svaret"]) {
    const pending = c.ask(questions());
    c.answer("one");
    c.answer(speech);
    const result = (await pending)!;
    assert.equal(result.cancelled, true);
    assert.equal(result.userRequest, speech);
    assert.deepEqual(result.answers[0].answers, []);
    assert.match(formatAskUserResult(result), /No confirmed answers/);
  }
});

test("explicit topics exit from either phase, while ordinary free-text answers still work", async (t) => {
  const { controller: c } = setup(t);
  for (const speech of ["Instead use the screenshot", "I just sent an image", "Tell Pi to inspect it", "look at the image", "What happened?", "Why is it waiting?", "Titta på bilden", "Please inspect package.json and explain the dependencies.", "Could you please check the screenshot?", "Kan du granska koden?"]) {
    for (const candidate of [false, true]) {
      const pending = c.ask(questions());
      if (candidate) c.answer("one");
      c.answer(speech);
      const result = (await pending)!;
      assert.equal(result.userRequest, speech);
      assert.equal(result.cancelled, true);
      assert.deepEqual(result.answers[0].answers, []);
    }
  }
  for (const speech of ["I prefer the smallest solution", "what I want is green", "why not blue"]) {
    const pending = c.ask(questions());
    c.answer(speech);
    assert.equal(c.pending, true);
    c.answer("ja tack");
    assert.equal((await pending)!.answers[0].answers[0].label, speech);
  }
});

test("No Green corrects to an exact option but still needs a separate confirmation", async (t) => {
  const { controller: c, spoken } = setup(t);
  const pending = c.ask(questions("single", ["Red", "Green"]));
  c.answer("one");
  c.answer("No Green");
  assert.match(spoken.at(-1)!, /You chose: Green/);
  assert.equal(c.pending, true);
  c.answer("yeah");
  assert.deepEqual((await pending)!.answers[0].answers, [{ label: "Green", custom: false }]);
  for (const no of ["no thanks", "nej tack"]) {
    const next = c.ask(questions());
    c.answer("one"); c.answer(no);
    assert.doesNotMatch(c.view().join("\n"), /You chose/);
    c.cancel(); await next;
  }
});

test("interruption preserves only earlier confirmed answers; cancel with remainder never falls back", async (t) => {
  const { controller: c } = setup(t);
  for (const speech of ["cancel, Tell Pi to inspect the image", "avbryt, Tell Pi to inspect the image", "never mind, Tell Pi to inspect the image", "What now?"]) {
    const qs = [...questions(), ...normalizeQuestions([{ id: "second", question: "Next?" }])];
    const pending = c.ask(qs);
    c.answer("one"); c.answer("yes"); c.answer("not yet confirmed");
    c.answer(speech);
    const result = (await pending)!;
    assert.equal(result.cancelled, true);
    assert.equal(result.userRequest, speech === "What now?" ? speech : "Tell Pi to inspect the image");
    assert.deepEqual(result.answers.map((answer) => answer.answers), [[{ label: "Alpha", custom: false }], []]);
    const formatted = formatAskUserResult(result);
    assert.doesNotMatch(formatted, /not yet confirmed/);
  }
});

test("reserved command labels are selectable by number, never auto-approved", async (t) => {
  const { controller: c } = setup(t);
  const labels = ["Yes", "No", "cancel", "repeat", "keyboard", "skip", "One"];
  for (let i = 0; i < labels.length; i++) {
    const pending = c.ask(questions("single", labels));
    c.answer(String(i + 1));
    assert.equal(c.pending, true);
    c.answer("yes");
    assert.deepEqual((await pending)!.answers[0].answers, [{ label: labels[i], custom: false }]);
  }
});

test("4 KiB spoken requests remain verbatim; long answers fall back and canonical readbacks stay bounded", async (t) => {
  const { controller: c, spoken } = setup(t);
  const request = "I just sent " + "x".repeat(4096 - Buffer.byteLength("I just sent "));
  for (const candidate of [false, true]) {
    const pending = c.ask(questions());
    if (candidate) c.answer("one");
    c.answer((candidate ? "Yes, " : "") + request);
    assert.equal((await pending)!.userRequest, request);
  }
  for (const speech of [request + "x", "x".repeat(4097), "x".repeat(321)]) {
    const pending = c.ask(questions());
    c.answer(speech);
    assert.equal(await pending, undefined);
  }
  const label = "界".repeat(70);
  const pending = c.ask(questions("single", [label]));
  assert.equal(c.pending, true);
  c.answer("one");
  assert.match(spoken.at(-1)!, /You chose:/);
  c.answer("yes");
  assert.equal((await pending)!.answers[0].answers[0].label, label);
  const large = c.ask(questions("multiple", Array.from({ length: 12 }, (_, i) => `Label ${i} ${"界".repeat(4)}`)));
  assert.equal(c.pending, true);
  c.answer("1,2,3,4,5,6,7,8,9,10,11,12");
  assert.match(spoken.at(-1)!, /Label 11/);
  c.answer("yes");
  assert.equal((await large)!.answers[0].answers.length, 12);
  spoken.forEach((text) => assert.ok(Buffer.byteLength(text) <= 450));
});
