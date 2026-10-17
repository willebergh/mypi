import assert from "node:assert/strict";
import test from "node:test";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { createTalkTerminalContext } from "../extensions/talk/terminal-context.ts";

function message(role: string, content: unknown, stopReason = "stop") {
  return { role, content, stopReason } as MessageEndEvent["message"];
}
const user = (text = "Typed request") => message("user", [{ type: "text", text }]);
const assistant = (text: string, stopReason = "stop") => message("assistant", [{ type: "text", text }], stopReason);

function session() {
  const quiet: Array<{ id: string | null; text: string }> = [];
  let attempts = 0;
  let throwing = false;
  return {
    quiet,
    get attempts() { return attempts; },
    fail() { throwing = true; },
    thinking(id: string | null, text: string) {
      attempts++;
      if (throwing) throw new Error("private transport failure details");
      quiet.push({ id, text });
    },
    commentary() { assert.fail("Terminal context must not request speech"); },
    append() { assert.fail("Terminal context must not send audio"); },
  };
}

function harness() {
  const live = session();
  let target: ReturnType<typeof session> | undefined = live;
  let warnings = 0;
  const context = createTalkTerminalContext(() => target, () => { warnings++; });
  return {
    context, live,
    get warnings() { return warnings; },
    target(value: typeof target) { target = value; },
    start(text = "Typed request") {
      context.input(text, "interactive");
      context.message(user(text));
    },
  };
}

