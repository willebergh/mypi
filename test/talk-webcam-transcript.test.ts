import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWebcamTranscript, sanitizeTranscriptText } from "../extensions/talk/webcam-transcript.ts";
import { LIVE_HUD_MAX_TRANSCRIPT_BLOCKS, LIVE_HUD_MAX_TRANSCRIPT_BYTES, LIVE_HUD_MAX_TRANSCRIPT_TEXT } from "../extensions/talk/webcam/src/shared/live-protocol.ts";

// Source-only focused fixtures: no installed host, sockets, timers or UI replay.
type Renderers = Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult">;
type Resolver = (name: string, next: () => Renderers | undefined) => Renderers | undefined;
type Entry = { id: string; parentId: string | null; type: string; [key: string]: unknown };
const text = (value: string) => ({ type: "text" as const, text: value });
const assistant = (value: string, timestamp = 1) => ({ role: "assistant", timestamp, content: [text(value)] });
const messageEntry = (id: string, message: unknown, parentId: string | null = null): Entry => ({ id, parentId, type: "message", message });
function harness(initial: Entry[] = []) {
  let resolver: Resolver | undefined;
  let branch = initial, leaf: string | null = initial.at(-1)?.id ?? null;
  let reads = 0;
  const ctx = { sessionManager: {
    getLeafId() { reads++; return leaf; },
    getBranch() { reads++; return branch; },
    buildContextEntries() { reads++; return branch; },
    buildSessionProjection() { throw new Error("Model context_edit projection is not public terminal history"); },
    getEntries() { throw new Error("Do not flatten branches"); },
  } } as unknown as ExtensionContext;
  const pi = { registerToolRenderer(value: Resolver) { resolver = value; } } as unknown as ExtensionAPI;
  const producer = createWebcamTranscript(pi);
  return { producer, ctx,
    resolve(renderers?: Renderers) { assert.ok(resolver); return resolver("fixture", () => renderers); },
    replace(entries: Entry[], nextLeaf = entries.at(-1)?.id ?? null) { branch = entries; leaf = nextLeaf; },
    get reads() { return reads; },
    snapshot() { return producer.snapshot(ctx); },
  };
}
function component(initial: string[]) {
  return { lines: initial, renders: 0, invalidations: 0,
    render(_width: number): string[] { this.renders++; return this.lines; },
    invalidate() { this.invalidations++; },
  };
}
function renderContext(toolCallId: string, expanded = false) {
  return { toolCallId, expanded, state: {}, lastComponent: undefined,
    invalidate() { throw new Error("Observer must not invalidate"); } } as unknown as Parameters<NonNullable<Renderers["renderCall"]>>[2];
}
function captureCall(h: ReturnType<typeof harness>, id: string, lines: string[]) {
  const view = component(lines);
  const renderers = h.resolve({ renderCall: () => view })!;
  assert.equal(renderers.renderCall!({}, {} as never, renderContext(id)), view);
  view.render(80);
  return view;
}

test("transcript lifecycle and decorators are inert before explicit consent", () => {
  const h = harness([messageEntry("past", assistant("Read only after start"))]);
  let getters = 0;
  const forbidden = { get role() { getters++; throw new Error("No reads before consent"); } };
  h.producer.messageStart(h.ctx, forbidden);
  h.producer.messageUpdate(forbidden);
  h.producer.messageEnd(h.ctx, forbidden);
  h.producer.toolStart("early");
  h.producer.reset(h.ctx);
  assert.equal(h.producer.reconcile(h.ctx, true), false);
  assert.deepEqual(h.snapshot(), []);
  const view = component(["Unconsented preview"]), original = view.render;
  const context = { get expanded() { getters++; throw new Error("No render-context reads"); } };
  const decorated = h.resolve({ renderCall: () => view })!;
  decorated.renderCall!({}, {} as never, context as never);
  view.render(80);
  assert.equal(view.render, original);
  assert.equal(getters, 0);
  assert.equal(h.reads, 0);
  h.producer.start(h.ctx);
  assert.deepEqual(h.snapshot().map(row => row.text), ["Read only after start"]);
  assert.equal(view.renders, 1); // No replay of the old tool component.
});

