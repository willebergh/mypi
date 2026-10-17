import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { openLive, type LiveCallbacks, type SocketFactory } from "../extensions/talk/live.ts";

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  terminated = false;
  sendError = false;
  callbackError = false;
  send(data: string, callback: (error?: Error) => void) {
    if (this.sendError) throw new Error("secret");
    this.sent.push(JSON.parse(data));
    callback(this.callbackError ? new Error("secret") : undefined);
  }
  terminate() { this.terminated = true; this.emit("close", 1006, Buffer.from("secret")); }
  event(type: string, fields = {}) { this.emit("message", Buffer.from(JSON.stringify({ type, ...fields }))); }
}
function setup(controller = new AbortController(), overrides: Partial<LiveCallbacks> = {}) {
  const socket = new FakeSocket();
  const errors: Error[] = [], closed: Parameters<LiveCallbacks["onClosed"]>[0][] = [];
  const audio: Buffer[] = [], transcripts: unknown[][] = [], delegations: unknown[][] = [];
  let connection: unknown[] = [];
  const factory: SocketFactory = (url, options) => {
    connection = [url, options];
    return socket as unknown as ReturnType<SocketFactory>;
  };
  const opening = openLive({ Authorization: "Bearer secret" }, controller.signal, {
    onAudio: (pcm) => audio.push(pcm),
    onTranscript: (...args) => transcripts.push(args),
    onDelegation: (...args) => delegations.push(args),
    onError: (error) => errors.push(error), onClosed: (info) => closed.push(info), ...overrides,
  }, factory);
  return { socket, errors, closed, audio, transcripts, delegations, connection, opening, controller,
    async ready() { socket.emit("open"); socket.event("session.started"); return opening; },
  };
}
function confirm(socket: FakeSocket) {
  socket.event("session.closed", { usage: { seconds: 12.5 }, reason: "close_requested" });
}

test("uses exact endpoint, external headers and startup config; waits for session.started only", async () => {
  const h = setup();
  let ready = false;
  void h.opening.then(() => { ready = true; });
  h.socket.event("session.started"); // Cannot acknowledge before our start.
  h.socket.emit("open");
  h.socket.emit("open");
  h.socket.event("session.updated");
  await Promise.resolve();
  assert.equal(ready, false);
  assert.deepEqual(h.connection, ["wss://api.openai.com/v1/live/sessions", {
    headers: { Authorization: "Bearer secret" }, maxPayload: 256 * 1024,
  }]);
  assert.equal(h.socket.sent.length, 1);
  const start = h.socket.sent[0];
  assert.equal(start.type, "session.start");
  assert.deepEqual(start.session, {
    model: "gpt-live-1", instructions: start.session.instructions,
    audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
    delegation: { type: "client" }, store: false,
  });
  assert.match(start.session.instructions, /English or Swedish/);
  assert.match(start.session.instructions, /Delegate all project and tool requests to the Pi backend/);
  assert.match(start.session.instructions, /Never claim.*before verified/);
  h.socket.event("session.started");
  const session = await h.opening;
  const closing = session.close();
  confirm(h.socket);
  await closing;
});

test("startup rejections expose redacted service diagnostics once", async () => {
  const h = setup();
  h.socket.emit("open");
  const rejected = assert.rejects(h.opening, /invalid_value.*startup.*session.model.*not supported/);
  h.socket.event("error", { error: {
    code: "invalid_value", type: "invalid_request_error", param: "session.model",
    message: "The model is not supported for Bearer secret.",
  } });
  await rejected;
  assert.equal(h.errors.length, 1);
  assert.doesNotMatch(h.errors[0].message, /secret/);
  assert.equal(h.closed.length, 1);
  assert.equal(h.socket.terminated, true);
});

