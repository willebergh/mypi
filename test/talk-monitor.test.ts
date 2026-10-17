import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error Development script is intentionally standalone JavaScript.
import { createParser, formatRecord, renderTerminal, renderSpeechChunk, monitor, logWasReset, CLEAR_TERMINAL } from "../scripts/talk-monitor.mjs";

const turn = { time: "2026-10-17T09:40:16.929Z", type: "turn.done", event: { turn: { role: "user", transcript: "Hello, världen." } } };

test("voice blocks use compact headers without diagnostic metadata", () => {
  assert.equal(formatRecord(turn), "[USER] [VOICE]\nHello, världen.\n\n");
  assert.equal(formatRecord({ ...turn, event: { turn: { role: "assistant", transcript: "Hi" } } }), "[GPT-LIVE] [VOICE]\nHi\n\n");
  for (const type of ["turn.delta", "input_transcript.added", "output_transcript.added", "session.context.appended", "delegation.context.appended", "session.usage.updated", "talk.active", "codex.progress"]) {
    assert.equal(formatRecord({ type, event: {} }), "", `${type} is hidden`);
  }
  assert.doesNotMatch(formatRecord({ ...turn, event: { turn: { role: "user", transcript: "\x1b[2Jhello" } } }), /\x1b/);
});

test("delegation and session blocks use sender-first headers with delegation ID last", () => {
  const request = { type: "delegation.created", seq: 279, callId: "call-1", direction: "in", event: { item: { id: "item-1", content: [{ text: "Inspect logs" }] } } };
  assert.equal(formatRecord(request), "[GPT-LIVE] [DELEGATION] [CREATE] [item-1]\nInspect logs\n\n");
  for (const [channel, action] of [["commentary", "CONTEXT"], ["speakable", "SPEAKABLE"]]) {
    const event = { channel, delegation_item_id: "item-1", content: [{ text: "Update" }] };
    assert.equal(formatRecord({ type: "delegation.context.append", event }), `[PI] [DELEGATION] [${action}] [item-1]\nUpdate\n\n`);
    assert.equal(formatRecord({ type: "session.context.append", event }), `[PI] [SESSION] [${action}]\nUpdate\n\n`);
  }
  assert.equal(formatRecord({ type: "delegation.context.append", event: { channel: "unknown" } }), "");
});

test("startup context remains visible in a single compact block", () => {
  assert.equal(formatRecord({ type: "codex.call.create", event: { session: { instructions: "Voice rules", initial_items: [{ role: "developer", content: [{ text: "Project context" }] }] } } }), "[PI] [SESSION] [STARTUP]\nVoice rules\n\nProject context\n\n");
});

test("monitor buffers partial records, skips malformed lines and resets", () => {
  const output: string[] = [];
  const warnings: string[] = [];
  const parser = createParser((value: string) => output.push(value), (value: string) => warnings.push(value));
  const line = JSON.stringify(turn);
  parser.push(line.slice(0, 20));
  assert.equal(output.length, 0);
  parser.push(line.slice(20) + "\nnot json\n" + line.slice(0, 15));
  assert.equal(output.length, 1);
  assert.equal(warnings.length, 1);
  parser.reset();
  parser.push(line + "\n");
  assert.equal(output.length, 2);
});

test("compact headers retain full-block backgrounds", () => {
  for (const [header, colors] of [
    ["[USER] [VOICE]", "100;97"], ["[GPT-LIVE] [VOICE]", "100;97"],
    ["[USER] [VOICE] [CONTINUED]", "100;97"],
    ["[USER] [VOICE] [FINAL/CORRECTION]", "100;97"],
    ["[GPT-LIVE] [DELEGATION] [CREATE] [item-1]", "45;97"],
    ["[PI] [SESSION] [STARTUP]", "43;30"],
    ["[PI] [SESSION] [STARTUP SNAPSHOT]", "43;30"],
    ["[PI] [SESSION] [CONTEXT]", "43;30"],
    ["[PI] [DELEGATION] [CONTEXT] [item-1]", "45;97"],
    ["[PI] [DELEGATION] [SPEAKABLE] [item-1]", "45;97"],
    ["[PI] [SESSION] [SPEAKABLE]", "43;30"],
  ]) {
    const output = renderTerminal(`${header}\nHello **world**\n\nSecond line\n\n`);
    assert.ok(output.includes(header));
    for (const line of output.trimEnd().split("\n")) {
      assert.ok(line.startsWith(`\x1b[${colors}m `));
      assert.ok(line.endsWith("\x1b[K\x1b[0m"), "fill to edge and reset each row");
    }
    assert.ok(output.includes("\x1b[1mworld\x1b[22m"), "inline bold preserves background");
  }
});