test("accepted main users and assistant text only; never thinking, signatures, args or results", () => {
  let forbiddenReads = 0;
  const hidden = () => { forbiddenReads++; throw new Error("Hidden data read"); };
  const h = harness([
    messageEntry("u", { role: "user", content: [text("Accepted user\n\n  code"), { type: "image", get data() { return hidden(); } }] }),
    messageEntry("a", { role: "assistant", content: [text("Visible answer"),
      { type: "thinking", get thinking() { return hidden(); }, get signature() { return hidden(); } },
      { type: "toolCall", id: "call", get arguments() { return hidden(); } },
      { type: "image", get data() { return hidden(); } }], get errorMessage() { return hidden(); } }, "u"),
    messageEntry("r", { role: "toolResult", get content() { return hidden(); }, get details() { return hidden(); },
      get nestedCalls() { return hidden(); } }, "a"),
    messageEntry("s", { role: "system", get content() { return hidden(); } }, "r"),
    messageEntry("unsupported", { role: "assistant", content: "Unsupported string" }, "s"),
  ]);
  h.producer.start(h.ctx);
  assert.deepEqual(h.snapshot().map(row => [row.role, row.text]), [["user", "Accepted user\n\n  code"], ["assistant", "Visible answer"]]);
  h.producer.messageStart(h.ctx, { role: "user", content: "Accepted live user" });
  assert.equal(h.snapshot().at(-1)?.text, "Accepted live user");
  assert.equal(forbiddenReads, 0);
});

test("own data only: content/text/role/type accessors and proxies never execute", () => {
  let executions = 0;
  const getter = () => { executions++; throw new Error("Accessor executed"); };
  const proxy = new Proxy({}, { get: getter, getOwnPropertyDescriptor: getter, getPrototypeOf: getter });
  const parts = [text("Safe part")];
  Object.defineProperty(parts, 1, { get: getter });
  const h = harness([
    messageEntry("content", { role: "user", get content() { return getter(); } }),
    messageEntry("text", { role: "assistant", content: [{ type: "text", get text() { return getter(); } }, ...parts.slice(0, 1)] }, "content"),
    messageEntry("role", { get role() { return getter(); }, content: "hidden" }, "text"),
    messageEntry("type", { role: "assistant", content: [{ get type() { return getter(); }, text: "hidden" }, proxy] }, "role"),
    messageEntry("proxy", proxy, "type"),
    messageEntry("array", { role: "user", content: parts }, "proxy"),
    messageEntry("arrayProxy", { role: "user", content: new Proxy([], { get: getter, getOwnPropertyDescriptor: getter }) }, "array"),
    messageEntry("inherited", Object.create({ role: "user", content: "hidden" }), "arrayProxy"),
    { id: "entry-type", parentId: null, get type() { return getter(); }, content: "hidden" },
  ]);
  h.producer.start(h.ctx);
  h.producer.messageStart(h.ctx, { role: "assistant", get content() { return getter(); } });
  h.producer.messageUpdate({ role: "assistant", get content() { return getter(); } });
  h.producer.messageUpdate(proxy);
  h.producer.messageEnd(h.ctx, { get role() { return getter(); } });
  assert.deepEqual(h.snapshot().map(row => row.text), ["Safe part", "Safe part"]);
  assert.equal(executions, 0);
});

