import assert from "node:assert/strict";
import test from "node:test";
import { createCodexWire } from "../extensions/talk/codex-wire.ts";
import type { LiveCallbacks, LiveTranscript } from "../extensions/talk/live.ts";

function setup() {
  const transcripts: unknown[][] = [], delegations: unknown[][] = [], errors: Error[] = [], turns: unknown[][] = [], starts: unknown[][] = [];
  const wire = createCodexWire({
    onTranscript: (...args) => transcripts.push(args),
    onTurn: (...args) => turns.push(args),
    onTurnStart: (...args) => starts.push(args),
    onDelegation: (...args) => delegations.push(args),
    onError: (error) => errors.push(error),
  });
  return { ...wire, transcripts, delegations, errors, turns, starts };
}
const fragment = (role: "input" | "output", text: unknown) => ({ type: `${role}_transcript.added`, item: { text } });
const done = (role: string, transcript: unknown) => ({ type: "turn.done", turn: { role, transcript } });
const delegation = (id: unknown, content: unknown = [{ type: "input_text", text: "task" }]) => ({
  type: "delegation.created", item: { type: "delegation", target: "client", id, content },
});

test("native ASR metadata uses only validated fragment item.id for either role", () => {
  const invalid = [undefined, null, 1, {}, "", "bad.id", "bad\nID", "bad\0ID", "id\n", "id\r", "id\t", "å", "😀", "\ud800", "x".repeat(513)];
  for (const role of ["input", "output"] as const) {
    for (const id of ["A_1-z", "x".repeat(512), ...invalid]) {
      const h = setup();
      h.receive({
        type: `${role}_transcript.added`, event_id: "event_1", id: "event_alias", item_id: "outer_item", turn_id: "outer_turn",
        item: { id, item_id: "inner_item", turn_id: "inner_turn", text: "Hej å😀", start_ms: 12, end_ms: 30 },
      });
      const args = h.transcripts[0]!;
      const expected = [role === "input" ? "user" : "assistant", "Hej å😀", args[2], args[2], "delta"];
      if (id === "A_1-z" || id === "x".repeat(512)) expected.push({ itemId: id });
      assert.deepEqual(h.transcripts, [expected]);
      assert.deepEqual([h.turns, h.starts, h.delegations, h.errors], [[], [], [], []]);
    }
  }
});

test("ASR identity is never invented from repeated text, timing, aliases or prior fragments", (t) => {
  t.mock.method(performance, "now", () => 1000);
  const h = setup();
  h.receive({ type: "input_transcript.added", item: { id: "actual", text: "Yes" } });
  h.receive(fragment("input", "Yes"));
  h.receive({ ...fragment("input", "Yes"), event_id: "event", turn_id: "turn", item_id: "alias" });
  assert.deepEqual(h.transcripts, [
    ["user", "Yes", 0, 0, "delta", { itemId: "actual" }],
    ["user", "Yes", 0, 0, "delta"], ["user", "Yes", 0, 0, "delta"],
  ]);
  assert.deepEqual([h.turns, h.starts, h.delegations, h.errors], [[], [], [], []]);
});

test("ASR item metadata stays separate from authoritative turns and final captions", (t) => {
  t.mock.method(performance, "now", () => 1000);
  const h = setup();
  h.receive({ type: "turn.created", turn: { id: "whole_turn", role: "user" } });
  h.receive({ type: "input_transcript.added", item: { id: "asr_fragment", text: "Yes" } });
  assert.deepEqual(h.turns, []);
  h.receive({ type: "turn.done", item_id: "asr_fragment", turn: {
    id: "whole_turn", role: "user", transcript: "Yes!", start_ms: 10, end_ms: 20,
  } });
  h.receive({ type: "turn.done", item_id: "final_item", turn: { id: "final_only", role: "user", transcript: "Yes" } });
  assert.deepEqual(h.transcripts, [
    ["user", "Yes", 0, 0, "delta", { itemId: "asr_fragment" }],
    ["user", "!", 0, 0, "final"], ["user", "Yes", 0, 0, "final"],
  ]);
  assert.deepEqual(h.starts, [["user", "whole_turn"]]);
  assert.deepEqual(h.turns, [
    ["user", "Yes!", { id: "whole_turn", startMs: 10, endMs: 20 }], ["user", "Yes", { id: "final_only" }],
  ]);
  assert.deepEqual([h.delegations, h.errors], [[], []]);
});

