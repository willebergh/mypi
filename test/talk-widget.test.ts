import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTalkWidget } from "../extensions/talk/widget.ts";

const theme: Pick<Theme, "fg" | "bold"> = { fg: (_color, text) => text, bold: (text) => text };
const active = { state: "active" } as const;
const render = (widget: ReturnType<typeof createTalkWidget>, width = 120) => widget.render(width, theme, active).join("\n");

test("empty state and startup details are useful and bounded", () => {
  const widget = createTalkWidget();
  assert.match(render(widget), /Talk · live · \/talk stop\nReady — start speaking/);
  assert.doesNotMatch(render(widget), /You:|Voice:/);
  const info = { state: "starting", progress: "Opening\n".repeat(1000), browserUrl: "http://localhost/" + "x".repeat(4000) } as const;
  const first = widget.render(40, theme, info);
  assert.equal(first.length, 4);
  assert.match(first[0], /connecting/);
  assert.deepEqual(widget.render(40, theme, info), first);
  assert.ok(first.every((line) => visibleWidth(line) <= 40));
  const closing = widget.render(120, theme, { state: "closing" });
  assert.match(closing[0], /Talk · stopping · \/talk stop/);
  assert.doesNotMatch(closing.join("\n"), /live|Connecting/);
});

test("optional elapsed header formats minutes and hours and clamps invalid durations", () => {
  const widget = createTalkWidget();
  for (const [elapsedMs, expected] of [
    [0, "00:00"], [999, "00:00"], [1000, "00:01"], [207_999, "03:27"],
    [3_599_999, "59:59"], [3_600_000, "01:00:00"], [3_661_000, "01:01:01"],
    [-1000, "00:00"], [NaN, "00:00"], [Infinity, "00:00"], [-Infinity, "00:00"],
  ] as const) {
    assert.equal(widget.render(120, theme, { ...active, elapsedMs })[0], `Talk · live · ${expected} · /talk stop`);
  }
  assert.equal(widget.render(120, theme, { state: "closing", elapsedMs: 207_000 })[0],
    "Talk · stopping · 03:27 · /talk stop");
  widget.append("user", "你好 😀 caption ".repeat(500));
  widget.append("assistant", "voice ".repeat(500));
  for (const width of [0, 1, 2, 10, 40, 120]) {
    const lines = widget.render(width, theme, { ...active, elapsedMs: 207_000 });
    assert.ok(lines.length <= 14);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (!width) assert.deepEqual(lines, []);
  }
});

test("dashboard-owned status leaves only captions and actionable browser links above the input", () => {
  const widget = createTalkWidget();
  const info = { state: "starting", showStatus: false, progress: "Summarizing…", elapsedMs: 12_000 } as const;
  assert.deepEqual(widget.render(120, theme, info), []);
  assert.deepEqual(widget.render(120, theme, { ...info, browserUrl: "http://127.0.0.1/#capability" }), ["http://127.0.0.1/#capability"]);
  widget.append("user", "Hello");
  widget.append("assistant", "Hej");
  const lines = widget.render(120, theme, { ...info, state: "active" });
  assert.deepEqual(lines, ["You …: Hello", "Voice …: Hej"]);
  assert.doesNotMatch(lines.join("\n"), /Talk|Summarizing|00:12|\/talk stop/);
  for (const width of [0, 1, 2, 10, 40]) {
    assert.ok(widget.render(width, theme, info).every((line) => visibleWidth(line) <= width));
  }
});

test("latest caption per role replaces completed captions at first fragment or final", () => {
  const widget = createTalkWidget();
  widget.append("user", "wrong");
  widget.append("user", " partial");
  widget.finish("user", "correct");
  widget.finish("assistant", "answer");
  assert.equal(render(widget), "Talk · live · /talk stop\nYou: correct\nVoice: answer");
  widget.append("assistant", "next");
  assert.match(render(widget), /You: correct\nVoice …: next/);
  widget.finish("assistant", "next final");
  assert.equal(render(widget), "Talk · live · /talk stop\nYou: correct\nVoice: next final");
  widget.finish("user", "user final only");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice: next final\nYou: user final only");
  assert.doesNotMatch(render(widget), /wrong|partial|answer|…/);
});

test("recorded captions are removed by role and turn ID only; unidentified captions remain", () => {
  const widget = createTalkWidget();
  widget.finish("user", "same text", "shared");
  widget.finish("assistant", "same text", "shared");
  widget.finish("user", "replacement", "other");
  widget.finish("assistant", "unidentified");
  widget.append("user", "live same text");
  widget.removeRecorded((role, id) => role === "user" && id === "other");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice: unidentified\nYou …: live same text");
  widget.removeRecorded((_role, id) => id === "shared");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice: unidentified\nYou …: live same text");
  widget.removeRecorded(() => true);
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice: unidentified\nYou …: live same text");
});