test("JSON controls are indented and pretty printed in Markdown", () => {
  const output = formatRecord({ type: "session.context.append", event: { channel: "commentary", content: [{ text: '{"type":"talk.stop","reply":{"talk_stop":"nonce"}}' }] } });
  assert.ok(output.includes('    {\n      "type": "talk.stop",'));
  assert.ok(output.includes('        "talk_stop": "nonce"'));
  assert.doesNotMatch(output, /\x1b/);
});

test("appended Talk calls reset the view before the new call's first message", () => {
  const events: string[] = [];
  const parser = createParser((value: string) => events.push(value), () => {}, () => events.push("CLEAR"));
  const row = (callId: string) => JSON.stringify({ ...turn, callId }) + "\n";
  parser.push(row("old") + row("old") + row("new"));
  assert.equal(events.length, 4);
  assert.equal(events[2], "CLEAR");
  assert.match(events[3], /Hello/);
  parser.reset();
  parser.push(row("another"));
  assert.equal(events.filter(event => event === "CLEAR").length, 1);
});

test("terminal clear erases scrollback, visible screen, and resets cursor", () => {
  assert.equal(CLEAR_TERMINAL, "\x1b[3J\x1b[2J\x1b[H");
});

test("reset detection handles truncation, replacement, and rapid truncate/refill", () => {
  const previous = { identity: "1:2", position: 100, prefix: Buffer.from("old call") };
  assert.equal(logWasReset(previous, { identity: "1:2", size: 0, prefix: Buffer.alloc(0) }), true);
  assert.equal(logWasReset(previous, { identity: "1:3", size: 100, prefix: previous.prefix }), true);
  assert.equal(logWasReset(previous, { identity: "1:2", size: 200, prefix: Buffer.from("new call") }), true);
  assert.equal(logWasReset(previous, { identity: "1:2", size: 200, prefix: Buffer.from("old call with more text") }), false);
  assert.equal(logWasReset({ identity: undefined, position: 0, prefix: Buffer.alloc(0) }, { identity: "1:2", size: 100, prefix: previous.prefix }), false);
});

type SpeechMode = "start" | "delta" | "end";
const record = (type: string, event: object, callId?: string) => JSON.stringify({ type, event, callId }) + "\n";
const created = (id: string | undefined, transcript = "", role = "user") => record("turn.created", { turn: { id, role, transcript } });
const delta = (id: string | undefined, fragment: string) => record("turn.delta", { turn_id: id, delta: fragment });
const done = (id: string | undefined, transcript?: string, role = "user") => record("turn.done", { turn: { id, role, transcript } });
const delegation = record("delegation.created", { item: { id: "d1", content: [{ text: "Inspect logs" }] } });
function capture() {
  const chunks: { value: string; speech?: SpeechMode }[] = [];
  const parser = createParser((value: string, meta?: { speech: SpeechMode }) => chunks.push({ value, speech: meta?.speech }));
  return { parser, chunks, output: () => chunks.map(chunk => chunk.value).join("") };
}

test("user creation and deltas stream immediately before delegation, without duplicate finals", () => {
  const { parser, chunks, output } = capture();
  parser.push(created("u1", "Inspect"));
  assert.equal(output(), "[USER] [VOICE]\nInspect", "creation emits without waiting for done");
  parser.push(delta("u1", " the"));
  assert.equal(output(), "[USER] [VOICE]\nInspect the", "delta emits without a newline or second header");
  parser.push(record("input_transcript.added", { item: { text: "Inspect the logs" } }));
  parser.push(delta("u1", " logs") + delegation);
  const beforeFinal = output();
  assert.equal(beforeFinal, "[USER] [VOICE]\nInspect the logs\n\n[GPT-LIVE] [DELEGATION] [CREATE] [d1]\nInspect logs\n\n");
  assert.deepEqual(chunks.map(chunk => chunk.speech), ["start", "delta", "delta", "end", undefined]);
  parser.push(done("u1", "Inspect the logs") + done("u1", "Inspect the logs"));
  parser.flush();
  assert.equal(output(), beforeFinal);
});

test("hidden events do not interrupt speech; displayed events force labeled continuations", () => {
  const { parser, chunks, output } = capture();
  parser.push(created("u1") + delta("u1", "One"));
  parser.push(record("session.usage.updated", {}) + record("input_transcript.added", { item: { text: "One" } }));
  parser.push(delta("u1", " two") + delegation + delta("u1", " three"));
  assert.equal(output(), "[USER] [VOICE]\nOne two\n\n[GPT-LIVE] [DELEGATION] [CREATE] [d1]\nInspect logs\n\n[USER] [VOICE] [CONTINUED]\n three");
  parser.push(record("session.context.append", { channel: "commentary", content: [{ text: "Working" }] }));
  parser.push(delta("u1", " four") + done("u1", "One two three four"));
  assert.match(output(), /\[PI\] \[SESSION\] \[CONTEXT\]\nWorking\n\n\[USER\] \[VOICE\] \[CONTINUED\]\n four\n\n$/);
  assert.equal(chunks.filter(chunk => chunk.speech === "end").length, 3);
  assert.doesNotMatch(output(), /FINAL|One two three four/);
});

