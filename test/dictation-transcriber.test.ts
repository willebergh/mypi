import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { openTranscriber, type SocketFactory } from "../extensions/dictation/transcriber.ts";

class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  terminated = false;
  sendError = false;
  callbackError = false;
  send(data: string, callback: (error?: Error) => void) {
    if (this.sendError) throw new Error("secret credentials");
    this.sent.push(JSON.parse(data));
    callback(this.callbackError ? new Error("secret credentials") : undefined);
  }
  terminate() { this.terminated = true; this.emit("close"); }
  event(type: string, fields = {}) {
    this.emit("message", Buffer.from(JSON.stringify({ type, ...fields })));
  }
}

function setup(signal = new AbortController().signal, onTranscript?: (text: string) => void) {
  const socket = new FakeSocket();
  const errors: Error[] = [];
  let connection: unknown[] = [];
  const factory: SocketFactory = (url, options) => {
    connection = [url, options];
    return socket as unknown as ReturnType<SocketFactory>;
  };
  const opening = openTranscriber({ Authorization: "Bearer secret" }, signal, (e) => errors.push(e), onTranscript, factory);
  const ready = async (ack = "session.updated") => {
    socket.emit("open");
    socket.event(ack);
    return opening;
  };
  return { socket, errors, opening, ready, connection };
}

for (const ack of ["session.updated", "transcription_session.updated"]) {
  test(`configures pcm24k and waits for ${ack}`, async () => {
    const h = setup();
    let resolved = false;
    void h.opening.then(() => { resolved = true; });
    h.socket.emit("open");
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.deepEqual(h.connection, ["wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: "Bearer secret" }, maxPayload: 72 * 1024,
    }]);
    assert.deepEqual(h.socket.sent[0], {
      type: "session.update", session: { type: "transcription", audio: { input: {
        format: { type: "audio/pcm", rate: 24_000 },
        transcription: { model: "gpt-live-transcribe", languages: ["en", "sv"], delay: "low" },
        turn_detection: null,
      } } },
    });
    const config = h.socket.sent[0].session.audio.input.transcription;
    assert.equal("prompt" in config, false);
    assert.equal("language" in config, false, "do not lock mixed speech to one language");
    assert.deepEqual(config.languages, ["en", "sv"]);
    h.socket.event(ack);
    (await h.opening).close();
    assert.equal(h.errors.length, 0);
  });
}

test("appends audio, commits once, and resolves only a completed transcript", async () => {
  const h = setup();
  const t = await h.ready();
  t.append(Buffer.alloc(0));
  assert.equal(h.socket.sent.length, 1);
  const pcm = Buffer.alloc(4_800, 7);
  t.append(pcm);
  assert.equal(h.socket.sent[1].audio, pcm.toString("base64"));
  const finishing = t.finish();
  assert.equal(t.finish(), finishing);
  t.append(pcm);
  assert.deepEqual(Buffer.from(h.socket.sent[2].audio, "base64"), Buffer.alloc(12_000));
  assert.deepEqual(h.socket.sent[3], { type: "input_audio_buffer.commit" });
  assert.equal(h.socket.sent.length, 4);
  assert.equal(h.socket.sent.filter((event) => event.type === "input_audio_buffer.commit").length, 1);
  h.socket.event("input_audio_buffer.committed", { item_id: "a", previous_item_id: null });
  h.socket.event("conversation.item.input_audio_transcription.completed", { item_id: "a", transcript: " hello world " });
  assert.equal(await finishing, "hello world");
  assert.equal(h.socket.terminated, true);
  assert.equal(h.errors.length, 0);
});

test("rejected upgrade reports HTTP status without exposing credentials or response body", async () => {
  const h = setup();
  let drained = false;
  h.socket.emit("unexpected-response", {}, {
    statusCode: 401,
    resume() { drained = true; },
    body: "secret credentials",
  });
  await assert.rejects(h.opening, /HTTP 401.*Codex login/);
  assert.equal(drained, true);
  assert.equal(h.socket.terminated, true);
  assert.equal(h.errors.length, 1);
  assert.doesNotMatch(h.errors[0].message, /secret/);
});

