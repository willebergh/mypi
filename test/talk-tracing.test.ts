import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTalk } from "../extensions/talk/index.ts";
import type { TalkTraceSink } from "../extensions/talk/trace.ts";

test("/talk log is lazy, snapshots the original startup, and controls dynamic trace sinks", async (t) => {
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const handlers = new Map<string, ((...args: any[]) => unknown)[]>();
  const events: any[] = [];
  const notices: [string, string][] = [];
  const statuses: [string, string | undefined][] = [];
  let enabled = false;
  let dropped = 0;
  let enableFailure = false;
  let openArgs: unknown[] = [];
  let opens = 0;
  let resets = 0;
  let generation = 0;
  const rows: { callId: string; direction: string; event: any }[] = [];
  const sinks: TalkTraceSink[] = [];
  const trace = {
    async enable() { if (enableFailure) return; enabled = true; },
    async disable() { enabled = false; },
    async reset() { resets++; generation++; rows.length = 0; },
    status() { return { enabled, path: "/private/agent/logs/talk/events.jsonl", dropped }; },
    session(id: string) {
      const current = generation;
      const sink: TalkTraceSink = {
        addSecrets() {},
        record(direction, event) { if (enabled && current === generation) rows.push({ callId: id, direction, event }); },
      };
      sinks.push(sink);
      return sink;
    },
  };
  let tracePath = "";
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerMessageRenderer() {},
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    events: { emit(name: string, value: unknown) { events.push([name, value]); }, on() { return () => {}; } },
    appendEntry() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", cwd: "/project", model: { provider: "test", id: "model" }, isIdle: () => true,
    sessionManager: { getSessionId: () => "session" },
    modelRegistry: { getApiKeyForProvider: async () => "fake-token" },
    ui: {
      notify(message: string, level: string) { notices.push([message, level]); },
      setStatus(key: string, value: string | undefined) { statuses.push([key, value]); },
      setWidget() {},
    },
  } as unknown as ExtensionContext;
  registerTalk(pi, {
    audioMode: "native", modelName: "fake-live", loadAudioDevices: async () => ({}),
    createTrace(options: any) { tracePath = options.path; return trace as any; },
    summarizeContext: async () => undefined,
    async openLive(...args: unknown[]) {
      opens++;
      openArgs = args;
      const sink = args[4] as TalkTraceSink;
      // Mirrors Codex transport recording the outbound create event during connect.
      sink.record("out", { type: "codex.call.create", session: { initial_items: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "actual startup context" }] },
      ] } });
      return { append() {}, commentary() {}, thinking() {}, async close() { return { confirmed: true }; } };
    },
    startRecorder: (() => { throw new Error("native audio must not start a recorder"); }) as any,
    startPlayer: (() => { throw new Error("native audio must not start a player"); }) as any,
  } as any);
  const command = (args = "") => commands.get("talk")!.handler(args, ctx);
  t.after(async () => { await command("stop"); await handlers.get("session_shutdown")?.[0]?.({}, ctx); });

  assert.match(tracePath, /logs\/talk\/events\.jsonl$/);
  assert.equal(enabled, false);
  await command("log status");
  assert.match(notices.at(-1)![0], /Talk logging: off[\s\S]*Dropped events: 0/);
  assert.equal(opens, 0);
  assert.equal(rows.length, 0);

  await command();
  assert.equal(opens, 1);
  assert.equal(resets, 1);
  assert.equal(openArgs.length, 7);
  assert.deepEqual(openArgs[5], {}, "native audio defaults are passed separately from the trace sink");
  assert.equal(openArgs[6], true, "regular Talk starts with audio enabled");
  assert.equal(rows.length, 0, "connect-time event is not retained while logging is off");
  await command("log on");
  assert.equal(rows.at(-1)?.event.type, "trace.session_snapshot");
  assert.equal(rows.at(-1)?.event.startup.session.initial_items[0].content[0].text, "actual startup context");
  assert.equal(rows.at(-1)?.direction, "local");
  assert.equal(opens, 1, "enabling trace must not reconnect");
  assert.equal(JSON.stringify(rows).includes("authorization"), false);
  const firstCallId = rows.at(-1)!.callId;
  await command("start");
  assert.equal(resets, 1, "a rejected duplicate start does not erase the active call's trace");
  await command("stop");

  await command();
  assert.equal(resets, 2);
  assert.notEqual(sinks.at(-1), sinks.at(-2));
  assert.notEqual(rows.at(-1)?.callId, firstCallId);
  assert.ok(rows.every((row) => row.callId !== firstCallId), "new call resets the preceding trace before startup");
  assert.equal(rows[0].event.type, "talk.starting");
  assert.equal(rows.at(-1)?.event.type, "talk.active");
  await command("log off");
  const count = rows.length;
  assert.equal(enabled, false);
  await command("stop");
  assert.equal(rows.length, count, "active call writes nothing after trace disable");

  await command("log on");
  await command();
  const secondCallId = (openArgs[4] as TalkTraceSink);
  assert.ok(secondCallId);
  await command("stop");
  await command("log off");
  await handlers.get("session_shutdown")?.[0]?.({}, ctx);
  assert.equal(enabled, false);
  await command("log status");
  assert.match(notices.at(-1)![0], /Talk logging: off/);
});

test("invalid log actions and logging failure do not change voice behavior", async () => {
  const commands = new Map<string, any>();
  const notices: [string, string][] = [];
  const statuses: [string, string | undefined][] = [];
  let enabled = false;
  let failEnable = true;
  let opens = 0;
  const trace = { async enable() { if (!failEnable) enabled = true; }, async disable() { enabled = false; }, async reset() {}, status() { return { enabled, path: "/private/path", dropped: 3 }; }, session() { return { record() {}, addSecrets() {} }; } };
  const pi = { registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, on() {}, events: { emit() {}, on() {} }, appendEntry() {}, sendUserMessage() {} } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => "token" }, sessionManager: { getSessionId: () => "s" }, model: { provider: "p", id: "m" }, isIdle: () => true,
    ui: { notify(message: string, level: string) { notices.push([message, level]); }, setStatus(key: string, value: string | undefined) { statuses.push([key, value]); }, setWidget() {} } } as unknown as ExtensionContext;
  registerTalk(pi, { audioMode: "native", loadAudioDevices: async () => ({}), createTrace: () => trace, summarizeContext: async () => undefined,
    async openLive() { opens++; return { append() {}, commentary() {}, thinking() {}, async close() { return { confirmed: true }; } }; },
    startRecorder: (() => { throw Error("must not record"); }) as any, startPlayer: (() => { throw Error("must not play"); }) as any } as any);
  const command = (args: string) => commands.get("talk").handler(args, ctx);
  await command("log maybe");
  assert.match(notices.at(-1)![0], /Usage/);
  await command("log status");
  assert.match(notices.at(-1)![0], /Dropped events: 3/);
  // Native audio starts no local microphone/speaker helpers.
  await command("log on");
  assert.equal(enabled, false);
  assert.match(notices.at(-1)![0], /Could not enable Talk logging/);
  assert.match(notices.at(-1)![0], /Voice is unchanged/);
  await command("");
  assert.equal(opens, 1);
  await command("stop");
});