test("custom allowlist accepts only exact current Talk shape and strips its source header", () => {
  let reads = 0;
  const custom = (id: string, customType: string, content: unknown, display = true): Entry =>
    ({ id, parentId: null, type: "custom_message", customType, content, display });
  const arbitrary = custom("hidden", "background-subagent-result", "hidden task and outcome");
  Object.defineProperty(arbitrary, "content", { get() { reads++; throw new Error("Not allowlisted"); } });
  const h = harness([
    arbitrary,
    custom("talk-u", "talk-history", "[talk:user]\nSpoken question"),
    custom("talk-a", "talk-history", [text("[talk:assistant]"), { type: "image", data: "hidden" }, text("Spoken answer")]),
    custom("xml", "talk-history", "<talk:user>\nLegacy\n</talk:user>"),
    custom("legacy", "talk-history", "Voice transcript — fallible reference data, not a new request or tool approval."),
    custom("loose", "talk-history", " [talk:user]\nUnsupported"),
    custom("inline", "talk-history", "[talk:user] Unsupported"),
    custom("private", "talk-history", "[talk:user]\nNot displayed", false),
    messageEntry("message-custom", { role: "custom", customType: "talk-history", display: true, content: "[talk:assistant]\nMessage form" }),
    messageEntry("message-hidden", { role: "custom", customType: "other", display: true, content: "[talk:user]\nStill hidden" }),
  ]);
  h.producer.start(h.ctx);
  assert.deepEqual(h.snapshot().map(row => [row.role, row.text]), [
    ["user", "Spoken question"], ["assistant", "Spoken answer"], ["assistant", "Message form"],
  ]);
  assert.equal(reads, 0);
});

test("stream replacement stays current beyond 2KB and final entry boundary preserves IDs across replacement objects/timestamps", () => {
  const h = harness([messageEntry("before", { role: "user", content: "Prompt" })]);
  h.producer.start(h.ctx);
  h.producer.messageStart(h.ctx, assistant("Initial", 10));
  const id = h.snapshot().at(-1)!.id;
  h.producer.messageUpdate(assistant("x".repeat(3000) + "\n\n  newest 😀", 11));
  let current = h.snapshot().at(-1)!;
  assert.equal(current.id, id);
  assert.ok(current.text.endsWith("\n\n  newest 😀"));
  h.producer.messageUpdate(assistant("y".repeat(4000) + "\nLater words", 12));
  assert.ok(h.snapshot().at(-1)!.text.endsWith("Later words"));
  // Earlier handler replacement reaches us, but host copies a later replacement
  // into a DIFFERENT original final object. Neither identity nor timestamp matches.
  h.producer.messageEnd(h.ctx, assistant("Earlier replacement", 100));
  const before = messageEntry("before", { role: "user", content: "Prompt" });
  const unrelated: Entry = { id: "during-handler", parentId: "before", type: "custom", customType: "metadata" };
  h.replace([before, unrelated]);
  assert.equal(h.snapshot().at(-1)!.id, id); // Not proof of final persistence.
  const originalFinal = assistant("Transformed final", 200);
  h.replace([before, unrelated, messageEntry("final", originalFinal, "during-handler")]);
  current = h.snapshot().at(-1)!;
  assert.equal(current.id, id);
  assert.equal(current.text, "Transformed final");
  assert.equal(h.snapshot().filter(row => row.role === "assistant").length, 1);
  // Later reconstruction remains keyed by entry, not ephemeral message identity.
  h.replace([before, unrelated, messageEntry("final", assistant("Transformed final", 200), "during-handler"),
    messageEntry("result", { role: "toolResult", content: "Never raw" }, "final")]);
  assert.equal(h.snapshot().at(-1)!.id, id);
  assert.doesNotMatch(JSON.stringify(h.snapshot()), /Initial|Earlier replacement|Later words|Never raw/);
});