test("PCM16 carries odd bytes across appends without padding or mutation", async () => {
  const h = setup(), session = await h.ready();
  const first = Buffer.from([1]);
  session.append(first);
  first[0] = 99;
  session.append(Buffer.alloc(0));
  session.append(Buffer.from([2, 3, 4, 5]));
  session.append(Buffer.from([6, 7]));
  assert.deepEqual(h.socket.sent.slice(1), [
    { type: "session.input_audio.append", audio: Buffer.from([1, 2, 3, 4]).toString("base64") },
    { type: "session.input_audio.append", audio: Buffer.from([5, 6]).toString("base64") },
  ]);
  const closing = session.close();
  session.append(Buffer.from([8]));
  assert.equal(h.socket.sent.at(-1)?.type, "session.close");
  confirm(h.socket);
  await closing;
});

test("forwards audio, both timed transcript roles, and taskless client delegations", async () => {
  const h = setup(), session = await h.ready();
  h.socket.event("session.output_audio.delta", { delta: Buffer.from([1, 2]).toString("base64") });
  for (const role of ["input", "output"]) {
    h.socket.event(`session.${role}_transcript.delta`, { delta: "Hej å", start_ms: 0, end_ms: 120.5 });
  }
  h.socket.event("session.delegation.created", { offset_ms: 120, delegation: { id: "del_1", target: "client" } });
  h.socket.event("session.delegation.created", { offset_ms: 120, delegation: { id: "del_1", target: "client" } });
  h.socket.event("session.delegation.created", { offset_ms: 120, delegation: { id: "ignored", target: "responses" } });
  assert.deepEqual(h.audio, [Buffer.from([1, 2])]);
  assert.deepEqual(h.transcripts, [["user", "Hej å", 0, 120.5], ["assistant", "Hej å", 0, 120.5]]);
  assert.deepEqual(h.delegations, [["del_1", 120], ["del_1", 120]]);
  confirm(h.socket);
  assert.deepEqual(await session.close(), { confirmed: true, seconds: 12.5, reason: "close_requested" });
});

test("public Live does not invent ASR metadata from text, timing or ambiguous ID fields", async () => {
  const h = setup(), session = await h.ready();
  for (const role of ["input", "output"]) {
    for (const id of [undefined, "item_1", "x".repeat(512), "x".repeat(513), "bad\nID", "å", "\ud800"]) {
      h.socket.event(`session.${role}_transcript.delta`, {
        delta: "Yes å😀", start_ms: 12, end_ms: 30,
        id, event_id: "event_1", item_id: id, item: { id }, turn_id: "turn_1",
      });
    }
  }
  assert.deepEqual(h.transcripts, [
    ...Array.from({ length: 7 }, () => ["user", "Yes å😀", 12, 30]),
    ...Array.from({ length: 7 }, () => ["assistant", "Yes å😀", 12, 30]),
  ]);
  assert.deepEqual([h.delegations, h.errors], [[], []]);
  confirm(h.socket);
  await session.close();
});

test("public Live transcript UTF-8 bounds remain enforced without metadata", async () => {
  const h = setup(), session = await h.ready();
  h.socket.event("session.input_transcript.delta", { delta: "😀".repeat(4096), start_ms: 0, end_ms: 1 });
  assert.deepEqual(h.transcripts, [["user", "😀".repeat(4096), 0, 1]]);
  confirm(h.socket);
  await session.close();
});

test("public Live propagates only an actual valid source turn ID", async () => {
  const h = setup(), session = await h.ready();
  h.socket.event("session.delegation.created", { offset_ms: 10, delegation: { id: "d1", target: "client", user_bidi_turn_id: "turn_1" } });
  h.socket.event("session.delegation.created", { offset_ms: 11, delegation: { id: "d2", target: "client" } });
  h.socket.event("session.delegation.created", { offset_ms: 12, delegation: { id: "d3", target: "client", user_bidi_turn_id: "bad.id" } });
  h.socket.event("session.delegation.created", { offset_ms: 13, delegation: { id: "d4", target: "client", user_bidi_turn_id: "x".repeat(513) } });
  assert.deepEqual(h.delegations.map((args) => [args[0], args[3]]), [
    ["d1", { userTurnId: "turn_1" }], ["d2", undefined], ["d3", undefined], ["d4", undefined],
  ]);
  assert.deepEqual(h.errors, []);
  confirm(h.socket);
  await session.close();
});

