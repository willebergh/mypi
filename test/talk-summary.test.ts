import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getTalkSummaryFailure, summarizeTalkContext, TalkSummaryError, type TalkSummaryErrorCode } from "../extensions/talk/summary.ts";
import { SummaryProcessError } from "../extensions/talk/summary-process.ts";

let session = 0;
const signal = () => new AbortController().signal;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function entry(id: string, parentId: string | null, data: object): SessionEntry {
  return { id, parentId, timestamp: "2026-01-01T00:00:00Z", ...data } as SessionEntry;
}
function message(id: string, parentId: string | null, role: string, content: unknown) {
  return entry(id, parentId, { type: "message", message: { role, content, timestamp: 1 } });
}
function fixture(entries = [message("u", null, "user", "Build voice continuity")]) {
  const state = { entries, leaf: entries.at(-1)?.id ?? null, id: `summary-test-${++session}` };
  const requests: { history: string; signal: AbortSignal; cwd: string }[] = [];
  const forbidden: PropertyKey[] = [];
  let response = async (): Promise<string> => "Goal: voice continuity. Current state: testing.";
  const ctx = new Proxy({
    cwd: "/fake/project",
    sessionManager: {
      getEntries: () => state.entries,
      getLeafId: () => state.leaf,
      getSessionId: () => state.id,
    },
  }, {
    get(target, key, receiver) {
      if (key !== "sessionManager" && key !== "cwd") {
        forbidden.push(key);
        throw new Error("No provider, auth, UI, or transcript access allowed");
      }
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as ExtensionContext;
  const runner = (history: string, childSignal: AbortSignal, cwd: string) => {
    requests.push({ history, signal: childSignal, cwd });
    return response();
  };
  return {
    ctx, state, requests, forbidden, runner,
    run: (callerSignal = signal()) => summarizeTalkContext(ctx, callerSignal, runner),
    response(value: typeof response) { response = value; },
    output(value: string) { response = async () => value; },
  };
}
function failure(code: TalkSummaryErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof TalkSummaryError);
    assert.equal(error.code, code);
    assert.equal(getTalkSummaryFailure(error), error.message);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack ?? "", /secret|private-credential|Bearer/);
    assert.doesNotMatch(JSON.stringify(error), /secret|private-credential|Bearer/);
    return true;
  };
}
const input = (f: ReturnType<typeof fixture>) => f.requests.at(-1)!.history;

test("SDK-version independent: only history, child signal and cwd reach runner; modelRegistry is NEVER touched", async () => {
  const f = fixture();
  const caller = signal();
  const summary = await f.run(caller);
  assert.match(summary!, /Goal: voice continuity/);
  assert.equal(input(f), "[user]: Build voice continuity");
  assert.equal(f.requests[0].cwd, "/fake/project");
  assert.ok(f.requests[0].signal instanceof AbortSignal);
  assert.notEqual(f.requests[0].signal, caller);
  assert.equal(await f.run(), summary);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.forbidden, []);
  // CLI flags, prompt and tool policy belong to summary-process.test.ts, not SDK context IR.
});

test("only user/assistant text is extracted, never thinking, raw tools or hidden content", async () => {
  const f = fixture([
    message("u", null, "user", [{ type: "text", text: "user fact" }, { type: "image", data: "image-secret" }]),
    message("a", "u", "assistant", [
      { type: "text", text: "assistant fact" }, { type: "thinking", thinking: "hidden-secret" },
      { type: "toolCall", name: "bash", arguments: { secret: "argument-secret" } },
      { type: "providerCompaction", text: "opaque-secret" },
    ]),
    message("t", "a", "toolResult", [{ type: "text", text: "tool-secret" }]),
    message("s", "t", "system", "system-secret"),
    message("b", "s", "bashExecution", "bash-secret"),
    entry("c", "b", { type: "custom_message", customType: "test", content: "custom-secret", display: true }),
  ]);
  const before = structuredClone(f.state.entries);
  f.output("Only summary");
  assert.equal(await f.run(), "Only summary");
  assert.equal(input(f), "[user]: user fact\n\n[assistant]: assistant fact");
  assert.deepEqual(f.state.entries, before);
  assert.deepEqual(f.forbidden, []);
});

