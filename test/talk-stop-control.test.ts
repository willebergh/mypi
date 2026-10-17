import assert from "node:assert/strict";
import test from "node:test";
import { createTalkStopControl, TALK_STOP_REQUESTED, type TalkStopOperation } from "../extensions/talk/stop-control.ts";

// Pure unit harness: no Pi runtime, trace, transport, provider, or real abort.
function setup(activate = true) {
  let operation: TalkStopOperation = { busy: true, signal: new AbortController().signal };
  const quiet: string[] = [];
  const reports: string[] = [];
  let interrupts = 0;
  let onInterrupt = () => {};
  let beforeInterrupt = () => {};
  let id = 0;
  const control = createTalkStopControl({
    operation: () => operation,
    context: (text) => quiet.push(text),
    report: (text) => reports.push(text),
    beforeInterrupt: () => beforeInterrupt(),
    interrupt() { interrupts++; onInterrupt(); },
  });
  if (activate) control.activate();
  const delta = (text: string, itemId = `f${++id}`) => control.transcript("user", text, "delta", { itemId });
  const turn = (id = "u1") => control.turnStart("user", id);
  const delegate = (body = "Stop Pi", userTurnId = "u1") => control.delegate(body, { userTurnId });
  const reply = () => JSON.stringify(JSON.parse(quiet.at(-1)!).reply);
  return { control, quiet, reports, delta, turn, delegate, reply,
    interrupts: () => interrupts,
    setOperation: (next: TalkStopOperation) => { operation = next; },
    operation: () => operation,
    onInterrupt: (fn: () => void) => { onInterrupt = fn; },
    beforeInterrupt: (fn: () => void) => { beforeInterrupt = fn; },
  };
}

for (const phrase of ["Stop Pi", "stoppa Pi", " STOP  PI!! ", "\nStOpPa\tPi.  "]) {
  for (const json of [false, true]) test(`fresh standalone ${JSON.stringify(phrase)}, ${json ? "nonce" : "raw"}`, () => {
    const h = setup();
    h.turn();
    h.delta(phrase);
    assert.equal(h.interrupts(), 0, "ASR alone is never a request to abort");
    assert.equal(h.delegate(json ? h.reply() : phrase), true);
    assert.equal(h.interrupts(), 1, "synchronous at the safe handoff, without timers");
    assert.deepEqual(h.reports, [TALK_STOP_REQUESTED]);
  });
}

for (const phrase of [
  "Don't stop Pi", "Do not stop Pi", "stoppa inte Pi", "Stop Pi inte", "Inte stoppa Pi",
  "Stop Pi and delete the files", "stoppa Pi och radera filerna", "If tests fail, Stop Pi",
  "om det misslyckas, stoppa Pi", '"Stop Pi"', "‘stoppa Pi’", "Stop Pi?", "Stop Pi?!",
  "Please Stop Pi", "Say Stop Pi", "How do I Stop Pi?", "Stop Pi,", "Stop Pi…",
  "Stop Pi\u200b", "Ｓｔｏｐ Ｐｉ", "Stop Pı", "Stop\x00 Pi", "/talkstop", "stop", "cancel",
]) test(`not standalone: ${JSON.stringify(phrase)}`, () => {
  const h = setup();
  h.turn();
  h.delta(phrase);
  assert.equal(h.delegate(h.reply()), true, "reserved control never reaches task routing");
  assert.equal(h.interrupts(), 0);
  assert.match(h.reports.at(-1)!, /Use Esc/);
});

test("raw compound, quoted, conditional and negated Stop candidates clarify locally", () => {
  for (const phrase of ['"Stop Pi"', "Don't stop Pi", "If needed stop Pi", "Stop Pi then inspect files", "stoppa Pi och vänta", "Stop Pi?"]) {
    const h = setup();
    h.turn(); h.delta(phrase);
    assert.equal(h.delegate(phrase), true, phrase);
    assert.equal(h.interrupts(), 0);
    assert.match(h.reports[0], /Use Esc/);
  }
});