test("real fragment IDs do not bypass transcript UTF-8 or cumulative size bounds", () => {
  const h = setup();
  h.receive({ type: "input_transcript.added", item: { id: "boundary", text: "😀".repeat(4096) } });
  assert.equal(h.transcripts.length, 1);
  assert.deepEqual(h.transcripts[0]![5], { itemId: "boundary" });
  h.receive({ type: "input_transcript.added", item: { id: "overflow", text: "x" } });
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.errors.length, 1);
  for (const value of ["\ud800", "😀".repeat(4097)]) {
    const invalid = setup();
    invalid.receive({ type: "output_transcript.added", item: { id: "real_item", text: value } });
    assert.deepEqual(invalid.transcripts, []);
    assert.equal(invalid.errors.length, 1);
  }
});

test("metadata callbacks preserve reentrant event dedup without authorizing other events", () => {
  const event = { type: "input_transcript.added", event_id: "event", item: { id: "fragment", text: "Yes" } };
  const transcripts: unknown[][] = [], unauthorized: unknown[][] = [];
  const wire = createCodexWire({
    onTranscript(...args) {
      transcripts.push(args);
      const metadata: LiveTranscript | undefined = args[5];
      wire.receive(event);
      wire.receive({ type: "turn.created", turn: { role: "user" }, metadata });
      wire.receive({ type: "unknown", item: event.item, metadata });
      throw new Error("consumer");
    },
    onTurn: (...args) => unauthorized.push(args), onTurnStart: (...args) => unauthorized.push(args),
    onDelegation: (...args) => unauthorized.push(args), onError: (...args) => unauthorized.push(args),
  });
  assert.doesNotThrow(() => wire.receive(event));
  assert.equal(transcripts.length, 1);
  assert.deepEqual(transcripts[0]![5], { itemId: "fragment" });
  assert.deepEqual(unauthorized, []);
});

test("three- and five-argument transcript callbacks remain compatible", () => {
  const received: unknown[][] = [];
  const clients: LiveCallbacks["onTranscript"][] = [
    (role, delta, start) => { received.push([role, delta, start]); },
    (role, delta, start, end, source) => { received.push([role, delta, start, end, source]); },
  ];
  for (const onTranscript of clients) {
    createCodexWire({ onTranscript, onDelegation() {}, onError() {} })
      .receive({ type: "input_transcript.added", item: { id: "fragment", text: "Yes" } });
  }
  assert.equal(received.length, 2);
  assert.deepEqual(received.map((args) => [args[0], args[1], args.length]), [["user", "Yes", 3], ["user", "Yes", 5]]);
  assert.equal(received[1]![4], "delta");
});

test("OG fragments and full turns append only missing suffixes, independently per role", () => {
  const h = setup();
  h.receive(fragment("input", "Hej "));
  h.receive(fragment("output", "Hello"));
  h.receive(fragment("input", "världen"));
  h.receive(done("user", "Hej världen!"));
  h.receive(done("assistant", "Hello there"));
  h.receive(done("assistant", "Hello there"));
  h.receive(fragment("input", "Again"));
  h.receive(done("user", "Again"));
  assert.deepEqual(h.transcripts.map((args) => [args[0], args[1], args[4]]), [
    ["user", "Hej ", "delta"], ["assistant", "Hello", "delta"], ["user", "världen", "delta"],
    ["user", "!", "final"], ["assistant", " there", "final"], ["user", "Again", "delta"],
  ]);
  assert.deepEqual(h.errors, []);
});

