import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFaceTimeClient, type FaceTimeClientOptions, type FaceTimeRecord } from "../extensions/talk/facetime-client.ts";

const snapshot = (seq = 0, serviceInstanceId = "service-a") => ({
  type: "snapshot", protocolVersion: 1, serviceInstanceId, seq, call: { phase: "idle" },
  permission: { trusted: true }, configuration: { autoAnswer: false },
});
const event = (seq: number, extra: FaceTimeRecord = {}) => ({
  type: "event", protocolVersion: 1, serviceInstanceId: "service-a", seq,
  event: "call.incoming", callId: "call-1", identity: "🎙️ Caller", allowed: true, ...extra,
});
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function harness(t: test.TestContext, options: Partial<FaceTimeClientOptions> = {}, initial?: (socket: Socket, index: number) => void) {
  // Short paths also fit Darwin's sockaddr_un limit; no real service is used.
  const dir = await mkdtemp("/tmp/pi-ft-");
  const path = join(dir, "s");
  const sockets: Socket[] = [];
  const commands: FaceTimeRecord[] = [];
  let respond = true;
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const command = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        commands.push(command);
        if (respond) socket.write(`${JSON.stringify({ type: "response", id: command.id, ok: true, result: { accepted: command.command } })}\n`);
      }
    });
    if (initial) initial(socket, sockets.length);
    else socket.write(`${JSON.stringify(snapshot())}\n`);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const snapshots: FaceTimeRecord[] = [];
  const events: FaceTimeRecord[] = [];
  const errors: Error[] = [];
  const client = createFaceTimeClient({
    socketPath: path, reconnectMinMs: 10, reconnectMaxMs: 20, snapshotTimeoutMs: 200,
    onSnapshot: (s) => snapshots.push(s), onEvent: (e) => events.push(e), onDisconnect: (e) => errors.push(e), ...options,
  });
  t.after(async () => {
    client.close();
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { client, sockets, commands, snapshots, events, errors, set respond(value: boolean) { respond = value; } };
}

test("FaceTime transport frames split UTF-8/multiple records and filters AX diagnostics", async (t) => {
  const h = await harness(t, {}, (socket) => {
    const bytes = Buffer.from(`${JSON.stringify(snapshot())}\n`);
    for (const byte of bytes) socket.write(Buffer.from([byte]));
  });
  await h.client.connect();
  const bytes = Buffer.from(`${JSON.stringify(event(1))}\n`);
  for (const byte of bytes) h.sockets[0].write(Buffer.from([byte]));
  h.sockets[0].write(`${JSON.stringify(event(2, { event: "accessibility.reconciled", tree: "private" }))}\n${JSON.stringify(event(3, { tree: "private" }))}\n`);
  await until(() => h.events.length === 2);
  assert.equal(h.events[0].identity, "🎙️ Caller");
  assert.equal("tree" in h.events[1], false);
  assert.deepEqual(await h.client.request("status"), { accepted: "status" });
  assert.equal(h.commands[0].type, "command");
  assert.equal(typeof h.commands[0].id, "string");
});

test("FaceTime transport bounds pending IDs, rejects timeouts, ignores late responses", async (t) => {
  const h = await harness(t, { maxPending: 1, requestTimeoutMs: 60 });
  await h.client.connect();
  h.respond = false;
  const pending = h.client.request("call", { to: "synthetic" });
  const timedOut = assert.rejects(pending, /outcome unknown, not retried/);
  await assert.rejects(h.client.request("answer"), /Too many pending/);
  await timedOut;
  h.sockets[0].write(`${JSON.stringify({ type: "response", id: h.commands[0].id, ok: true, result: {} })}\n`);
  h.respond = true;
  await h.client.request("status");
  assert.notEqual(h.commands[0].id, h.commands[1].id);
  assert.equal(h.commands.filter((c) => c.command === "call").length, 1);
});

test("sharing commands use their own timeout without retries or disconnect replays", async (t) => {
  const h = await harness(t, { requestTimeoutMs: 30, sharingRequestTimeoutMs: 500 });
  await h.client.connect();
  h.respond = false;
  const share = h.client.request("screen.share");
  await until(() => h.commands.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.errors.length, 0);
  h.sockets[0].write(`${JSON.stringify({ type: "response", id: h.commands[0].id, ok: true, result: { shared: true } })}\n`);
  assert.deepEqual(await share, { shared: true });
  assert.equal(h.commands.length, 1);

  const ordinary = h.client.request("status");
  await assert.rejects(ordinary, /outcome unknown, not retried/);
  assert.equal(h.commands.filter((c) => c.command === "status").length, 1);

  const stop = h.client.request("screen.stop");
  await until(() => h.commands.length === 3);
  h.sockets[0].destroy();
  await assert.rejects(stop, /disconnected/);
  await until(() => h.snapshots.length === 2);
  assert.equal(h.commands.filter((c) => c.command === "screen.stop").length, 1);
  assert.equal(h.errors.length, 1);
});

test("FaceTime disconnect rejects in-flight mutations and reconnect never replays them", async (t) => {
  const h = await harness(t, {}, (socket, index) => socket.write(`${JSON.stringify(snapshot(index === 1 ? 5 : 7))}\n`));
  await h.client.connect();
  h.respond = false;
  const pending = h.client.request("answer");
  const rejected = assert.rejects(pending, /disconnect/);
  await until(() => h.commands.length === 1);
  h.sockets[0].destroy();
  await rejected;
  await until(() => h.snapshots.length === 2);
  assert.equal(h.commands.length, 1);
  h.sockets[1].write(`${JSON.stringify(event(6))}\n${JSON.stringify(event(8))}\n${JSON.stringify(event(8))}\n`);
  await until(() => h.events.length === 1);
  assert.equal(h.events[0].seq, 8);
  h.respond = true;
  await h.client.request("status");
  assert.deepEqual(h.commands.map((c) => c.command), ["answer", "status"]);
});

test("FaceTime transport requires initial version/session metadata with a deadline", async (t) => {
  for (const initial of [
    (socket: Socket) => socket.write(`${JSON.stringify({ ...snapshot(), protocolVersion: 2 })}\n`),
    (socket: Socket) => socket.write(`${JSON.stringify({ ...snapshot(), serviceInstanceId: undefined })}\n`),
    (socket: Socket) => socket.write('{"type":"event"}\n'),
    (_socket: Socket) => {},
  ]) {
    const h = await harness(t, { snapshotTimeoutMs: 30 }, initial);
    await assert.rejects(h.client.connect(), /snapshot|protocol/);
    h.client.close();
  }
});

test("FaceTime transport bounds lines across chunks and rejects malformed/partial data", async (t) => {
  for (const send of [
    (s: Socket) => s.write("x".repeat(1025)),
    (s: Socket) => { s.write("x".repeat(1024)); s.write("x"); },
    (s: Socket) => s.write("not JSON\n"),
    (s: Socket) => s.end('{"partial":'),
  ]) {
    const h = await harness(t, { maxLineBytes: 1024 });
    await h.client.connect();
    send(h.sockets[0]);
    await until(() => h.errors.length > 0);
    assert.match(h.errors[0].message, /size limit|NDJSON/);
    h.client.close();
  }
});

test("FaceTime transport sequence watermark tolerates restart but refuses same-service regression", async (t) => {
  const h = await harness(t, {}, (socket, index) => {
    socket.write(`${JSON.stringify(snapshot(index === 1 ? 9 : 0, index < 3 ? "service-a" : "service-b"))}\n`);
  });
  await h.client.connect();
  h.sockets[0].destroy();
  await until(() => h.sockets.length >= 3 && h.snapshots.length === 2);
  assert.equal(h.snapshots[1].serviceInstanceId, "service-b");
  assert.ok(h.errors.some((error) => /regressed/.test(error.message)));
});

test("FaceTime close cancels initial wait and all requests, without reconnect", async (t) => {
  const h = await harness(t, {}, () => {});
  const connecting = h.client.connect();
  h.client.close();
  await assert.rejects(connecting, /closed/);
  await assert.rejects(h.client.request("call"), /not connected/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(h.sockets.length <= 1);
});