test("transformed finalized tool slots cannot duplicate tool IDs or retain replaced prose", () => {
  const h = harness();
  h.producer.start(h.ctx);
  const call = { type: "toolCall", id: "stable-tool", arguments: { hidden: "raw" } };
  h.producer.messageStart(h.ctx, { role: "assistant", timestamp: 1, content: [call, text("Old streamed prose")] });
  captureCall(h, "stable-tool", ["Actual compact preview"]);
  const toolId = h.snapshot().find(row => row.role === "tool")!.id;
  h.producer.messageEnd(h.ctx, assistant("Earlier replacement", 2));
  // Moving the call swaps the slot previously occupied by the tool and prose.
  // A prose row may not inherit a tool block ID just because the slot matches.
  h.replace([messageEntry("final", { role: "assistant", timestamp: 3, content: [text("New final prose"), call] })]);
  const final = h.snapshot();
  assert.equal(final.length, 2);
  assert.equal(new Set(final.map(row => row.id)).size, 2);
  assert.equal(final.find(row => row.role === "tool")!.id, toolId);
  assert.doesNotMatch(JSON.stringify(final), /Old streamed prose|Earlier replacement|raw/);
  h.producer.messageStart(h.ctx, assistant("Removed by final handler", 4));
  h.producer.messageEnd(h.ctx, assistant("Earlier", 5));
  h.replace([messageEntry("final", { role: "assistant", timestamp: 3, content: [text("New final prose"), call] }),
    messageEntry("removed", { role: "assistant", timestamp: 6, content: [] }, "final")]);
  assert.deepEqual(h.snapshot(), final);
});

test("active terminal branch uses public entries, with compaction-aware older-host fallback", () => {
  const h = harness([
    messageEntry("drop", assistant("Compacted away")),
    messageEntry("keep", { role: "user", content: "Kept public text" }, "drop"),
    { id: "compact", parentId: "keep", type: "compaction", firstKeptEntryId: "keep", summary: "Not a transcript message" },
    messageEntry("after", assistant("After compaction"), "compact"),
    { id: "edit", parentId: "after", type: "context_edit", targetId: "keep", replacement: null },
  ]);
  Object.defineProperty(h.ctx.sessionManager, "buildContextEntries", { value: undefined });
  h.producer.start(h.ctx);
  assert.deepEqual(h.snapshot().map(row => row.text), ["Kept public text", "After compaction"]);
  // context_edit is for model context, not a reason to hide terminal history.
  const invalid = { sessionManager: { getLeafId() { throw new Error("Stale context"); } } } as unknown as ExtensionContext;
  assert.equal(h.producer.reconcile(invalid, true), false);
  assert.deepEqual(h.producer.snapshot(undefined), []);
});

test("effective renderer delegates once with identical component/context/state and compact-only capture", () => {
  const h = harness();
  h.producer.start(h.ctx);
  h.producer.toolStart("tool");
  const view = component(["compact title"]), prior = component(["previous"]);
  const context = renderContext("tool");
  context.lastComponent = prior;
  const state = context.state, invalidate = context.invalidate;
  const args = {}, theme = {}, receiver = {};
  let calls = 0;
  const decorated = h.resolve({ renderShell: "self", renderCall: function (this: unknown, input, palette, actual) {
    calls++;
    assert.equal(this, receiver);
    assert.equal(input, args);
    assert.equal(palette, theme);
    assert.equal(actual, context);
    assert.equal(actual.lastComponent, prior);
    assert.equal(actual.state, state);
    assert.equal(actual.invalidate, invalidate);
    actual.state.seen = true;
    return view;
  } })!;
  assert.equal(decorated.renderShell, "self");
  assert.equal(decorated.renderCall!.call(receiver, args, theme as never, context), view);
  assert.equal(view.renders, 0);
  assert.equal(view.render(72), view.lines);
  assert.equal(view.renders, 1);
  assert.equal(calls, 1);
  assert.equal(view.invalidations, 0);
  assert.equal(context.state, state);
  assert.equal(context.state.seen, true);
  assert.equal(context.lastComponent, prior);
  assert.equal(context.invalidate, invalidate);
  assert.equal(h.snapshot()[0]!.text, "compact title");
  context.expanded = true;
  decorated.renderCall!.call(receiver, args, theme as never, context);
  view.lines = ["expanded secrets"];
  view.render(72);
  assert.equal(view.renders, 2);
  assert.equal(h.snapshot()[0]!.text, "compact title");
});