test("final-only captions work; corrected finals do not repeat whole fragment text", () => {
  const h = setup();
  h.receive(done("assistant", "A final-only answer"));
  h.receive(fragment("input", "Turn left"));
  h.receive(done("user", "Turn right"));
  h.receive(done("user", "Turn right"));
  h.receive(fragment("input", "Turn left"));
  h.receive(done("user", "Turn left"));
  assert.deepEqual(h.transcripts.map((args) => [args[0], args[1], args[4]]), [
    ["assistant", "A final-only answer", "final"], ["user", "Turn left", "delta"], ["user", "Turn left", "delta"],
  ]);
});

test("final turn events carry authoritative corrections and flush missing finals without duplication", () => {
  const h = setup();
  h.receive(fragment("input", "wrong word"));
  h.receive(fragment("output", "Hello"));
  h.receive(done("user", "correct word"));
  h.receive(done("assistant", undefined));
  h.receive(done("assistant", undefined));
  h.receive(done("user", "correct word"));
  h.receive(fragment("input", "false partial"));
  h.receive(done("user", ""));
  assert.deepEqual(h.turns, [["user", "correct word"], ["assistant", "Hello"], ["user", ""]]);
  assert.deepEqual(h.errors, []);
});

for (const answer of ["Yes", "Ja"]) {
  for (const withIds of [false, true]) {
    test(`identical final-only ${answer} survives assistant boundaries (IDs: ${withIds})`, () => {
      const h = setup();
      const final = (role: string, value: string, id: string) => ({
        ...done(role, value), turn: { role, transcript: value, ...(withIds ? { id } : {}) },
      });
      h.receive(final("user", answer, "u1"));
      h.receive(final("assistant", "Please confirm after the questionnaire", "a1"));
      h.receive(final("user", answer, "u2"));
      assert.deepEqual(h.turns, withIds ? [
        ["user", answer, { id: "u1" }], ["assistant", "Please confirm after the questionnaire", { id: "a1" }],
        ["user", answer, { id: "u2" }],
      ] : [
        ["user", answer], ["assistant", "Please confirm after the questionnaire"], ["user", answer],
      ]);
      assert.deepEqual(h.transcripts.map((args) => [args[0], args[1], args[4]]),
        h.turns.map((args) => [args[0], args[1], "final"]));
      assert.deepEqual(h.delegations, []);
      assert.deepEqual(h.errors, []);
    });
  }
}

test("turn lifecycle metadata uses native IDs and server timestamps, with created deduplicated", () => {
  const h = setup();
  const created = { type: "turn.created", turn: { id: "u1", role: "user" } };
  h.receive(created);
  h.receive(created);
  h.receive({ type: "turn.created", turn: { id: "u1", role: "assistant" } });
  h.receive({ type: "turn.done", turn: { id: "u1", role: "user", transcript: "Yes", start_ms: 12.5, end_ms: 30 } });
  h.receive({ type: "turn.done", turn: { id: "u1", role: "user", transcript: "Yes", start_ms: 12.5, end_ms: 30 } });
  assert.deepEqual(h.starts, [["user", "u1"], ["assistant", "u1"]]);
  assert.deepEqual(h.turns, [["user", "Yes", { id: "u1", startMs: 12.5, endMs: 30 }]]);
  assert.deepEqual(h.errors, []);
});

test("missing or malformed final metadata cannot authorize new history", () => {
  const h = setup();
  h.receive({ type: "turn.created", turn: { id: "bad.id", role: "user" } });
  h.receive({ type: "turn.created", turn: { id: "u1", role: "unknown" } });
  h.receive({ type: "turn.done", turn: { id: "u1", role: "user", transcript: null } });
  h.receive({ type: "turn.done", turn: { id: "bad.id", role: "user", transcript: "No metadata" } });
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.turns, [["user", "No metadata"]]);

  const partial = setup();
  partial.receive(fragment("input", "assembled"));
  partial.receive({ type: "turn.done", turn: { id: "u2", role: "user", transcript: null } });
  assert.deepEqual(partial.turns, [["user", "assembled"]]);
});