test("first partial binds to start and hides as soon as its turn is recorded, before finish", () => {
  const widget = createTalkWidget();
  widget.append("user", "accepted prompt");
  widget.append("assistant", "still speaking");
  const beforeStart = render(widget);
  widget.start("user", "accepted");
  assert.equal(render(widget), beforeStart);
  widget.removeRecorded((role, id) => role === "user" && id === "accepted");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: still speaking");
  assert.deepEqual(widget.render(120, theme, { ...active, showStatus: false }), ["Voice …: still speaking"]);
  for (let i = 0; i < 3; i++) {
    widget.append("user", " continued suffix");
    widget.start("user", "accepted");
    widget.removeRecorded(() => false);
    assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: still speaking");
  }
  widget.finish("user", "accepted prompt with suffix", "accepted");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: still speaking");
  widget.removeRecorded((role, id) => role === "user" && id === "accepted");
  widget.start("user", "accepted");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: still speaking");
});

test("start creates an empty live turn and a different ID resets only that role", () => {
  const widget = createTalkWidget();
  widget.finish("user", "previous caption", "previous");
  widget.append("assistant", "other speaker");
  widget.start("user", "accepted");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: other speaker");
  widget.removeRecorded((role, id) => role === "user" && id === "accepted");
  widget.append("user", "hidden even when recorded before first partial");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: other speaker");
  widget.start("user", "new-turn");
  widget.append("user", "new visible caption");
  widget.start("user", "new-turn");
  widget.append("user", " suffix");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: other speaker\nYou …: new visible caption suffix");
});

test("same and last-completed starts never resurrect hidden captions or replace newer turns", () => {
  const widget = createTalkWidget();
  widget.start("user", "old");
  widget.append("user", "old caption");
  widget.finish("user", "old final", "old");
  widget.removeRecorded(() => true);
  widget.start("user", "old");
  assert.equal(render(widget), "Talk · live · /talk stop\nReady — start speaking");
  widget.append("user", "new partial before start");
  widget.start("user", "old");
  assert.match(render(widget), /You …: new partial before start$/);
  widget.start("user", "new");
  widget.start("user", "old");
  assert.match(render(widget), /You …: new partial before start$/);
  widget.removeRecorded((_role, id) => id === "new");
  widget.start("user", "old");
  widget.start("user", "new");
  widget.append("user", " hidden suffix");
  assert.equal(render(widget), "Talk · live · /talk stop\nReady — start speaking");
});

test("identified live captions stay visible when rejected or not recorded", () => {
  const widget = createTalkWidget();
  widget.start("user", "rejected");
  widget.append("user", "rejected prompt");
  widget.start("assistant", "unrecorded");
  widget.append("assistant", "readback");
  const checked: string[] = [];
  widget.removeRecorded((role, id) => { checked.push(`${role}:${id}`); return false; });
  assert.deepEqual(checked, ["user:rejected", "assistant:unrecorded"]);
  assert.equal(render(widget), "Talk · live · /talk stop\nYou …: rejected prompt\nVoice …: readback");
});

test("recording matches role as well as ID for live and completed captions", () => {
  const widget = createTalkWidget();
  for (const role of ["user", "assistant"] as const) {
    widget.start(role, "shared");
    widget.append(role, "same text");
  }
  widget.removeRecorded((role, id) => role === "user" && id === "shared");
  widget.append("assistant", " visible suffix");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: same text visible suffix");
  widget.finish("user", "same final", "shared");
  widget.finish("assistant", "same final", "shared");
  widget.removeRecorded((role, id) => role === "user" && id === "shared");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice: same final");
  widget.removeRecorded((role, id) => role === "assistant" && id === "shared");
  assert.equal(render(widget), "Talk · live · /talk stop\nReady — start speaking");
});

test("finish without an ID preserves the bound ID and hidden state", () => {
  const widget = createTalkWidget();
  widget.start("user", "accepted");
  widget.append("user", "accepted prompt");
  widget.removeRecorded(() => true);
  widget.finish("user", "final without ID");
  assert.equal(render(widget), "Talk · live · /talk stop\nReady — start speaking");
  const checked: string[] = [];
  widget.removeRecorded((_role, id) => { checked.push(id); return true; });
  assert.deepEqual(checked, ["accepted"]);
  widget.start("user", "accepted");
  assert.equal(render(widget), "Talk · live · /talk stop\nReady — start speaking");
  widget.append("user", "next unidentified partial");
  assert.match(render(widget), /You …: next unidentified partial$/);
});