test("commentary/thinking use unique UUIDs, nullable IDs and a strict UTF-8 budget", async () => {
  const h = setup(), session = await h.ready();
  session.commentary("del_1", "å".repeat(225));
  session.thinking(null, "😀".repeat(112));
  for (const content of ["å".repeat(226), "x".repeat(451), "\ud800"]) {
    assert.throws(() => session.commentary(null, content), /450 bytes/);
    assert.throws(() => session.thinking(null, content), /450 bytes/);
  }
  for (const id of ["", "x".repeat(513), "bad\nID"]) {
    assert.throws(() => session.thinking(id, "ok"), /delegation ID/);
  }
  const events = h.socket.sent.slice(1);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => [e.type, e.delegation_id, Buffer.byteLength(e.content)]), [
    ["session.commentary.append", "del_1", 450], ["session.thinking.append", null, 448],
  ]);
  for (const e of events) assert.match(e.event_id, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.notEqual(events[0].event_id, events[1].event_id);
  confirm(h.socket);
  await session.close();
});

test("close is idempotent and only session.closed confirms finalization", async () => {
  const h = setup(), session = await h.ready();
  const closing = session.close();
  assert.equal(session.close(), closing);
  let settled = false;
  void closing.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  confirm(h.socket);
  const result = await closing;
  assert.deepEqual(result, { confirmed: true, seconds: 12.5, reason: "close_requested" });
  assert.equal(await session.close(), result);
  h.socket.emit("error", new Error("secret"));
  confirm(h.socket);
  h.controller.abort();
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.closed, [result]);
  assert.equal(h.socket.terminated, true);
});

test("setup and close deadlines are separate and cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const starting = setup();
  const rejected = assert.rejects(starting.opening, /setup timed out/);
  t.mock.timers.tick(9_999);
  assert.equal(starting.closed.length, 0);
  t.mock.timers.tick(1);
  await rejected;
  const h = setup(), session = await h.ready();
  t.mock.timers.tick(10_000);
  assert.equal(h.errors.length, 0);
  const closing = session.close();
  t.mock.timers.tick(14_999);
  assert.equal(h.closed.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await closing, { confirmed: false, reason: "Live close timed out" });
  assert.equal(h.socket.terminated, true);
  assert.equal(h.closed.length, 1);
});

for (const cause of ["socket", "abrupt", "remote", "send throw", "send callback", "backlog", "audio size", "json", "event size"]) {
  test(`${cause} safely fails once without credentials`, async () => {
    const h = setup(), session = await h.ready();
    switch (cause) {
      case "socket": h.socket.emit("error", new Error("secret")); break;
      case "abrupt": h.socket.emit("close", 1000, Buffer.from("secret")); break;
      case "remote": h.socket.event("error", { error: { code: "secret", message: "secret" } }); break;
      case "send throw": h.socket.sendError = true; session.append(Buffer.alloc(2)); break;
      case "send callback": h.socket.callbackError = true; session.append(Buffer.alloc(2)); break;
      case "backlog": h.socket.bufferedAmount = 512 * 1024; session.thinking(null, "ok"); break;
      case "audio size": session.append(Buffer.alloc(192 * 1024 + 1)); break;
      case "json": h.socket.emit("message", Buffer.from("[]")); break;
      case "event size": h.socket.emit("message", [Buffer.alloc(256 * 1024), Buffer.alloc(1)]); break;
    }
    assert.equal((await session.close()).confirmed, false);
    h.socket.emit("error", new Error("secret"));
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors[0].message, /secret/);
    assert.equal(h.closed.length, 1);
    assert.equal(h.socket.terminated, true);
  });
}