test("distinct identified final-only turns do not require different text or another role", () => {
  const h = setup();
  for (const id of ["u1", "u2"]) h.receive({ type: "turn.done", turn: { id, role: "user", transcript: "Yes" } });
  assert.deepEqual(h.turns, [["user", "Yes", { id: "u1" }], ["user", "Yes", { id: "u2" }]]);
});

test("split partials and alternative final shapes dedupe by item, turn and event identity", () => {
  const h = setup();
  const first = { ...fragment("input", "Y"), event_id: "e1", item: { id: "i1", text: "Y" } };
  h.receive(first);
  h.receive(first);
  h.receive({ ...fragment("input", "es"), event_id: "e2", item: { id: "i1", text: "es" } });
  h.receive({ type: "turn.done", item_id: "i1", turn: { id: "u1", role: "user", transcript: "Yes" } });
  h.receive(done("user", undefined));
  h.receive(done("user", "Yes"));
  h.receive(done("assistant", "Next question"));
  // Late alternate finals still identify the original utterance, not a new confirmation.
  h.receive({ type: "turn.done", turn_id: "u1", turn: { role: "user", transcript: "Yes" } });
  h.receive({ type: "turn.done", turn: { item_id: "i1", role: "user", transcript: "Yes" } });
  const fresh = { ...done("user", "Yes"), event_id: "e3" };
  h.receive(fresh);
  h.receive(done("assistant", "Done"));
  h.receive(fresh);
  assert.deepEqual(h.turns, [["user", "Yes", { id: "u1" }], ["assistant", "Next question"], ["user", "Yes"], ["assistant", "Done"]]);
  assert.deepEqual(h.transcripts.map((args) => [args[0], args[1], args[4]]), [
    ["user", "Y", "delta"], ["user", "es", "delta"], ["assistant", "Next question", "final"],
    ["user", "Yes", "final"], ["assistant", "Done", "final"],
  ]);
  assert.deepEqual(h.errors, []);
});

test("late original finals remain captions, not fresh approval speech; real added speech stays delta", () => {
  const h = setup();
  h.receive({ type: "input_transcript.added", item: { id: "original", text: "One" } });
  h.receive(done("assistant", "Readback: please confirm"));
  const late = { type: "turn.done", item_id: "original", turn: { id: "u1", role: "user", transcript: "OneYes" } };
  h.receive(late);
  // A delayed suffix must render, but must not look like a newly spoken approval.
  assert.deepEqual(h.transcripts.map((args) => [args[0], args[1], args[4]]), [
    ["user", "One", "delta"], ["assistant", "Readback: please confirm", "final"],
    ["user", "Yes", "final"],
  ]);
  assert.deepEqual(h.turns, [["assistant", "Readback: please confirm"], ["user", "OneYes", { id: "u1" }]]);
  h.receive(late);
  assert.equal(h.transcripts.length, 3);
  assert.equal(h.turns.length, 2);

  const finalOnly = { type: "turn.done", turn: { id: "u2", role: "user", transcript: "Yes" } };
  h.receive(finalOnly);
  h.receive(finalOnly);
  const spoken = { type: "input_transcript.added", event_id: "fresh", item: { id: "u3", text: "Yes" } };
  h.receive(spoken);
  h.receive(spoken);
  h.receive({ type: "turn.done", item_id: "u3", turn: { role: "user", transcript: "Yes" } });
  assert.deepEqual(h.transcripts.slice(3).map((args) => [args[0], args[1], args[4]]), [
    ["user", "Yes", "final"], ["user", "Yes", "delta"],
  ]);
  assert.deepEqual(h.turns.slice(2), [["user", "Yes", { id: "u2" }], ["user", "Yes"]]);
  assert.deepEqual(h.errors, []);
});