test("changed finals are visible corrections, including extensions and truncations", () => {
  for (const final of ["Use the blue file", "Use the red file now", "Use the red"]) {
    for (const interleaved of [false, true]) {
      const { parser, output } = capture();
      parser.push(created("u1", "Use the red file"));
      if (interleaved) parser.push(delegation);
      parser.push(done("u1", final));
      assert.ok(output().includes(`[USER] [VOICE] [FINAL/CORRECTION]\n${final}\n\n`));
      assert.ok(output().indexOf("Use the red file") < output().indexOf("[FINAL/CORRECTION]"));
      const corrected = output();
      parser.push(done("u1", final));
      assert.equal(output(), corrected, "repeated corrected final is hidden");
    }
  }
});

test("both voices stream and final-only speech remains visible", () => {
  const { parser, output } = capture();
  parser.push(done("u1", "Final only") + done("u1", "Final only"));
  parser.push(created("a1", "Partial", "assistant") + delta("a1", " assistant"));
  assert.equal(output(), "[USER] [VOICE]\nFinal only\n\n[GPT-LIVE] [VOICE]\nPartial assistant");
  parser.push(done("a1", "Partial assistant", "assistant"));
  parser.push(done("a2", "Final-only assistant", "assistant"));
  parser.push(created("u2") + done("u2", "No partial text") + done("u2", "No partial text"));
  assert.equal(output(), "[USER] [VOICE]\nFinal only\n\n[GPT-LIVE] [VOICE]\nPartial assistant\n\n[GPT-LIVE] [VOICE]\nFinal-only assistant\n\n[USER] [VOICE]\nNo partial text\n\n");
  parser.push(created("u3", "Keep partial") + done("u3"));
  assert.ok(output().endsWith("[USER] [VOICE]\nKeep partial\n\n"));
  assert.doesNotMatch(output(), /FINAL\/CORRECTION/);
});

test("assistant continuations and corrections retain the GPT-Live sender", () => {
  const { parser, output } = capture();
  parser.push(created("a1", "It is", "assistant"));
  parser.push(record("output_transcript.added", { item: { text: "It is" } }));
  parser.push(record("session.context.append", { channel: "commentary", content: [{ text: "Update" }] }));
  parser.push(delta("a1", " one") + done("a1", "It is two", "assistant"));
  assert.equal(output(), "[GPT-LIVE] [VOICE]\nIt is\n\n[PI] [SESSION] [CONTEXT]\nUpdate\n\n[GPT-LIVE] [VOICE] [CONTINUED]\n one\n\n[GPT-LIVE] [VOICE] [FINAL/CORRECTION]\nIt is two\n\n");
  const before = output();
  parser.push(done("a1", "It is two", "assistant"));
  assert.equal(output(), before);
});

test("interleaved user and assistant turns preserve speakers and suppress matching finals", () => {
  const { parser, output } = capture();
  parser.push(created("u1", "User") + created("a1", "Voice", "assistant"));
  parser.push(delta("u1", " continues") + delta("a1", " continues"));
  parser.push(done("u1", "User continues") + done("a1", "Voice continues", "assistant"));
  assert.equal(output(), "[USER] [VOICE]\nUser\n\n[GPT-LIVE] [VOICE]\nVoice\n\n[USER] [VOICE] [CONTINUED]\n continues\n\n[GPT-LIVE] [VOICE] [CONTINUED]\n continues\n\n");
});

test("turn identity isolates overlapping speech and ignores unknown or post-final deltas", () => {
  const { parser, output } = capture();
  parser.push(delta("unknown", "Hidden") + created("u1", "First") + created("u2", "Second"));
  parser.push(done("u1", "First") + delta("u2", " turn"));
  assert.ok(output().endsWith("[USER] [VOICE]\nSecond turn"), "late matching final does not interrupt another turn");
  parser.push(done("u2", "Second turn") + delta("u1", "ignored"));
  assert.doesNotMatch(output(), /CONTINUED|Hidden|ignored/);
  parser.push(created(undefined, "ID-less") + delta(undefined, " speech") + done(undefined, "ID-less speech"));
  assert.ok(output().endsWith("[USER] [VOICE]\nID-less speech\n\n"));
});