test("includes only talk-history custom context messages with their labeled text", async () => {
  const f = fixture([
    message("u", null, "user", "Build voice continuity"),
    entry("history", "u", { type: "custom_message", customType: "talk-history", content: "[source: mic] [speaker: Alex] Keep the spoken preference", display: true }),
    entry("note", "history", { type: "custom_message", customType: "extension-note", content: "private extension note", display: true }),
    message("tool", "note", "toolResult", [{ type: "text", text: "raw tool output" }]),
  ]);
  f.output("Summary");
  assert.equal(await f.run(), "Summary");
  assert.equal(input(f), "[user]: Build voice continuity\n\n[voiceTranscript]: [source: mic] [speaker: Alex] Keep the spoken preference");
  assert.deepEqual(f.forbidden, []);
});

test("selected branch honors compaction, branch summaries and context edits", async () => {
  const f = fixture([
    message("old", null, "user", "old discarded history"),
    message("keep", "old", "user", "retained request"),
    entry("compact", "keep", { type: "compaction", summary: "Prior goal and decisions", firstKeptEntryId: "keep", tokensBefore: 5000 }),
    message("other", "compact", "user", "unselected branch"),
    entry("branch", "compact", { type: "branch_summary", summary: "Explored an alternative", fromId: "other" }),
    message("now", "branch", "assistant", [{ type: "text", text: "obsolete text" }]),
    entry("edit", "now", { type: "context_edit", targetId: "now", replacement: { content: "current visible state" } }),
  ]);
  await f.run();
  for (const value of ["Prior goal and decisions", "retained request", "Explored an alternative", "current visible state"]) assert.ok(input(f).includes(value));
  for (const value of ["old discarded", "unselected branch", "obsolete text"]) assert.ok(!input(f).includes(value));
});

test("opaque provider compaction and its system items are omitted without mutation", async () => {
  for (const strategy of ["openai-responses-compaction-v2", "openai-native-compact-v1"]) {
    const f = fixture([
      message("old", null, "user", "discarded"),
      entry("compact", "old", { type: "compaction", summary: "opaque placeholder", firstKeptEntryId: "none", tokensBefore: 50,
        details: { strategy, encrypted_content: "ciphertext" }, systemMessage: { role: "system", content: "opaque system item" } }),
      message("new", "compact", "user", "readable latest"),
    ]);
    const before = structuredClone(f.state.entries);
    await f.run();
    assert.equal(input(f), "[user]: readable latest");
    assert.deepEqual(f.state.entries, before);
  }
});

test("empty or tool-only history returns undefined without runner calls", async () => {
  for (const entries of [[], [message("t", null, "toolResult", [{ type: "text", text: "result" }])]]) {
    const f = fixture(entries);
    assert.equal(await f.run(), undefined);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.forbidden, []);
  }
});

test("recent input stays within 32 KiB and output within 3 KiB without cutting Unicode", async () => {
  const f = fixture([message("u", null, "user", "oldest " + "😀界é".repeat(10000) + " latest goal")]);
  f.output("😀界é".repeat(2000));
  const result = await f.run();
  assert.ok(Buffer.byteLength(input(f)) <= 32768);
  assert.match(input(f), /^\[Older context omitted\]/);
  assert.ok(input(f).endsWith("latest goal"));
  assert.ok(Buffer.byteLength(result!) <= 3072);
  assert.ok(!input(f).includes("\uFFFD"));
  assert.ok(!result!.includes("\uFFFD"));
  assert.equal(result, Buffer.from(result!).toString("utf8"));
  const broken = fixture([message("u", null, "user", "bad \uD800")]);
  broken.output("bad \uDC00");
  assert.equal(await broken.run(), "bad \uFFFD");
  assert.equal(input(broken), "[user]: bad \uFFFD");
});