test("descriptive project requests mentioning Stop Pi are not control attempts", () => {
  for (const text of ["Explain how Stop Pi works", "Implement Stop Pi logging", "Why does Stop Pi require a nonce?"]) {
    const h = setup(); h.turn(); h.delta(text);
    assert.equal(h.delegate(text), false);
    assert.equal(h.interrupts(), 0);
    assert.deepEqual(h.reports, []);
  }
});

test("throwing abort callbacks report uncertainty once without exposing details or retrying", () => {
  const h = setup(); h.turn();
  h.onInterrupt(() => { throw new Error("PRIVATE abort details"); });
  h.delta("Stop Pi");
  assert.doesNotThrow(() => h.delegate());
  assert.equal(h.interrupts(), 1);
  assert.match(h.reports[0], /could not be confirmed/);
  assert.doesNotMatch(h.reports[0], /PRIVATE|Nothing was stopped|queued messages returned/);
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1, "uncertain native actions are not retried");
});

test("generic stop, questionnaire cancel and /talkstop are not Pi Stop controls", () => {
  for (const phrase of ["stop", "/talkstop", "/talk stop", "cancel", "avbryt frågan", "skip", "keyboard"]) {
    const h = setup(); h.turn(); h.delta(phrase);
    assert.equal(h.delegate(phrase), false, phrase);
    assert.equal(h.interrupts(), 0);
    assert.deepEqual(h.reports, []);
  }
});

test("entire captured ASR must match; fragment IDs are not utterance ends", () => {
  const h = setup(); h.turn();
  h.delta("Do not "); h.delta("Stop Pi");
  assert.equal(h.delegate(), true);
  assert.equal(h.interrupts(), 0, "never suffix-match a command");
  h.delta("Stop"); h.delta(" Pi"); h.delta(" and wait");
  h.delegate();
  assert.equal(h.interrupts(), 0, "never commit an earlier standalone fragment");
  h.delta("St"); h.delta("op "); h.delta("Pi!");
  h.delegate();
  assert.equal(h.interrupts(), 1, "append chunks verbatim until native commit");
});

test("raw native command needs fresh identified user deltas, not metadata alone", () => {
  const h = setup(); h.turn();
  h.delegate();
  assert.equal(h.interrupts(), 0);
  h.control.transcript("user", "Stop Pi", "delta");
  h.delegate();
  h.control.transcript("user", "Stop Pi", undefined, { itemId: "missing_source" });
  h.delegate();
  h.control.transcript("user", "Stop Pi", "delta", { itemId: "invalid id" });
  h.delegate();
  assert.equal(h.interrupts(), 0);
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1);
});

test("a missing-identity prefix taints a later valid command instead of dropping negation", () => {
  const h = setup(); h.turn();
  h.control.transcript("user", "Don't ", "delta");
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
});

test("assistant text, final-only text, and late final corrections cannot authorize", () => {
  for (const kind of ["assistant", "final", "late-final", "turn-end"] as const) {
    const h = setup(); h.turn();
    if (kind === "late-final" || kind === "turn-end") h.delta("Stop Pi");
    if (kind === "assistant") {
      h.control.transcript("assistant", "Stop Pi", "delta", { itemId: "assistant" });
      h.control.turnEnd("assistant");
    } else if (kind === "turn-end") h.control.turnEnd("user", "u1");
    else h.control.transcript("user", "Stop Pi", "final", { itemId: "final" });
    h.delegate(h.reply());
    assert.equal(h.interrupts(), 0, kind);
  }
});

test("current onTurnStart group is required; a delegation ID alone cannot bind speech", () => {
  const h = setup(); h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
  h.turn("actual"); h.delta("Stop Pi"); h.delegate("Stop Pi", "other");
  assert.equal(h.interrupts(), 0);
  h.delta("Stop Pi"); h.control.delegate("Stop Pi");
  assert.equal(h.interrupts(), 0);
  h.delta("Stop Pi"); h.delegate("Stop Pi", "actual");
  assert.equal(h.interrupts(), 1);
});