test("file and call resets close speech, clear deduplication, and reject stale deltas", () => {
  const events: string[] = [];
  const parser = createParser((value: string) => events.push(value), () => {}, () => events.push("CLEAR\n"));
  parser.push(record("turn.created", { turn: { id: "u1", role: "user", transcript: "Old" } }, "old"));
  parser.push(record("turn.delta", { turn_id: "u1", delta: "ignored" }, "new"));
  assert.equal(events.join(""), "[USER] [VOICE]\nOld\n\nCLEAR\n");
  parser.push(done("u1", "Old"));
  assert.ok(events.join("").endsWith("[USER] [VOICE]\nOld\n\n"), "new call can reuse IDs and transcripts");
  parser.push(created("u2", "Open") + '{"type":');
  parser.reset();
  assert.ok(events.join("").endsWith("Open\n\n"));
  const before = events.join("");
  parser.push(delta("u2", "ignored"));
  assert.equal(events.join(""), before);
  parser.push(done("u2", "Open"));
  assert.equal(events.join(""), before + "[USER] [VOICE]\nOpen\n\n");
  assert.equal(events.filter(event => event === "CLEAR\n").length, 1);
});

test("speech chunks keep one gray block, preserve line breaks and reset ANSI on every write", () => {
  const { parser, chunks } = capture();
  parser.push(created("u1", "Hello **") + delta("u1", "world**\nNext\tline\x1b[2J") + delegation);
  parser.flush();
  for (const chunk of chunks) {
    const rendered = chunk.speech ? renderSpeechChunk(chunk.value, chunk.speech) : renderTerminal(chunk.value);
    assert.ok(rendered.startsWith(chunk.speech ? "\x1b[100;97m" : "\x1b[45;97m"));
    if (chunk.speech === "end") assert.equal(rendered, "\x1b[100;97m\x1b[K\x1b[0m\n\n", "one uncolored blank separator, matching non-streamed blocks");
    assert.ok(rendered.trimEnd().endsWith("\x1b[0m"));
    assert.doesNotMatch(rendered, /\x1b\[2J/);
  }
  const speech = chunks.filter(chunk => chunk.speech).map(chunk => renderSpeechChunk(chunk.value, chunk.speech)).join("");
  assert.ok(speech.includes("world**\x1b[K\x1b[0m\n\x1b[100;97m Next\tline"));
  const plain = speech.replace(/\x1b\[[0-9;]*[mK]/g, "");
  assert.equal(plain, " [USER] [VOICE]\n Hello **world**\n Next\tline[2J\n\n");
});

test("flush closes unfinished speech exactly once without discarding turn state", () => {
  const { parser, chunks, output } = capture();
  parser.push(created("u1", "Unfinished"));
  parser.flush();
  parser.flush();
  assert.equal(output(), "[USER] [VOICE]\nUnfinished\n\n");
  assert.equal(chunks.filter(chunk => chunk.speech === "end").length, 1);
  parser.push(delta("u1", " resumed") + done("u1", "Unfinished resumed"));
  assert.ok(output().endsWith("[USER] [VOICE] [CONTINUED]\n resumed\n\n"));
});

test("monitor flushes speech on once and aborted shutdown, including colored output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-monitor-flush-"));
  const originalWrite = process.stdout.write;
  const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  try {
    const path = join(dir, "events.jsonl");
    await writeFile(path, created("u1", "Unfinished"));
    const plain = execFileSync(process.execPath, ["scripts/talk-monitor.mjs", "--once", path], { encoding: "utf8" });
    assert.ok(plain.endsWith("[USER] [VOICE]\nUnfinished\n\n"));
    const output: string[] = [];
    process.stdout.write = ((value: string) => { output.push(value); return true; }) as typeof process.stdout.write;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    delete process.env.NO_COLOR;
    for (const once of [true, false]) {
      output.length = 0;
      await monitor(path, { once, signal: AbortSignal.abort() });
      assert.equal(output.at(-1), renderSpeechChunk("\n\n", "end"));
      assert.ok(output.join("").includes("Purple: delegation"));
      assert.ok(output.join("").endsWith("\x1b[0m\n\n"));
    }
  } finally {
    process.stdout.write = originalWrite;
    if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone --once produces plain Markdown from a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-monitor-"));
  try {
    const path = join(dir, "events.jsonl");
    await writeFile(path, JSON.stringify(turn) + "\n");
    const output = execFileSync(process.execPath, ["scripts/talk-monitor.mjs", "--once", path], { encoding: "utf8" });
    assert.match(output, /# Talk monitor/);
    assert.ok(output.includes("[USER] [VOICE]\nHello, världen."));
    assert.doesNotMatch(output, /\x1b/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