test("no audio finishes empty without committing", async () => {
  const h = setup();
  const t = await h.ready();
  t.append(Buffer.alloc(0));
  assert.equal(await t.finish(), "");
  assert.equal(h.socket.sent.length, 1);
  assert.equal(h.socket.terminated, true);
});

for (const size of [1, 4_799]) {
  test(`pads a tiny ${size}-byte tail and waits for its transcript`, async () => {
    const h = setup();
    const t = await h.ready();
    t.append(Buffer.alloc(size, 7));
    const finishing = t.finish();
    assert.deepEqual(Buffer.from(h.socket.sent[2].audio, "base64"), Buffer.alloc(Math.max(12_000, 4_800 - size)));
    assert.deepEqual(h.socket.sent[3], { type: "input_audio_buffer.commit" });
    h.socket.event("input_audio_buffer.committed", { item_id: "a" });
    h.socket.event("input_audio_transcription.completed", { item_id: "a", transcript: "tiny" });
    assert.equal(await finishing, "tiny");
  });
}

test("pads and commits a short recording with no provisional deltas", async () => {
  const updates: string[] = [];
  const h = setup(undefined, (text) => updates.push(text));
  const t = await h.ready();
  t.append(Buffer.alloc(240 * 24 * 2, 7));
  const finishing = t.finish();
  assert.deepEqual(Buffer.from(h.socket.sent[2].audio, "base64"), Buffer.alloc(12_000));
  assert.deepEqual(h.socket.sent[3], { type: "input_audio_buffer.commit" });
  committed(h.socket, "a");
  completed(h.socket, "a", "Hej");
  assert.equal(await finishing, "Hej");
  assert.deepEqual(updates, ["Hej"]);
});

test("padding send failure prevents the final commit", async () => {
  const h = setup();
  const t = await h.ready();
  t.append(Buffer.alloc(240 * 24 * 2));
  h.socket.sendError = true;
  await assert.rejects(t.finish(), /Transcription/);
  assert.equal(h.socket.sent.some((event) => event.type === "input_audio_buffer.commit"), false);
  assert.equal(h.errors.length, 1);
});

for (const trigger of ["error", "close", "remote", "failed", "invalid", "oversize", "send", "backlog", "audio"]) {
  test(`${trigger} fails once, remains safe before finish, and hides credentials`, async () => {
    const h = setup();
    const t = await h.ready();
    switch (trigger) {
      case "error": h.socket.emit("error", new Error("secret")); break;
      case "close": h.socket.emit("close", 1006, Buffer.from("secret")); break;
      case "remote": h.socket.event("error", { error: { message: "secret" } }); break;
      case "failed": h.socket.event("conversation.item.input_audio_transcription.failed"); break;
      case "invalid": h.socket.emit("message", Buffer.from("not json")); break;
      case "oversize": h.socket.emit("message", Buffer.alloc(72 * 1024 + 1)); break;
      case "send": h.socket.sendError = true; t.append(Buffer.alloc(4_800)); break;
      case "backlog": h.socket.bufferedAmount = 512 * 1024; t.append(Buffer.alloc(2)); break;
      case "audio": t.append(Buffer.alloc(512 * 1024)); break;
    }
    h.socket.emit("error", new Error("secret"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors[0].message, /secret/);
    assert.equal(h.socket.terminated, true);
    await assert.rejects(t.finish(), h.errors[0]);
    t.close();
  });
}

test("startup errors and factory throws reject with sanitized errors", async () => {
  const h = setup();
  const rejected = assert.rejects(h.opening, /connection failed/);
  h.socket.emit("error", new Error("secret"));
  await rejected;
  assert.equal(h.errors.length, 1);
  const errors: Error[] = [];
  await assert.rejects(openTranscriber({}, new AbortController().signal, (e) => errors.push(e), undefined, () => {
    throw new Error("secret");
  }), /connection failed/);
  assert.equal(errors.length, 1);
});

for (const stage of ["before", "startup", "recording", "finishing"]) {
  test(`abort during ${stage} closes and rejects pending operations`, async () => {
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    const h = setup(controller.signal);
    if (stage === "before" || stage === "startup") {
      const rejected = assert.rejects(h.opening, /aborted/);
      controller.abort();
      await rejected;
    } else {
      const t = await h.ready();
      t.append(Buffer.alloc(4_800));
      const pending = stage === "finishing" ? t.finish() : undefined;
      controller.abort();
      await assert.rejects(pending ?? t.finish(), /aborted/);
    }
    assert.equal(h.errors.length, 1);
    assert.equal(h.socket.terminated, stage !== "before");
  });
}

test("setup and completion have separate deadlines", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const starting = setup();
  const rejected = assert.rejects(starting.opening, /setup timed out/);
  context.mock.timers.tick(9_999);
  assert.equal(starting.errors.length, 0);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(starting.errors.length, 1);
  const h = setup();
  const t = await h.ready();
  t.append(Buffer.alloc(4_800));
  context.mock.timers.tick(10_000);
  assert.equal(h.errors.length, 0, "startup deadline is cleared after acknowledgement");
  const finishing = assert.rejects(t.finish(), /completion timed out/);
  context.mock.timers.tick(19_999);
  assert.equal(h.errors.length, 0);
  context.mock.timers.tick(1);
  await finishing;
  assert.equal(h.errors.length, 1);
  assert.equal(h.socket.terminated, true);
});