test("unbound first partial is adopted when actual turn.created follows it", () => {
  const h = setup();
  h.delta("Stop "); h.turn(); h.delta("Pi"); h.delegate();
  assert.equal(h.interrupts(), 1);
});

test("known previous group speech is never transferred into a new group", () => {
  const h = setup(); h.turn("old"); h.delta("Stop Pi"); h.turn("new");
  h.delegate("Stop Pi", "new");
  assert.equal(h.interrupts(), 0);
  h.turn("old"); h.delta("Stop Pi"); h.delegate("Stop Pi", "old");
  assert.equal(h.interrupts(), 0, "old group starts cannot revive a capture");
});

test("every handoff consumes capture, including normal work and question controls", () => {
  for (const body of [undefined, "Inspect files", '{"talk_answer":"question"}', '{"talk_task_answer":"task"}']) {
    const h = setup(); h.turn(); h.delta("Stop Pi");
    h.control.delegate(body, { userTurnId: "u1" });
    assert.equal(h.interrupts(), 0, "neither normal work nor another protocol nonce authorizes Stop");
    h.delegate(h.reply());
    assert.equal(h.interrupts(), 0, "the first handoff consumed all captured speech");
    h.delta("Stop Pi"); h.delegate();
    assert.equal(h.interrupts(), 1, "fresh same-group speech can commit a later delegation");
  }
});

test("normal handoff is unchanged and fresh same-group command needs no new group ID", () => {
  const h = setup(); h.turn(); h.delta("Inspect tests");
  assert.equal(h.delegate("Inspect tests"), false);
  h.delta("stoppa Pi"); assert.equal(h.delegate("Stop Pi"), true);
  assert.equal(h.interrupts(), 1);
  assert.equal(h.quiet.length, 1, "no nonce spam per normal handoff");
});

test("seen fragments cannot be replayed even after many other handoffs", () => {
  const h = setup(); h.turn(); h.delta("Stop Pi", "old");
  h.delegate("Inspect files");
  for (let i = 0; i < 500; i++) { h.delta("ordinary", `filler${i}`); h.delegate("ordinary"); }
  h.delta("Stop Pi", "old"); h.delegate();
  assert.equal(h.interrupts(), 0);
  h.delta("Don't ", "old"); h.delta("Stop Pi", "new"); h.delegate();
  assert.equal(h.interrupts(), 0, "replay cannot hide a negating prefix");
});

test("assistant playback start/end consumes speech; overlap and old finals fail closed", () => {
  const h = setup(); h.turn(); h.delta("Stop Pi");
  h.control.turnStart("assistant", "a1");
  h.delegate();
  h.delta("Stop Pi"); h.delegate();
  h.control.turnEnd("assistant", "old");
  h.delta("Stop Pi"); h.delegate();
  h.control.turnEnd("assistant");
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
  h.delta("Stop Pi"); h.control.turnEnd("assistant", "a1"); h.delegate();
  assert.equal(h.interrupts(), 0, "playback end discards overlapping speech");
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1);
});

test("local speakable presentation also blocks ambiguous Stop until its end", () => {
  const h = setup(); h.turn(); h.control.playbackStart(); h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
  h.control.turnEnd("assistant"); h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0, "unidentified end cannot unlock ambiguous playback");
  h.control.turnStart("assistant", "readback");
  h.control.turnEnd("assistant", "readback");
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1);
});

for (const boundary of ["signal", "native-request", "agent-start", "settlement", "idle", "aborted"] as const) {
  test(`operation change before commit rejects captured command: ${boundary}`, () => {
    const h = setup(); h.turn(); h.delta("Stop Pi");
    if (boundary === "signal") h.setOperation({ busy: true, signal: new AbortController().signal });
    else if (boundary === "idle") h.setOperation({ ...h.operation(), busy: false });
    else if (boundary === "aborted") h.setOperation({ busy: true, signal: AbortSignal.abort() });
    else h.control.operationChanged(); // Explicit native lifecycle generation boundary.
    h.delegate();
    assert.equal(h.interrupts(), 0);
  });
}