test("late final with a different ID cannot clobber a newer identified live turn", () => {
  for (const hidden of [false, true]) {
    const widget = createTalkWidget();
    widget.start("user", "old");
    widget.append("user", "old partial");
    widget.start("user", "new");
    widget.append("user", "new partial");
    if (hidden) widget.removeRecorded((_role, id) => id === "new");
    const beforeFinal = render(widget);
    widget.finish("user", "late old final", "old");
    widget.finish("user", "", "another-old");
    assert.equal(render(widget), beforeFinal);
    widget.append("user", " suffix");
    assert.equal(render(widget), hidden
      ? "Talk · live · /talk stop\nReady — start speaking"
      : "Talk · live · /talk stop\nYou …: new partial suffix");
    widget.finish("user", "new final", "new");
    assert.equal(render(widget), hidden
      ? "Talk · live · /talk stop\nReady — start speaking"
      : "Talk · live · /talk stop\nYou: new final");
  }
});

test("stale completion metadata does not finish a newer live caption", () => {
  const widget = createTalkWidget();
  widget.finish("user", "old caption", "old-turn");
  widget.append("user", "new live");
  widget.finish("user", "late old caption", "old-turn");
  assert.equal(render(widget), "Talk · live · /talk stop\nYou …: new live");
});

test("removing an old recorded ID does not clear a newer live caption", () => {
  const widget = createTalkWidget();
  widget.finish("user", "old caption", "old-turn");
  widget.append("user", "new live");
  widget.removeRecorded((_role, id) => id === "old-turn");
  assert.equal(render(widget), "Talk · live · /talk stop\nYou …: new live");
});

test("full duplex uses first-fragment order even when completion order differs", () => {
  const widget = createTalkWidget();
  widget.append("assistant", "voice");
  widget.append("user", "you");
  assert.match(render(widget), /Voice …: voice\nYou …: you/);
  widget.finish("user", "user final");
  assert.match(render(widget), /Voice …: voice\nYou: user final/);
  widget.finish("assistant", "voice final");
  assert.match(render(widget), /Voice: voice final\nYou: user final/);
});

test("empty finals remove false partials without restoring replaced captions", () => {
  const widget = createTalkWidget();
  widget.finish("user", "keep");
  widget.append("user", "false partial");
  widget.append("assistant", "false voice");
  widget.finish("user", " \t\n");
  widget.finish("assistant", "");
  widget.finish("assistant", "");
  widget.append("assistant", "");
  assert.equal(render(widget), "Talk · live · /talk stop\nReady — start speaking");
});

test("many turns retain at most one caption per speaker", () => {
  const widget = createTalkWidget();
  for (let i = 0; i < 100; i++) {
    widget.finish("user", `user-${i}`);
    widget.finish("assistant", `voice-${i}`);
  }
  const output = render(widget);
  assert.equal((output.match(/You:/g) ?? []).length, 1);
  assert.equal((output.match(/Voice:/g) ?? []).length, 1);
  assert.match(output, /You: user-99/);
  assert.match(output, /Voice: voice-99/);
  assert.doesNotMatch(output, /user-98|voice-98/);
});

test("first fragment replaces a completed caption, including unrecorded assistant readbacks", () => {
  const widget = createTalkWidget();
  widget.finish("assistant", "old readback");
  widget.finish("user", "previous user");
  widget.append("assistant", "new readback");
  assert.equal(render(widget), "Talk · live · /talk stop\nYou: previous user\nVoice …: new readback");
  widget.append("user", "new user");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice …: new readback\nYou …: new user");
  widget.finish("assistant", "new readback final");
  assert.equal(render(widget), "Talk · live · /talk stop\nVoice: new readback final\nYou …: new user");
});

test("long history cannot push either active speaker out; height is at most fourteen", () => {
  const widget = createTalkWidget();
  for (let i = 0; i < 20; i++) widget.finish("assistant", `old-${i} ` + "history ".repeat(1000));
  widget.append("user", "live-user " + "caption ".repeat(1000));
  widget.append("assistant", "live-voice " + "caption ".repeat(1000));
  widget.append("user", "latest-user");
  widget.append("assistant", "latest-voice");
  const lines = widget.render(40, theme, { state: "starting", progress: "progress", browserUrl: "url" });
  assert.ok(lines.length <= 14);
  assert.match(lines.join("\n"), /You …: …\n/);
  assert.match(lines.join("\n"), /Voice …: …\n/);
  assert.match(lines.join("\n"), /latest-user(?:\n|$)/);
  assert.match(lines.join("\n"), /latest-voice(?:\n|$)/);
  assert.doesNotMatch(lines.join("\n"), /old-19|old-18|old-0/);
  assert.ok(lines.filter((line) => line.endsWith("…")).length >= 2);
});