test("invalid completed transcript rejects pending finish", async () => {
  for (const transcript of [42, "x".repeat(64 * 1024 + 1)]) {
    const h = setup();
    const t = await h.ready();
    t.append(Buffer.alloc(4_800));
    const rejected = assert.rejects(t.finish(), /Invalid transcription result/);
    h.socket.event("input_audio_buffer.committed", { item_id: "a" });
    h.socket.event("input_audio_transcription.completed", { item_id: "a", transcript });
    await rejected;
    assert.equal(h.errors.length, 1);
  }
});

for (const cause of ["service", "send callback"]) {
  test(`${cause} error rejects a pending finish`, async () => {
    const h = setup();
    const t = await h.ready();
    t.append(Buffer.alloc(4_800));
    h.socket.callbackError = cause === "send callback";
    const rejected = assert.rejects(t.finish(), /Transcription/);
    if (cause === "service") h.socket.event("error", { message: "secret" });
    await rejected;
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors[0].message, /secret/);
  });
}


function committed(socket: FakeSocket, id: string, previous: string | null = null) {
  socket.event("input_audio_buffer.committed", { item_id: id, previous_item_id: previous });
}
function delta(socket: FakeSocket, id: string, text: string) {
  socket.event("conversation.item.input_audio_transcription.delta", { item_id: id, delta: text });
}
function completed(socket: FakeSocket, id: string, transcript: string) {
  socket.event("conversation.item.input_audio_transcription.completed", { item_id: id, transcript });
}
async function assertPending(promise: Promise<string>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
}

for (const prefix of ["conversation.item.input_audio_transcription", "input_audio_transcription"]) {
  test(`${prefix} streams provisional deltas while held and corrects without duplicates`, async () => {
    const updates: string[] = [];
    const h = setup(undefined, (text) => updates.push(text));
    const t = await h.ready();
    t.append(Buffer.alloc(95_000));
    t.append(Buffer.alloc(98_000));
    assert.deepEqual(h.socket.sent.slice(1).map((e) => Buffer.from(e.audio, "base64").length), [95_000, 98_000]);
    // Malformed events without an item ID must not create phantom segments.
    h.socket.event(`${prefix}.delta`, { delta: "ignored" });
    h.socket.event(`${prefix}.completed`, { transcript: "ignored" });
    h.socket.event(`${prefix}.delta`, { item_id: "a", delta: "hel" });
    h.socket.event(`${prefix}.delta`, { item_id: "a", delta: "lo" });
    assert.deepEqual(updates, ["hel", "hello"]);
    committed(h.socket, "a");
    h.socket.event(`${prefix}.delta`, { item_id: "a", delta: " där" });
    assert.equal(updates.at(-1), "hello där", "acknowledgement must preserve partial text");
    h.socket.event(`${prefix}.completed`, { item_id: "a", transcript: "Hello där!" });
    h.socket.event(`${prefix}.completed`, { item_id: "a", transcript: "duplicate ignored" });
    h.socket.event(`${prefix}.delta`, { item_id: "a", delta: "late ignored" });
    assert.deepEqual(updates, ["hel", "hello", "hello där", "Hello där!"]);
    assert.equal(h.socket.sent.some((e) => e.type === "input_audio_buffer.commit"), false);
    const finishing = t.finish();
    await assertPending(finishing);
    committed(h.socket, "a");
    assert.equal(await finishing, "Hello där!");
    assert.equal(h.socket.sent.filter((e) => e.type === "input_audio_buffer.commit").length, 1);
    assert.equal(h.errors.length, 0);
  });
}

