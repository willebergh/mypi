import assert from "node:assert/strict";
import test from "node:test";
import { createTalkCaptions } from "../extensions/talk/captions.ts";
import { createCodexWire } from "../extensions/talk/codex-wire.ts";
import type { LiveCaption } from "../extensions/talk/live.ts";
import { LIVE_CAPTION_FINAL_MS, LIVE_CAPTION_PARTIAL_MS } from "../extensions/talk/webcam/src/shared/live-protocol.ts";

function harness() {
  let at = 10000;
  const cc = createTalkCaptions("run-one", () => at);
  const update = (text: string, final = false, id = "i1", role: LiveCaption['role'] = "user") =>
    cc.update({ role, text, final, identities: [`${role}:item:${id}`] });
  return { cc, update, advance(ms: number) { at += ms; }, lines: () => cc.snapshot().lines };
}

test("captions collect only after the call gate, never replay pre-call items or turns", () => {
  const h = harness();
  h.cc.start("user", "before");
  h.update("startup fragment");
  h.cc.gate(true);
  h.update("startup final", true);
  h.cc.update({ role: "user", text: "old final", final: true, identities: ["user:turn:before"] });
  assert.deepEqual(h.lines(), []);
  h.update("fresh", false, "fresh");
  assert.equal(h.lines()[0]!.text, "fresh");
  h.cc.gate(false);
  assert.deepEqual(h.lines(), []);
  h.cc.gate(true);
  h.update("late", true, "fresh");
  assert.deepEqual(h.lines(), []);
  assert.deepEqual(createTalkCaptions("new-run").snapshot(), { runId: "new-run", lines: [] });
});

test("turn/item binding appends real fragments and replaces full authoritative corrections, per speaker", () => {
  const h = harness(); h.cc.gate(true);
  const wire = createCodexWire({
    onCaption: event => h.cc.update(event), onTurnStart: (role, id) => h.cc.start(role, id),
    onTranscript() {}, onDelegation() {}, onError(error) { throw error; },
  });
  wire.receive({ type: "turn.created", turn: { id: "u1", role: "user" } });
  wire.receive({ type: "input_transcript.added", item: { id: "ui1", text: "Turn " } });
  wire.receive({ type: "input_transcript.added", item: { id: "ui2", text: "left" } });
  wire.receive({ type: "turn.created", turn: { id: "a1", role: "assistant" } });
  wire.receive({ type: "output_transcript.added", item: { id: "ai1", text: "Hello" } });
  assert.deepEqual(h.lines().map(line => line.text), ["Turn left", "Hello"]);
  wire.receive({ type: "turn.done", turn: { id: "u1", role: "user", transcript: "Turn right!" } });
  wire.receive({ type: "turn.done", turn: { id: "a1", role: "assistant", transcript: "Hello there" } });
  assert.deepEqual(h.lines().map(line => [line.speaker, line.text, line.final]),
    [["user", "Turn right!", true], ["assistant", "Hello there", true]]);
  assert.doesNotMatch(JSON.stringify(h.cc.snapshot()), /ui1|ui2|ai1|"u1"|"a1"/);
});

test("an item preceding turn.created binds once; late finals/items cannot consume a newer turn", () => {
  const h = harness(); h.cc.gate(true);
  h.update("first"); h.cc.start("user", "u1");
  h.cc.update({ role: "user", text: "corrected", final: true, identities: ["user:turn:u1"] });
  h.cc.start("user", "u2"); h.update("new", false, "i2");
  h.update("old suffix", false, "i1");
  h.cc.update({ role: "user", text: "old final", final: true, identities: ["user:turn:u1"] });
  h.cc.update({ role: "user", text: "unmatched final", final: true, identities: ["user:turn:unknown"] });
  assert.equal(h.lines()[0]!.text, "new");
});

test("unscoped distinct items replace rather than mix; unidentified speech is omitted", () => {
  const h = harness(); h.cc.gate(true);
  h.update("one"); h.update("two", false, "i2");
  h.cc.update({ role: "assistant", text: "unidentified", final: false, identities: [] });
  assert.deepEqual(h.lines().map(line => line.text), ["two"]);
  h.update("", true, "i2"); assert.deepEqual(h.lines(), []);
});

test("final-only identified speech expires without heartbeat resurrection; abandoned partials expire too", () => {
  const h = harness(); h.cc.gate(true);
  h.update("final-only", true);
  const before = h.lines()[0]!;
  h.advance(LIVE_CAPTION_FINAL_MS - 1);
  assert.deepEqual(h.lines()[0], before);
  h.advance(1); assert.deepEqual(h.lines(), []);
  h.update("late duplicate", true); assert.deepEqual(h.lines(), []);
  h.update("partial", false, "next"); h.advance(LIVE_CAPTION_PARTIAL_MS);
  assert.deepEqual(h.lines(), []);
  h.update("late suffix", false, "next"); assert.deepEqual(h.lines(), []);
});

test("display text is UTF-8 bounded, sanitized across fragment boundaries and detached", () => {
  const h = harness(); h.cc.gate(true);
  h.update("Hello \x1b]private"); h.update(" title\x07 world");
  assert.equal(h.lines()[0]!.text, "Hello world");
  h.update("🙂".repeat(1000));
  assert.ok(Buffer.byteLength(h.lines()[0]!.text) <= 1024);
  assert.doesNotMatch(h.lines()[0]!.text, /[\uD800-\uDFFF]/u);
  const copy = h.lines(); copy[0]!.text = "changed";
  assert.notEqual(h.lines()[0]!.text, "changed");
  h.update("Bearer abcd1234", true, "secret", "assistant");
  assert.doesNotMatch(h.lines().find(line => line.speaker === "assistant")!.text, /abcd1234/);
});