for (const stage of ["before", "starting", "active", "closing"]) {
  test(`abort during ${stage} settles all operations and removes listener`, async () => {
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    const h = setup(controller);
    if (stage === "before" || stage === "starting") {
      const rejected = assert.rejects(h.opening, /aborted/);
      controller.abort();
      await rejected;
    } else {
      const session = await h.ready();
      const closing = stage === "closing" ? session.close() : undefined;
      controller.abort();
      assert.equal((await (closing ?? session.close())).confirmed, false);
    }
    assert.equal(h.closed.length, 1);
    assert.equal(h.errors.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(h.socket.terminated, stage !== "before");
  });
}

test("setup failures sanitize HTTP status, errors, codes and factory exceptions; never retry", async () => {
  for (const statusCode of [401, 403, 429, "secret"]) {
    const h = setup();
    const rejected = assert.rejects(h.opening, new RegExp(`HTTP ${typeof statusCode === "number" ? statusCode : "unknown"}`));
    let drained = false;
    h.socket.emit("unexpected-response", {}, { statusCode, resume() { drained = true; } });
    await rejected;
    assert.equal(drained, true);
    assert.equal(h.socket.sent.length, 0);
    assert.doesNotMatch(h.errors[0].message, /secret/);
  }
  const h = setup();
  const rejected = assert.rejects(h.opening, /Live service error \(model_not_found\)/);
  h.socket.event("error", { error: { code: "model_not_found", message: "secret" } });
  await rejected;
  assert.equal(h.socket.sent.length, 0);
  await assert.rejects(openLive({}, new AbortController().signal, {
    onAudio() {}, onTranscript() {}, onDelegation() {}, onError() { throw new Error(); }, onClosed() { throw new Error(); },
  }, () => { throw new Error("secret"); }), /^Error: Live connection failed$/);
});

const invalidEvents: [string, object][] = [
  ["session.output_audio.delta", { delta: "!!!!" }],
  ["session.output_audio.delta", { delta: "AQ==" }],
  ["session.output_audio.delta", { delta: "AB==" }],
  ["session.output_audio.delta", { delta: 42 }],
  ["session.input_transcript.delta", { delta: "x", start_ms: -1, end_ms: 0 }],
  ["session.output_transcript.delta", { delta: "x", start_ms: 2, end_ms: 1 }],
  ["session.input_transcript.delta", { delta: "x".repeat(16 * 1024 + 1), start_ms: 0, end_ms: 1 }],
  ["session.input_transcript.delta", { delta: "x", start_ms: null, end_ms: 1 }],
  ["session.input_transcript.delta", { delta: "😀".repeat(4097), start_ms: 0, end_ms: 1, item: { id: "real_item" } }],
  ["session.output_transcript.delta", { delta: "\ud800", start_ms: 0, end_ms: 1, item: { id: "real_item" } }],
  ["session.delegation.created", { offset_ms: 0, delegation: { id: "x".repeat(513), target: "client" } }],
  ["session.delegation.created", { offset_ms: -1, delegation: { id: "d", target: "client" } }],
];
for (const [index, [type, fields]] of invalidEvents.entries()) {
  test(`invalid callback data ${index} fails without forwarding`, async () => {
    const h = setup(), session = await h.ready();
    h.socket.event(type, fields);
    assert.equal((await session.close()).confirmed, false);
    assert.deepEqual([h.audio.length, h.transcripts.length, h.delegations.length], [0, 0, 0]);
  });
}

test("callback exceptions and malformed optional final metadata cannot escape or leak", async () => {
  const boom = () => { throw new Error("consumer"); };
  const h = setup(undefined, { onAudio: boom, onTranscript: boom, onDelegation: boom, onClosed: boom });
  const session = await h.ready();
  h.socket.event("session.output_audio.delta", { delta: "AQI=" });
  h.socket.event("session.input_transcript.delta", { delta: "ok", start_ms: 0, end_ms: 1 });
  h.socket.event("session.delegation.created", { offset_ms: 0, delegation: { id: "d", target: "client" } });
  h.socket.event("session.closed", { usage: { seconds: -1 }, reason: "secret" });
  assert.deepEqual(await session.close(), { confirmed: true });
  assert.equal(h.errors.length, 0);
});