test("reordered acknowledgements link provisional items without erasing their text", async () => {
  const updates: string[] = [];
  const h = setup(undefined, (text) => updates.push(text));
  const t = await h.ready();
  t.append(Buffer.alloc(48_000));
  delta(h.socket, "b", "second");
  assert.equal(updates.at(-1), "second");
  committed(h.socket, "b", "a");
  delta(h.socket, "a", "first");
  committed(h.socket, "a");
  assert.equal(updates.at(-1), "first second");
  delta(h.socket, "c", "third");
  committed(h.socket, "c", "b");
  assert.equal(updates.at(-1), "first second third");
  const finishing = t.finish();
  committed(h.socket, "c", "b");
  completed(h.socket, "c", "Third!");
  completed(h.socket, "b", "Second!");
  await assertPending(finishing);
  completed(h.socket, "a", "First!");
  assert.equal(await finishing, "First! Second! Third!");
});

test("completed provisional item still waits for the explicit commit acknowledgement", async () => {
  const updates: string[] = [];
  const h = setup(undefined, (text) => updates.push(text));
  const t = await h.ready();
  t.append(Buffer.alloc(4_800));
  delta(h.socket, "a", "draft");
  const finishing = t.finish();
  completed(h.socket, "a", "Corrected");
  assert.deepEqual(updates, ["draft", "Corrected"]);
  await assertPending(finishing);
  committed(h.socket, "a");
  assert.equal(await finishing, "Corrected");
});

test("explicit acknowledgement waits for every known incomplete provisional item", async () => {
  const h = setup();
  const t = await h.ready();
  t.append(Buffer.alloc(48_000));
  delta(h.socket, "a", "first");
  delta(h.socket, "b", "second");
  const finishing = t.finish();
  committed(h.socket, "b", "a");
  completed(h.socket, "b", "Second");
  await assertPending(finishing);
  committed(h.socket, "a");
  await assertPending(finishing);
  completed(h.socket, "a", "First");
  assert.equal(await finishing, "First Second");
});

test("audio always gets one final commit even if known items completed during recording", async () => {
  const h = setup();
  const t = await h.ready();
  t.append(Buffer.alloc(4_800));
  committed(h.socket, "a");
  completed(h.socket, "a", "first");
  t.append(Buffer.alloc(4_800));
  assert.equal(h.socket.sent.some((e) => e.type === "input_audio_buffer.commit"), false);
  const finishing = t.finish();
  assert.equal(t.finish(), finishing);
  assert.equal(h.socket.sent.at(-2)?.type, "input_audio_buffer.append");
  assert.deepEqual(h.socket.sent.at(-1), { type: "input_audio_buffer.commit" });
  await assertPending(finishing);
  committed(h.socket, "b", "a");
  await assertPending(finishing);
  completed(h.socket, "b", "tail");
  assert.equal(await finishing, "first tail");
  assert.equal(h.socket.sent.filter((e) => e.type === "input_audio_buffer.commit").length, 1);
});