test("call/result coalesce, retain title plus recent result tail and never duplicate persisted/live tool IDs", () => {
  const h = harness();
  h.producer.start(h.ctx);
  const live = { role: "assistant", timestamp: 1, content: [text("Prose"), { type: "toolCall", id: "tool", arguments: { secret: "RAW" } }] };
  h.producer.messageStart(h.ctx, live);
  const call = captureCall(h, "tool", ["read public-path", "c".repeat(3000)]);
  const toolId = h.snapshot().find(row => row.role === "tool")!.id;
  const result = component(["old result ".repeat(400), "\n  newest result 😀"]);
  const renderers = h.resolve({ renderResult: () => result })!;
  renderers.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, {} as never, renderContext("tool"));
  result.render(80);
  let block = h.snapshot().find(row => row.role === "tool")!;
  assert.equal(block.id, toolId);
  assert.ok(block.text.startsWith("read public-path\n"));
  assert.ok(block.text.endsWith("\n  newest result 😀"));
  assert.ok(Buffer.byteLength(block.text) <= LIVE_HUD_MAX_TRANSCRIPT_TEXT);
  h.producer.messageEnd(h.ctx, { ...live, timestamp: 5 });
  h.replace([messageEntry("final", { ...live, timestamp: 9 })]);
  h.producer.toolStart("tool");
  assert.equal(h.snapshot().filter(row => row.role === "tool").length, 1);
  assert.equal(h.snapshot().find(row => row.role === "tool")!.id, toolId);
  // Result options expanded=true must suppress capture even if context disagrees.
  renderers.renderResult!({ content: [], details: undefined }, { expanded: true, isPartial: false }, {} as never, renderContext("tool"));
  result.lines = ["expanded-only"];
  result.render(80);
  block = h.snapshot().find(row => row.role === "tool")!;
  assert.doesNotMatch(block.text, /expanded-only|RAW/);
  assert.equal(call.renders, 1);
});

test("self-renderer reused for call/result has no nested duplicate and no raw/native fallback", () => {
  const h = harness();
  h.producer.start(h.ctx);
  h.producer.toolStart("parent");
  h.producer.toolStart("child", "parent");
  captureCall(h, "child", ["Child preview must not appear"]);
  assert.equal(h.resolve(), undefined);
  assert.deepEqual(h.resolve({ renderShell: "default" }), { renderShell: "default" });
  const shared = component(["One self-rendered preview"]);
  const renderers = h.resolve({ renderCall: () => shared, renderResult: () => shared })!;
  renderers.renderCall!({}, {} as never, renderContext("parent"));
  shared.render(80);
  renderers.renderResult!({ content: [text("RAW fallback")], details: undefined }, { expanded: false, isPartial: false }, {} as never, renderContext("parent"));
  shared.render(80);
  assert.deepEqual(h.snapshot().map(row => row.text), ["One self-rendered preview"]);
  const withoutHook = createWebcamTranscript({} as ExtensionAPI);
  withoutHook.start(h.ctx);
  withoutHook.toolStart("unsupported");
  assert.deepEqual(withoutHook.snapshot(h.ctx), []);
});

test("branch/reset/stop clear old capture pointers, new epochs and bounded snapshots are detached", () => {
  const h = harness();
  h.producer.start(h.ctx);
  h.producer.toolStart("same-id");
  const old = captureCall(h, "same-id", ["old branch"]);
  h.replace([messageEntry("new-branch", { role: "user", content: "New branch" })]);
  h.producer.reset(h.ctx);
  h.producer.toolStart("same-id");
  old.lines = ["Old pointer must stay inert"];
  old.render(80);
  assert.deepEqual(h.snapshot().map(row => row.text), ["New branch"]);
  captureCall(h, "same-id", ["new tool"]);
  const published = h.snapshot();
  published[0]!.text = "Externally mutated";
  assert.equal(h.snapshot()[0]!.text, "New branch");
  h.producer.stop();
  const reads = h.reads;
  old.render(80);
  h.producer.messageStart(h.ctx, assistant("Stopped"));
  h.producer.reconcile(h.ctx, true);
  assert.deepEqual(h.snapshot(), []);
  assert.equal(h.reads, reads);
  h.replace(Array.from({ length: 30 }, (_, index) => messageEntry(`entry-${index}`, assistant("😀".repeat(1000) + `\nTail ${index}`))));
  h.producer.start(h.ctx);
  const bounded = h.snapshot();
  assert.equal(bounded.length, LIVE_HUD_MAX_TRANSCRIPT_BLOCKS);
  assert.equal(new Set(bounded.map(row => row.id)).size, bounded.length);
  assert.ok(bounded.every(row => Buffer.byteLength(row.text) <= LIVE_HUD_MAX_TRANSCRIPT_TEXT));
  assert.ok(bounded.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0) <= LIVE_HUD_MAX_TRANSCRIPT_BYTES);
  assert.ok(bounded.at(-1)!.text.endsWith("Tail 29"));
  old.render(80);
  assert.deepEqual(h.snapshot(), bounded);
});