test("operation change in the middle of speech cannot drop a negating prefix", () => {
  const h = setup(); h.turn(); h.delta("Don't "); h.control.operationChanged();
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1, "a later fresh request can target the new operation");
});

test("idle, busy without signal, and idle-to-busy speech never abort", () => {
  for (const state of ["idle", "missing-signal", "idle-to-busy"] as const) {
    const h = setup(); h.turn();
    h.setOperation({ busy: state === "missing-signal", signal: state === "missing-signal" ? undefined : new AbortController().signal });
    h.delta("Stop Pi");
    if (state === "idle-to-busy") h.setOperation({ busy: true, signal: new AbortController().signal });
    h.delegate(); assert.equal(h.interrupts(), 0, state);
  }
});

test("nonce and operation are consumed before synchronous reentrant abort", () => {
  const h = setup(); h.turn();
  const old = h.reply();
  h.onInterrupt(() => {
    h.delegate(old);
    h.delta("Stop Pi"); h.delegate();
    h.control.operationChanged();
    h.delta("Stop Pi"); h.delegate(old);
  });
  h.delta("Stop Pi"); h.delegate(old);
  assert.equal(h.interrupts(), 1);
  assert.deepEqual(h.reports, [TALK_STOP_REQUESTED]);
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1, "cannot stop the same signal twice even with new ASR");
  h.onInterrupt(() => {});
  h.setOperation({ busy: true, signal: new AbortController().signal });
  h.control.operationChanged();
  assert.notEqual(h.reply(), old);
  h.delta("Stop Pi"); h.delegate(old);
  assert.equal(h.interrupts(), 1, "old nonce is not refreshed by new operation");
  h.delta("Stop Pi"); h.delegate(h.reply());
  assert.equal(h.interrupts(), 2);
});

test("stale, malformed, nested, duplicate and escaped reserved keys never fall through", () => {
  for (const input of [
    '{"talk_stop":"stale"}', '{"talk_stop":', '{talk_stop: "broken"}', '{"talk_stop":null}',
    '{"talk_stop":123}', '{"talk_stop":"x","extra":true}', '[{"talk_stop":"x"}]',
    '{"nested":{"talk_stop":"x"}}', '{"talk\\u005fstop":"x"}', '{"talk\\u005fstop":',
    '{"talk_stop":"x","talk_stop":"x"}', '```json\n{"talk_stop":"x"}\n```',
  ]) {
    const h = setup(); h.turn(); h.delta("Stop Pi");
    assert.equal(h.delegate(input), true, input);
    assert.equal(h.interrupts(), 0, input);
    h.delegate(h.reply());
    assert.equal(h.interrupts(), 0, "invalid control consumes ASR too");
  }
});

test("fresh speech cannot redeem a previous call's nonce", () => {
  const old = setup(); const nonce = old.reply(); old.control.close();
  const h = setup(); h.turn(); h.delta("Stop Pi"); h.delegate(nonce);
  assert.equal(h.interrupts(), 0);
});

test("no capability or authorization while connecting, after close, or by late callbacks", () => {
  const h = setup(false);
  h.turn(); h.delta("Stop Pi"); h.delegate();
  assert.deepEqual(h.quiet, []); assert.deepEqual(h.reports, []);
  assert.equal(h.interrupts(), 0);
  h.control.activate(); h.delegate();
  assert.equal(h.interrupts(), 0, "pre-activation ASR is discarded");
  h.turn("active"); h.delta("Stop Pi"); const nonce = h.reply();
  h.control.close(); h.control.close();
  const count = h.reports.length;
  h.control.activate(); h.control.operationChanged(); h.turn("late"); h.delta("Stop Pi");
  assert.equal(h.delegate(nonce, "late"), true);
  assert.equal(h.interrupts(), 0);
  assert.equal(h.quiet.length, 1); assert.equal(h.reports.length, count);
});