test("absolute fifteen-second deadline bounds an uncooperative runner and refuses late cache writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  const completion = deferred<string>();
  f.response(() => completion.promise);
  const rejected = assert.rejects(f.run(), failure("timeout"));
  await flush();
  t.mock.timers.tick(14999);
  assert.equal(f.requests[0].signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.requests[0].signal.aborted, true);
  completion.resolve("late summary must not cache");
  await flush();
  f.output("fresh");
  assert.equal(await f.run(), "fresh");
  assert.equal(f.requests.length, 2);
});

test("never-resolving runner is bounded; full-history latency of 9.3 seconds still succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const stuck = fixture();
  stuck.response(() => new Promise(() => {}));
  const rejected = assert.rejects(stuck.run(), failure("timeout"));
  t.mock.timers.tick(15000);
  await rejected;
  assert.equal(stuck.requests[0].signal.aborted, true);
  const f = fixture();
  const completion = deferred<string>();
  f.response(() => completion.promise);
  const pending = f.run();
  t.mock.timers.tick(9300);
  assert.equal(f.requests[0].signal.aborted, false);
  completion.resolve("Full-history continuity summary");
  assert.equal(await pending, "Full-history continuity summary");
  t.mock.timers.tick(15000);
  assert.equal(f.requests.length, 1);
});

test("caller abort settles immediately, aborts child quickly, and refuses late cache writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  const completion = deferred<string>();
  f.response(() => completion.promise);
  const controller = new AbortController();
  const rejected = assert.rejects(f.run(controller.signal), failure("cancelled"));
  controller.abort(new Error("secret abort reason"));
  assert.equal(f.requests[0].signal.aborted, true);
  await rejected; // No timer advancement or runner cooperation required.
  completion.resolve("late");
  await flush();
  f.output("fresh");
  assert.equal(await f.run(), "fresh");
  assert.equal(f.requests.length, 2);
  const preaborted = new AbortController(); preaborted.abort();
  await assert.rejects(f.run(preaborted.signal), failure("cancelled"));
  assert.equal(f.requests.length, 2);
});

test("process failures map by code, never accept partial text, and are never cached", async () => {
  for (const code of ["cli_unavailable", "provider_error", "output_limit", "cancelled"] as const) {
    const f = fixture();
    f.response(async () => { throw new SummaryProcessError(code); });
    await assert.rejects(f.run(), failure(code));
    await assert.rejects(f.run(), failure(code));
    assert.equal(f.requests.length, 2);
    f.output("fresh");
    assert.equal(await f.run(), "fresh");
    assert.deepEqual(f.forbidden, []);
  }
  const empty = fixture(); empty.output(" \n ");
  await assert.rejects(empty.run(), failure("empty_response"));
});

test("runner failures retain only safe classified diagnostics, with no SDK provider stage or retries", async () => {
  const cases = [
    { error: new TypeError("fetch failed Bearer private-credential", { cause: { code: "ENOTFOUND", message: "secret host" } }), reason: "dns" },
    { error: { status: 403, message: "private-credential" }, reason: "forbidden" },
    { error: new SummaryProcessError("provider_error", "rate_limited"), reason: "rate_limited" },
    { error: new Error("secret normalizeContext estimateMessageTokens failure"), reason: undefined },
    { error: { get message() { throw new Error("must not read"); } }, reason: undefined },
  ] as const;
  for (const { error, reason } of cases) {
    const f = fixture();
    f.response(async () => { throw error; });
    await assert.rejects(f.run(), (caught: unknown) => {
      assert.ok(caught instanceof TalkSummaryError);
      assert.equal(caught.code, "provider_error");
      assert.equal(caught.requestFailure, reason);
      assert.match(getTalkSummaryFailure(caught), /^Pi summary command failed for openai-codex\/gpt-6-luna\./);
      assert.doesNotMatch(getTalkSummaryFailure(caught), /secret|private-credential|Bearer|HTTP request/);
      caught.message = "private-credential";
      assert.doesNotMatch(getTalkSummaryFailure(caught), /private-credential/);
      return true;
    });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.forbidden, []);
  }
});