test("transcript identity memory is bounded without failing long sessions", () => {
  const h = setup();
  for (let i = 0; i < 600; i++) {
    h.receive({ type: "turn.done", event_id: `e${i}`, turn: { id: `u${i}`, role: "user", transcript: "Ja" } });
  }
  h.receive({ type: "turn.done", turn: { id: "u599", role: "user", transcript: "Ja" } });
  assert.equal(h.turns.length, 600);
  // Old identities may be evicted; distinct identified turns must still be delivered.
  h.receive({ type: "turn.done", event_id: "e0", turn: { id: "u0", role: "user", transcript: "Ja" } });
  assert.equal(h.turns.length, 601);
  assert.deepEqual(h.errors, []);
});

test("timestamps are constructor-relative milliseconds and nondecreasing even if the clock regresses", (t) => {
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  const h = setup();
  clock = 1012.5;
  h.receive({ type: "input_transcript.added", item: { id: "asr_one", text: "one", start_ms: 999, end_ms: 1001 } });
  clock = 1005;
  h.receive(delegation("d1"));
  clock = 1030;
  h.receive(fragment("output", "two"));
  // The fifth argument distinguishes raw speech from final-caption synthesis; timing stays unchanged.
  assert.deepEqual(h.transcripts, [["user", "one", 12.5, 12.5, "delta", { itemId: "asr_one" }], ["assistant", "two", 30, 30, "delta"]]);
  assert.deepEqual(h.delegations, [["d1", 12.5, "task"]]);
});

test("delegations propagate only a valid native user bidi turn ID and do not deduplicate by source", () => {
  const h = setup();
  h.receive({ type: "turn.done", turn: { id: "turn_1", role: "user", transcript: "task" } });
  h.receive({ ...delegation("d1"), item: { ...delegation("d1").item, user_bidi_turn_id: "turn_1" } });
  h.receive(delegation("d2"));
  h.receive({ ...delegation("d3"), item: { ...delegation("d3").item, user_bidi_turn_id: "bad.id" } });
  h.receive({ ...delegation("d4"), item: { ...delegation("d4").item, user_bidi_turn_id: "x".repeat(513) } });
  assert.deepEqual(h.delegations.map((args) => [args[0], args[3]]), [
    ["d1", { userTurnId: "turn_1" }], ["d2", undefined], ["d3", undefined], ["d4", undefined],
  ]);
  assert.deepEqual(h.turns, [["user", "task", { id: "turn_1" }]]);
  assert.deepEqual(h.errors, []);
});

test("client delegation passes exact assembled task, never inferred caption text", () => {
  const h = setup();
  h.receive(fragment("input", "unrelated caption"));
  h.receive(delegation("A_1-z", [
    { type: "input_text", text: "  Inspect\n" }, { type: "audio", text: "ignored" },
    null, { type: "input_text", text: "the project å😀  " },
  ]));
  assert.equal(h.delegations.length, 1);
  assert.equal(h.delegations[0][0], "A_1-z");
  assert.equal(h.delegations[0][2], "  Inspect\nthe project å😀  ");
  h.receive({ type: "delegation.created", item: { type: "delegation", target: "server", id: "other" } });
  h.receive({ type: "session.delegation.created", delegation: { id: "public", target: "client" } });
  assert.equal(h.delegations.length, 1);
  assert.deepEqual(h.errors, []);
});