test("sanitization strips terminal strings/images/controls and redacts whole input BEFORE UTF-8 tail clipping", () => {
  assert.equal(sanitizeTranscriptText("\x1b[31mred\x1b[0m\n\n\t  code 😀\r\nnext\u202e\ud800"), "red\n\n\t  code 😀\nnext");
  for (const command of ["\x1b]1337;File=hidden\x07", "\x1b]8;;https://hidden\x1b\\", "\x1bPqhidden\x1b\\",
    "\x1b_Ghidden\x1b\\", "\x1b^hidden\x1b\\", "\x1bXhidden\x1b\\", "\u009dhidden\u009c", "\u0090hidden\u009c"]) {
    assert.equal(sanitizeTranscriptText(`before${command}after`), "beforeafter");
  }
  for (const command of ["\x1b]hidden", "\x1bPhidden", "\x1b_hidden"]) {
    assert.equal(sanitizeTranscriptText(`visible${command}`), "visible");
  }
  const credentials = ["Bearer abcdefghijklmnop", "Basic dXNlcjpwYXNz", "sk-abcdefghijklmnop", "ghp_abcdefghijklmnop1234",
    "github_pat_abcdefghijklmnop1234", "xoxb-abcdefghijklmnop", "AKIAABCDEFGHIJKLMNOP", "eyJabc.def.ghi",
    "API_KEY=super-private", 'password="super private"', "https://user:password@example.test"];
  for (const credential of credentials) {
    const clean = sanitizeTranscriptText(credential);
    assert.match(clean, /redacted/);
    assert.notEqual(clean, credential);
  }
  assert.equal(sanitizeTranscriptText("password=" + "s".repeat(4000) + "\nNewest words"), "password=[redacted]\nNewest words");
  assert.equal(sanitizeTranscriptText("-----BEGIN PRIVATE KEY-----\n" + "s".repeat(4000) + "\n-----END PRIVATE KEY-----\nNewest"), "[redacted private key]\nNewest");
  assert.equal(sanitizeTranscriptText("prefix😀名", 6), "名");
  assert.equal(sanitizeTranscriptText("prefix😀名", 7), "😀名");
  assert.equal(sanitizeTranscriptText("x".repeat(3000) + "\n\n  newest words", 32).endsWith("\n\n  newest words"), true);
  const indented = "paragraph\n\n\t  indented code\nnext";
  assert.equal(sanitizeTranscriptText(indented), indented);
  const hugeWhitespaceTail = "visible" + " ".repeat(LIVE_HUD_MAX_TRANSCRIPT_TEXT + 1);
  assert.equal(sanitizeTranscriptText(hugeWhitespaceTail), "");
  const whitespace = harness([messageEntry("whitespace", { role: "user", content: [text(hugeWhitespaceTail)] })]);
  whitespace.producer.start(whitespace.ctx);
  assert.deepEqual(whitespace.snapshot(), []);
  assert.equal(sanitizeTranscriptText("😀", 3), "");
  assert.equal(sanitizeTranscriptText({ toString() { throw new Error("Do not serialize objects"); } }), "");
  assert.equal(sanitizeTranscriptText(" \n\t "), "");
});