for (const done of [false, true]) {
  test(`pending own commit accepts commit_empty with ${done ? "complete" : "incomplete"} known item`, async () => {
    const h = setup();
    const t = await h.ready();
    t.append(Buffer.alloc(4_800));
    delta(h.socket, "a", "draft");
    if (done) completed(h.socket, "a", "saved");
    const finishing = t.finish();
    await assertPending(finishing);
    h.socket.event("error", { error: { code: "input_audio_buffer_commit_empty", message: "secret" } });
    if (!done) {
      await assertPending(finishing);
      assert.equal(h.socket.terminated, false);
      completed(h.socket, "a", "saved");
    }
    assert.equal(await finishing, "saved");
    assert.equal(h.errors.length, 0);
  });
}

for (const stage of ["recording", "acknowledged", "other code"]) {
  test(`commit errors remain fatal: ${stage}`, async () => {
    const h = setup();
    const t = await h.ready();
    t.append(Buffer.alloc(4_800));
    const pending = stage === "recording" ? undefined : t.finish();
    const rejected = pending && assert.rejects(pending, /service error/);
    if (stage === "acknowledged") committed(h.socket, "a");
    h.socket.event("error", { error: {
      code: stage === "other code" ? "other" : "input_audio_buffer_commit_empty", message: "secret",
    } });
    await (rejected ?? assert.rejects(t.finish(), /service error/));
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors[0].message, /secret/);
  });
}

test("120-second duration bound counts all audio regardless of completed items", async () => {
  for (const done of [false, true]) {
    const h = setup();
    const t = await h.ready();
    for (let i = 0; i < 60; i++) {
      t.append(Buffer.alloc(96_000));
      if (done) {
        committed(h.socket, String(i), i ? String(i - 1) : null);
        completed(h.socket, String(i), "ok");
      }
    }
    assert.equal(h.errors.length, 0);
    assert.equal(h.socket.sent.some((e) => e.type === "input_audio_buffer.commit"), false);
    t.append(Buffer.alloc(1));
    await assert.rejects(t.finish(), /duration limit/);
  }
});

test("bounds provisional delta, accumulated delta, UTF-8, and aggregate transcript bytes", async () => {
  for (const mode of ["delta", "accumulated", "utf8", "aggregate"]) {
    const h = setup();
    const t = await h.ready();
    t.append(Buffer.alloc(4_800));
    if (mode === "aggregate") {
      committed(h.socket, "a");
      committed(h.socket, "b", "a");
      completed(h.socket, "a", "x".repeat(40_000));
      completed(h.socket, "b", "y".repeat(40_000));
    } else if (mode === "accumulated") {
      delta(h.socket, "a", "x".repeat(40_000));
      delta(h.socket, "a", "y".repeat(40_000));
    } else {
      delta(h.socket, "a", mode === "utf8" ? "å".repeat(32_769) : "x".repeat(65_537));
    }
    await assert.rejects(t.finish(), /Invalid transcription result/);
    assert.equal(h.errors.length, 1);
  }
});

test("bounds both provisional and acknowledged item counts at 1200", async () => {
  for (const provisional of [false, true]) {
    const h = setup();
    const t = await h.ready();
    t.append(Buffer.alloc(4_800));
    for (let i = 0; i < 1_200; i++) {
      if (provisional) delta(h.socket, String(i), "");
      else committed(h.socket, String(i), i ? String(i - 1) : null);
    }
    assert.equal(h.errors.length, 0);
    if (provisional) delta(h.socket, "overflow", "");
    else committed(h.socket, "overflow", "1199");
    await assert.rejects(t.finish(), /segment limit/);
    assert.equal(h.errors.length, 1);
  }
});

test("explicit close rejects pending completion without notifying onError", async () => {
  const h = setup();
  const t = await h.ready();
  t.append(Buffer.alloc(4_800));
  delta(h.socket, "a", "partial");
  const rejected = assert.rejects(t.finish(), /closed/);
  t.close();
  t.close();
  await rejected;
  assert.equal(h.socket.terminated, true);
  assert.equal(h.errors.length, 0);
});