test("cache identity includes session, leaf and serialized input; changed revisions are not cached", async () => {
  const f = fixture();
  const output = deferred<string>();
  f.response(() => output.promise);
  const pending = f.run();
  f.state.entries.push(message("new", "u", "user", "new revision"));
  f.state.leaf = "new";
  output.resolve("snapshot summary");
  assert.equal(await pending, "snapshot summary");
  f.state.leaf = "u";
  f.output("fresh");
  await f.run();
  assert.equal(f.requests.length, 2);
  await f.run();
  assert.equal(f.requests.length, 2);
  f.state.entries[0] = message("u", null, "user", "edited in place");
  await f.run();
  assert.equal(f.requests.length, 3);
  f.state.id += "-another-session";
  await f.run();
  assert.equal(f.requests.length, 4);
});

test("safe failure accessor never reveals arbitrary messages or reads unknown error properties", () => {
  for (const error of [new Error("secret"), { message: "secret", code: "provider_error" }, "secret", null,
    { get message() { throw new Error("must not read"); } }]) {
    assert.equal(getTalkSummaryFailure(error), "unknown summary error");
  }
  const known = new TalkSummaryError("timeout");
  assert.match(known.message, /openai-codex\/gpt-6-luna/);
  known.message = "secret mutation";
  assert.doesNotMatch(getTalkSummaryFailure(known), /secret/);
});

test("all snapshot reads, before cache hits and after completion, classify as context_read", async () => {
  for (const method of ["getEntries", "getLeafId", "getSessionId"] as const) {
    for (const phase of ["initial", "cached", "post-request"]) {
      const f = fixture();
      if (phase === "cached") await f.run();
      const manager = f.ctx.sessionManager;
      const original = manager[method];
      const fail = () => { throw new Error("secret context read"); };
      if (phase === "post-request") f.response(async () => {
        manager[method] = fail;
        return "not cached";
      });
      else manager[method] = fail;
      await assert.rejects(f.run(), failure("context_read"));
      manager[method] = original as any;
      f.output("fresh");
      await f.run();
      assert.equal(f.requests.length, phase === "cached" ? 1 : phase === "post-request" ? 2 : 1);
    }
  }
});

test("abort-aware runner cannot turn deadline timeouts into cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const cause of ["deadline", "external", "runner"]) {
    const f = fixture();
    const controller = new AbortController();
    f.response(() => {
      if (cause === "runner") return Promise.reject(new SummaryProcessError("cancelled"));
      return new Promise((_resolve, reject) => f.requests[0].signal.addEventListener("abort", () => reject(new SummaryProcessError("cancelled")), { once: true }));
    });
    const rejected = assert.rejects(f.run(controller.signal), failure(cause === "deadline" ? "timeout" : "cancelled"));
    if (cause === "deadline") t.mock.timers.tick(15000);
    if (cause === "external") controller.abort("secret reason");
    await rejected;
  }
});

test("runner errors and stderr are neither displayed nor logged raw", async (t) => {
  const logs: unknown[][] = [];
  for (const method of ["log", "warn", "error", "debug", "info"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }
  const f = fixture();
  f.response(async () => { throw { message: "secret private-credential Bearer upstream body", stderr: "secret raw stderr" }; });
  await assert.rejects(f.run(), failure("provider_error"));
  assert.deepEqual(logs, []);
});

test("summary cache retains at most eight snapshots", async () => {
  const fixtures = Array.from({ length: 9 }, () => fixture());
  for (const f of fixtures) await f.run();
  await fixtures[8].run();
  assert.equal(fixtures[8].requests.length, 1);
  await fixtures[0].run();
  assert.equal(fixtures[0].requests.length, 2);
});