function reference(text: string, label: "user" | "reply") {
  assert.match(text, new RegExp(`^Pi terminal ${label} \\(reference only\\):`));
  assert.match(text, /not an additional delegation or approval/i);
  assert.match(text, /Silent unless asked; use for follow-ups\./);
  assert.doesNotMatch(text, /Stay silent\./);
  assert.doesNotMatch(text, /\[talk:(?:user|assistant)\]/);
  assert.ok(Buffer.byteLength(text) <= 450);
  assert.equal(Buffer.from(text).toString("utf8"), text);
  assert.doesNotMatch(text, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
}

test("interactive submission is quiet reference, not a delegation or a claim of execution", () => {
  const h = harness();
  h.context.input("  Inspect package.json\nwithout changing it  ", "interactive");
  assert.equal(h.live.quiet.length, 1, "submission is forwarded before Pi accepts or runs anything");
  assert.equal(h.live.quiet[0].id, null);
  reference(h.live.quiet[0].text, "user");
  assert.match(h.live.quiet[0].text, /submitted to Pi; may be queued or handled locally, not proof of execution/);
  assert.ok(h.live.quiet[0].text.endsWith("Inspect package.json\nwithout changing it"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 1, "locally handled input need not have an assistant reply");
});

test("only an actual final-reply send closes the voice-history window, before Live receives it", () => {
  const live = session();
  let presentations = 0;
  const context = createTalkTerminalContext(() => live, () => assert.fail("unexpected send failure"), () => {
    presentations++;
    assert.equal(live.quiet.length, 1, "close the history window before the reply is sent");
  });
  context.input("Typed request", "interactive");
  assert.equal(presentations, 0, "submissions alone are not backend replies");
  context.message(user());
  context.message(assistant("Backend reply"));
  assert.equal(presentations, 0);
  context.settled();
  context.settled();
  assert.equal(presentations, 1);
  assert.equal(live.quiet.length, 2);
  context.close();
  context.input("Late", "interactive");
  context.message(user("Late"));
  context.message(assistant("Late reply"));
  context.settled();
  assert.equal(presentations, 1);
});

test("only the latest native assistant text is forwarded once, at final settlement", () => {
  const h = harness();
  h.start();
  h.context.message(assistant("Intermediate answer"));
  h.context.message(message("assistant", [
    { type: "thinking", thinking: "PRIVATE THOUGHT" },
    { type: "toolCall", id: "secret", name: "tool", arguments: { secret: "PRIVATE ARGS" } },
    { type: "text", text: "Checking files" },
  ], "toolUse"));
  h.context.message(message("toolResult", [{ type: "text", text: "PRIVATE TOOL OUTPUT" }]));
  h.context.message(message("custom", "PRIVATE CUSTOM HISTORY"));
  assert.equal(h.live.quiet.length, 2, "public progress is immediate, not a final reply");
  assert.match(h.live.quiet[1].text, /^Pi terminal commentary/);
  h.context.message(assistant("Verified result\nMore detail"));
  assert.equal(h.live.quiet.length, 2, "the final reply still waits for settlement");
  h.context.settled();
  h.context.settled();
  assert.equal(h.live.quiet.length, 3);
  assert.equal(h.live.quiet[2].id, null);
  reference(h.live.quiet[2].text, "reply");
  assert.match(h.live.quiet[2].text, /already handled by Pi/);
  assert.ok(h.live.quiet[2].text.endsWith("Verified result\nMore detail"));
  assert.doesNotMatch(JSON.stringify(h.live.quiet), /PRIVATE|Intermediate/);
});

test("empty and control-only submissions do not acquire ownership", () => {
  for (const text of ["", " \n\t", "\0\x1b\u202e"]) {
    const h = harness();
    h.context.input(text, "interactive");
    h.context.message(user(text));
    h.context.message(assistant("Unowned result"));
    h.context.settled();
    assert.deepEqual(h.live.quiet, []);
  }
});

test("noninteractive sources never mirror, even when their text is identical to typed text", () => {
  for (const source of ["extension", "rpc", "voice", "unknown"]) {
    const h = harness();
    h.context.input("Typed request", source);
    h.context.message(user());
    h.context.message(assistant("Not terminal-owned"));
    h.context.settled();
    assert.deepEqual(h.live.quiet, []);
  }
});

test("new extension or RPC input revokes terminal ownership and drops a captured reply", () => {
  for (const source of ["extension", "rpc"]) {
    const h = harness();
    h.start();
    h.context.message(assistant("Old terminal reply"));
    h.context.input("Typed request", source);
    h.context.message(user());
    h.context.message(assistant("Voice reply, already returned by the bridge"));
    h.context.settled();
    assert.equal(h.live.quiet.length, 1);
    assert.doesNotMatch(h.live.quiet[0].text, /Old terminal reply|Voice reply/);
  }
});

test("even empty extension input clears ownership, and a later typed run can acquire it again", () => {
  const h = harness();
  h.start();
  h.context.input("", "extension");
  h.context.message(assistant("Do not mirror"));
  h.context.settled();
  h.start("New typed request");
  h.context.message(assistant("New terminal result"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 3);
  assert.ok(h.live.quiet[2].text.endsWith("New terminal result"));
});

test("queued or locally handled input cannot mirror the earlier in-flight reply", () => {
  const h = harness();
  h.context.input("Queued typed request", "interactive");
  h.context.message(assistant("Previous run's reply"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 1);
  h.context.message(user("Unattributed later user"));
  h.context.message(assistant("No surviving ownership"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 1);
});

test("queued voice follow-up preserves and quietly hands off the terminal final at the next native user boundary", () => {
  const live = session();
  let presentations = 0;
  const context = createTalkTerminalContext(() => live, () => assert.fail("unexpected send failure"), () => {
    presentations++;
    assert.equal(live.quiet.length, 1, "history window closes before boundary reply delivery");
  });
  context.input("Terminal task", "interactive");
  context.message(user("Terminal task"));
  context.input("Voice follow-up", "extension", "followUp");
  context.message(assistant("Terminal final"));
  context.message(user("Voice follow-up"));
  assert.equal(live.quiet.length, 2);
  assert.ok(live.quiet[0].text.endsWith("Terminal task"));
  assert.ok(live.quiet[1].text.endsWith("Terminal final"));
  assert.equal(presentations, 1);
  context.message(assistant("Voice answer must not mirror"));
  context.settled();
  assert.equal(live.quiet.length, 2);
  assert.equal(presentations, 1);
});

test("queued follow-up boundary forwards only latest stop final, while settlement can deliver it once", () => {
  const priorFinal = harness();
  priorFinal.start("Terminal task");
  priorFinal.context.message(assistant("Reply arrived before queue submission"));
  priorFinal.context.input("Voice follow-up", "extension", "followUp");
  priorFinal.context.message(user("Voice follow-up"));
  assert.equal(priorFinal.live.quiet.length, 2);
  assert.ok(priorFinal.live.quiet[1].text.endsWith("Reply arrived before queue submission"));

  const h = harness();
  h.start("Terminal task");
  h.context.input("Voice follow-up", "extension", "followUp");
  h.context.message(assistant("Terminal result"));
  h.context.message(message("assistant", [{ type: "toolCall", id: "x", name: "tool", arguments: {} }], "toolUse"));
  h.context.message(user("Voice follow-up"));
  assert.equal(h.live.quiet.length, 1);
  assert.doesNotMatch(h.live.quiet[0].text, /Terminal result/);

  const beforeConsumption = harness();
  beforeConsumption.start("Terminal task");
  beforeConsumption.context.input("Voice follow-up", "extension", "followUp");
  beforeConsumption.context.message(assistant("Terminal final"));
  beforeConsumption.context.settled();
  beforeConsumption.context.settled();
  beforeConsumption.context.message(user("Voice never consumed"));
  assert.equal(beforeConsumption.live.quiet.length, 2);
  assert.ok(beforeConsumption.live.quiet[1].text.endsWith("Terminal final"));
});

test("queued typed input becomes eligible when consumed; repeated submissions remain distinct", () => {
  const h = harness();
  h.context.input("Same text", "interactive");
  h.context.message(assistant("Previous response before queue consumption"));
  h.context.input("Same text", "interactive");
  h.context.message(user("Same text"));
  h.context.message(assistant("First intermediate"));
  h.context.message(user("Same text"));
  h.context.message(assistant("Final queued result"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 3);
  assert.equal(h.live.quiet[0].text, h.live.quiet[1].text);
  assert.ok(h.live.quiet[2].text.endsWith("Final queued result"));
});

test("a later native user message clears a stale assistant candidate", () => {
  const h = harness();
  h.start();
  h.context.message(assistant("Not the final answer"));
  h.context.message(user("Next queued terminal message"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 1);
});

test("public tool-call commentary is relayed immediately, quietly, and never becomes a settled reply", () => {
  const live = session();
  const order: string[] = [];
  const context = createTalkTerminalContext(() => live, () => assert.fail("unexpected send failure"), () => {
    order.push("callback");
    assert.equal(live.quiet.length, 1, "callback runs before Pi commentary delivery");
  });
  context.input("Typed", "interactive");
  context.message(user());
  context.message(message("assistant", [
    { type: "thinking", thinking: "PRIVATE THINKING" },
    { type: "toolCall", id: "secret", name: "secret-tool", arguments: { token: "PRIVATE ARGS" } },
    { type: "text", text: "Checking the result" },
  ], "toolUse"));
  assert.equal(live.quiet.length, 2);
  assert.match(live.quiet[1].text, /^Pi terminal commentary \(reference only\): work in progress, not a completion result\./);
  assert.ok(live.quiet[1].text.endsWith("Checking the result"));
  assert.doesNotMatch(live.quiet[1].text, /PRIVATE|secret-tool|token/);
  assert.deepEqual(order, ["callback"]);
  context.settled();
  assert.equal(live.quiet.length, 2, "progress is not replayed as the completion");
  assert.deepEqual(order, ["callback"]);
});

test("consecutive public commentary deduplicates by clipped UTF-8 content, including long Unicode", () => {
  const h = harness();
  h.start();
  const publicText = "😀".repeat(300);
  const toolMessage = () => message("assistant", [{ type: "text", text: publicText }], "toolUse");
  h.context.message(toolMessage());
  h.context.message(toolMessage());
  assert.equal(h.live.quiet.length, 2, "same clipped public commentary is sent only once");
  assert.match(h.live.quiet[1].text, /^Pi terminal commentary \(reference only\): work in progress, not a completion result\./);
  assert.ok(Buffer.byteLength(h.live.quiet[1].text) <= 450);
  assert.equal(Buffer.from(h.live.quiet[1].text).toString("utf8"), h.live.quiet[1].text);
  h.context.settled();
  assert.equal(h.live.quiet.length, 2, "tool-call progress is never a final reply");
});

test("empty, thinking-only and tool-only latest assistant messages never reuse an earlier answer", () => {
  for (const content of [[], [{ type: "text", text: " \n" }],
    [{ type: "thinking", thinking: "PRIVATE" }],
    [{ type: "toolCall", name: "tool", id: "x", arguments: {} }]]) {
    const h = harness();
    h.start();
    h.context.message(assistant("Stale intermediate success"));
    h.context.message(message("assistant", content));
    h.context.settled();
    assert.equal(h.live.quiet.length, 1);
  }
});

test("error and aborted stops replace partial success text with an unconfirmed status", () => {
  for (const stopReason of ["error", "aborted"]) {
    const h = harness();
    h.start();
    h.context.message(assistant("Stale success"));
    h.context.message(assistant("Everything succeeded! PRIVATE PARTIAL", stopReason));
    h.context.settled();
    reference(h.live.quiet[1].text, "reply");
    assert.match(h.live.quiet[1].text, /error or interruption\. Completion is not confirmed/);
    assert.doesNotMatch(h.live.quiet[1].text, /Stale success|Everything succeeded|PRIVATE/);
  }
});

test("automatic recovery can replace an error before final settlement", () => {
  const h = harness();
  h.start();
  h.context.message(assistant("Failed attempt", "error"));
  h.context.message(assistant("Recovered final reply"));
  h.context.settled();
  assert.ok(h.live.quiet[1].text.endsWith("Recovered final reply"));
  assert.doesNotMatch(h.live.quiet[1].text, /Failed attempt|error or interruption/);
});

test("450-byte UTF-8 cap includes wrappers and leaves useful content for both roles", () => {
  for (const chunk of ["x", "å", "😀", "\ud800", "\0\u202e😀"]) {
    const h = harness();
    h.start(chunk.repeat(2000));
    h.context.message(assistant(chunk.repeat(2000)));
    h.context.settled();
    assert.equal(h.live.quiet.length, 2);
    for (const [index, update] of h.live.quiet.entries()) {
      reference(update.text, index === 0 ? "user" : "reply");
      const body = update.text.split("\n").slice(1).join("\n");
      assert.ok(Buffer.byteLength(body) >= 250, "wrapper must leave a useful content budget");
      assert.ok(Buffer.byteLength(update.text) >= 446);
    }
  }
});

test("inactive input is not buffered and the live target is resolved dynamically", () => {
  const h = harness();
  h.target(undefined);
  h.start("Before activation");
  h.target(h.live);
  h.context.message(assistant("Not owned"));
  h.context.settled();
  assert.deepEqual(h.live.quiet, []);
  h.start();
  const replacement = session();
  h.target(replacement);
  h.context.message(assistant("Current live target"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 1);
  assert.equal(replacement.quiet.length, 1);
  assert.ok(replacement.quiet[0].text.endsWith("Current live target"));
});

test("closed terminal scope never emits later public commentary", () => {
  const h = harness();
  h.start();
  h.context.close();
  h.context.message(message("assistant", [{ type: "text", text: "Must not leak" }], "toolUse"));
  h.context.settled();
  assert.equal(h.live.quiet.length, 1);
});

test("inactive settlement, close and a new call cannot forward stale replies", () => {
  const h = harness();
  h.start();
  h.context.message(assistant("Stale reply"));
  h.target(undefined);
  h.context.settled();
  h.target(h.live);
  h.context.settled();
  assert.equal(h.live.quiet.length, 1);
  h.start("Another request");
  h.context.message(assistant("Late after close"));
  h.context.close();
  h.context.close();
  h.context.settled();
  h.context.input("After close", "interactive");
  h.context.message(user());
  h.context.message(assistant("Late after close"));
  h.context.settled();
  const next = createTalkTerminalContext(() => h.live, () => assert.fail("unexpected failure"));
  next.message(assistant("Previous call's late reply"));
  next.settled();
  assert.equal(h.live.quiet.length, 2);
});

test("failed quiet send disables only this mirror, warns once and never retries", () => {
  for (const at of ["input", "reply"]) {
    const h = harness();
    if (at === "reply") h.start();
    h.live.fail();
    assert.doesNotThrow(() => {
      if (at === "input") h.start();
      h.context.message(assistant("Result"));
      h.context.settled();
      for (let i = 0; i < 20; i++) {
        h.start();
        h.context.message(assistant("Later result"));
        h.context.settled();
      }
      h.context.close();
    });
    assert.equal(h.warnings, 1);
    assert.equal(h.live.attempts, at === "input" ? 1 : 2);
    assert.equal(h.live.quiet.length, at === "input" ? 0 : 1);
  }
});