test("IDs deduplicate for the entire wire lifetime; 257th unique ID fails closed, not evicts", () => {
  const h = setup();
  for (let i = 0; i < 256; i++) h.receive(delegation(`d_${i}`));
  h.receive(delegation("d_0"));
  assert.equal(h.delegations.length, 256);
  assert.equal(h.errors.length, 0);
  h.receive(delegation("d_256"));
  h.receive(delegation("d_0"));
  h.receive(fragment("input", "ignored after failure"));
  assert.equal(h.delegations.length, 256);
  assert.equal(h.transcripts.length, 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /restart/);
  const restarted = setup();
  restarted.receive(delegation("d_0"));
  assert.equal(restarted.delegations.length, 1);
});

for (const id of ["", "a".repeat(513), "bad.id", "bad\nID", null, 1]) {
  test(`rejects invalid delegation ID ${JSON.stringify(id).slice(0, 50)}`, () => {
    const h = setup();
    h.receive(delegation(id));
    assert.equal(h.delegations.length, 0);
    assert.equal(h.errors.length, 1);
  });
}

for (const content of [[], null, [{ type: "input_text", text: " \n " }],
  [{ type: "input_text", text: "å".repeat(4097) }],
  [{ type: "input_text", text: "a".repeat(4096) }, { type: "input_text", text: "b".repeat(4097) }],
  [{ type: "input_text", text: 123 }], [{ type: "input_text", text: "\ud800" }],
]) {
  test("rejects empty, malformed or oversized tasks without dispatch", () => {
    const h = setup();
    h.receive(delegation("d", content));
    assert.equal(h.delegations.length, 0);
    assert.equal(h.errors.length, 1);
  });
}

test("accepts boundary ID and 8KiB UTF-8 task without trimming", () => {
  const h = setup();
  const input = "😀".repeat(2048);
  h.receive(delegation("x".repeat(512), [{ type: "input_text", text: input }]));
  assert.equal(h.delegations[0][2], input);
  assert.deepEqual(h.errors, []);
});

test("context uses OG session/delegation targets and speakable/commentary channels", () => {
  const h = setup();
  for (const id of [null, "d_1"]) {
    for (const speakable of [true, false]) {
      assert.deepEqual(h.context(id, "Result å😀", speakable), {
        type: id === null ? "session.context.append" : "delegation.context.append",
        ...(id === null ? {} : { delegation_item_id: id }),
        channel: speakable ? "speakable" : "commentary",
        content: [{ type: "input_text", text: "Result å😀" }],
      });
    }
  }
  assert.throws(() => h.context("bad.id", "ok", true));
  assert.throws(() => h.context(null, "\ud800", false));
  assert.throws(() => h.context(null, "x".repeat(16 * 1024 + 1), false));
});

test("protocol errors are generic, terminal and reported once", () => {
  for (const event of [null, [], { type: "error", error: { message: "secret task and token" } },
    fragment("input", 42), fragment("output", "x".repeat(16 * 1024 + 1)),
    done("user", "\ud800"), { type: "delegation.created" },
  ]) {
    const h = setup();
    h.receive(event);
    h.receive(event);
    h.receive(delegation("late"));
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors[0].message, /secret|token|task/);
    assert.equal(h.delegations.length, 0);
    assert.equal(h.transcripts.length, 0);
  }
});

test("partial captions are bounded across fragments; unrelated events are ignored", () => {
  const h = setup();
  h.receive({ type: "session.created" });
  h.receive(done("tool", "ignored"));
  h.receive(fragment("input", "x".repeat(16 * 1024)));
  h.receive(fragment("input", "x"));
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.errors.length, 1);
});

test("consumer exceptions cannot escape and reentrant delegation replay is suppressed", () => {
  const boom = () => { throw new Error("consumer secret"); };
  let count = 0;
  const wire = createCodexWire({
    onTranscript: boom, onError: boom,
    onDelegation() { count++; wire.receive(delegation("same")); boom(); },
  });
  assert.doesNotThrow(() => {
    wire.receive(fragment("input", "hello"));
    wire.receive(delegation("same"));
    wire.receive({ type: "error" });
  });
  assert.equal(count, 1);
});