test("close synchronously during interrupt prevents any post-call report", () => {
  const h = setup(); h.turn(); h.onInterrupt(() => h.control.close());
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1); assert.deepEqual(h.reports, []);
});

test("512-byte buffer never retains a command suffix after overflow", () => {
  const h = setup(); h.turn();
  h.delta("ö".repeat(256)); h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
  h.delta("x".repeat(513)); h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
  h.delta(" ".repeat(505) + "Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 1, "512 bytes inclusive; no arbitrary truncation");
});

test("fragment cap disables only Stop for the call, with no LRU replay resurrection", () => {
  const h = setup(); h.turn();
  for (let i = 0; i < 4096; i++) {
    h.delta("hello", `fragment${i}`);
    assert.equal(h.delegate("Inspect files"), false);
  }
  h.delta("Stop Pi", "overflow"); h.delegate();
  h.delta("Stop Pi", "fragment0"); h.delegate();
  h.control.operationChanged(); h.control.turnEnd("user"); h.turn("new");
  h.delta("Stop Pi"); h.delegate("Stop Pi", "new");
  assert.equal(h.interrupts(), 0);
  assert.equal(h.delegate("Inspect more files"), false, "ordinary work still routes normally");
});

test("capability stays quiet and stable through ordinary operations, refreshing only after consumption", () => {
  const h = setup(); const first = h.reply();
  const capability = JSON.parse(h.quiet[0]);
  assert.equal(capability.type, "talk.stop");
  assert.equal(capability.experimental, true);
  assert.ok(Buffer.byteLength(h.quiet[0]) <= 450, "also safe for the small context transport");
  for (let i = 0; i < 10; i++) h.control.operationChanged();
  assert.equal(h.reply(), first); assert.equal(h.quiet.length, 1);
});

test("assistant/final identities stay quarantined even when later relabelled user delta", () => {
  for (const kind of ["assistant", "final", "missing-source"] as const) {
    const h = setup(); h.turn();
    h.control.transcript(kind === "assistant" ? "assistant" : "user", "Stop Pi",
      kind === "final" ? "final" : kind === "missing-source" ? undefined : "delta", { itemId: "old" });
    h.control.turnStart("assistant", "readback");
    h.control.turnEnd("assistant", "readback");
    h.delta("Stop Pi", "old"); h.delegate();
    assert.equal(h.interrupts(), 0, kind);
  }
});

test("overlapping identified playback disables only Stop rather than guessing which final ended it", () => {
  const h = setup(); h.turn();
  h.control.turnStart("assistant", "a1");
  h.control.turnStart("assistant", "a2");
  h.control.turnEnd("assistant", "a2");
  h.delta("Stop Pi"); h.delegate();
  h.control.turnEnd("assistant", "a1");
  h.delta("Stop Pi"); h.delegate();
  assert.equal(h.interrupts(), 0);
  assert.equal(h.delegate("Inspect files"), false);
});

test("cleanup runs before abort, and reentrant cleanup cannot abort replacement work or a closed call", () => {
  const order: string[] = [];
  const normal = setup(); normal.turn();
  normal.beforeInterrupt(() => order.push("detach"));
  normal.onInterrupt(() => order.push("abort"));
  normal.delta("Stop Pi"); normal.delegate();
  assert.deepEqual(order, ["detach", "abort"]);
  for (const change of ["signal", "generation", "close", "idle"] as const) {
    const h = setup(); h.turn();
    h.beforeInterrupt(() => {
      if (change === "signal") h.setOperation({ busy: true, signal: new AbortController().signal });
      if (change === "generation") h.control.operationChanged();
      if (change === "idle") h.setOperation({ ...h.operation(), busy: false });
      if (change === "close") h.control.close();
    });
    h.delta("Stop Pi"); h.delegate();
    assert.equal(h.interrupts(), 0, change);
    assert.ok(!h.reports.includes(TALK_STOP_REQUESTED));
  }
});