test("text storage is capped for append and final, with Unicode-safe clipping", () => {
  for (const final of [false, true]) {
    const widget = createTalkWidget();
    if (final) widget.finish("user", "😀".repeat(2000) + "TAIL");
    else {
      for (let i = 0; i < 1000; i++) widget.append("user", "😀".repeat(10));
      widget.append("user", "TAIL");
    }
    const output = render(widget, 10000);
    assert.ok(output.length < 2200);
    assert.doesNotMatch(output, /\p{Surrogate}/u);
    if (final) {
      assert.doesNotMatch(output, /TAIL/);
      assert.ok(output.endsWith("…"));
    } else {
      assert.ok(output.endsWith("TAIL"));
      assert.match(output, /You …: …\n/);
    }
  }
});

test("live captions follow the latest wrapped rows before reaching the storage cap", () => {
  const widget = createTalkWidget();
  widget.append("user", "first\nsecond\nthird\nfourth\nlatest-user");
  widget.append("assistant", "first\nsecond\nthird\nfourth\nlatest-voice");
  const lines = widget.render(40, theme, active);
  assert.deepEqual(lines.slice(1), [
    "You …: …", "fourth", "latest-user",
    "Voice …: …", "fourth", "latest-voice",
  ]);
  widget.append("user", "-new");
  assert.match(render(widget, 40), /latest-user-new\n/);
});

test("tail clipping preserves Unicode boundaries and keeps consuming split escapes", () => {
  const widget = createTalkWidget();
  widget.append("user", "😀".repeat(2000) + "x");
  let output = render(widget, 10000);
  assert.doesNotMatch(output, /\p{Surrogate}/u);
  assert.ok(output.endsWith("x"));
  widget.append("user", "\x1b]52;c;" + "SECRET".repeat(1000));
  widget.append("user", "\x1b");
  widget.append("user", "\\TAIL\x1b[");
  widget.append("user", "31mLATEST");
  output = render(widget, 10000);
  assert.ok(output.endsWith("TAILLATEST"));
  assert.doesNotMatch(output, /SECRET|31m|\x1b|\p{Surrogate}/u);
});

test("zero and narrow widths handle emoji, CJK, tabs, and multiline captions", () => {
  const widget = createTalkWidget();
  widget.finish("user", "first\nsecond\tcolumn\nthird\nfourth");
  widget.append("user", "你好 👩‍💻 😀 é ".repeat(100));
  widget.append("assistant", "界😀\nvoice\nmore\nlast");
  for (const width of [0, 1, 2, 10, 40, 120]) {
    const lines = widget.render(width, theme, active);
    assert.ok(lines.length <= 14);
    assert.ok(lines.every((line) => !/[\n\r\t]/.test(line) && visibleWidth(line) <= width), JSON.stringify({ width, lines }));
    if (!width) assert.deepEqual(lines, []);
  }
  const simple = createTalkWidget();
  simple.finish("user", "first\nsecond\tcolumn");
  assert.match(render(simple), /You: first\nsecond column/);
});

test("untrusted terminal sequences, split OSC/CSI, controls, and bidi never escape", () => {
  const widget = createTalkWidget();
  widget.append("user", "safe\x1b[");
  widget.append("user", "31mred\x1b]52;c;SECRET");
  widget.append("user", "\x1b");
  widget.append("user", "\\done\x9dHIDDEN\x9c\x1bPPRIVATE\x1b\\\x1b(BCLEAN");
  widget.append("user", "\x00\x08\r\x7f\u202e\u2066\u061c");
  assert.match(render(widget), /safereddoneCLEAN/);
  assert.doesNotMatch(render(widget), /SECRET|HIDDEN|PRIVATE|31m|[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e\u2066\u061c]/);
  widget.finish("user", "final\x1b[2J\x1b]8;;https://evil\x07link\x1b]8;;\x07");
  assert.match(render(widget), /You: finallink/);
  const lines = widget.render(120, theme, { state: "starting", progress: "\x1b[31mOK\u202e", browserUrl: "url\x1b]52;SECRET\x07" });
  assert.doesNotMatch(lines.join(""), /\x1b|SECRET|\u202e/);
});

test("speaker colors are distinct and theme is applied at render time", () => {
  const widget = createTalkWidget();
  widget.finish("user", "hello");
  widget.finish("assistant", "hi");
  const calls: [string, string][] = [];
  widget.render(120, { fg: (color, text) => { calls.push([color, text]); return text; }, bold: (text) => text }, active);
  const user = calls.find(([, text]) => text === "You: hello")!;
  const voice = calls.find(([, text]) => text === "Voice: hi")!;
  assert.ok(user && voice);
  assert.notEqual(user[0], voice[0]);
});
