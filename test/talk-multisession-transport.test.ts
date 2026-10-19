import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectTalkSession, createTalkSessionHub, talkSessionSocketPath,
  type TalkSessionHubOptions, type TalkSessionInput, type TalkSessionClient } from "../extensions/talk/multisession-transport.ts";
import { TALK_MAX_FRAME_BYTES, TALK_MAX_PENDING_REQUESTS, TALK_MAX_SESSIONS } from "../extensions/talk/multisession-protocol.ts";

const metadata = (name: string): TalkSessionInput => ({ sessionId: `session-${name}`, name, state: "idle", activity: "" });
const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t: TestContext, extra: Partial<TalkSessionHubOptions> = {}) {
  // macOS /var and /tmp are aliases; actual transport paths intentionally reject symlinks.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "talk-ipc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = talkSessionSocketPath(dir);
  const hub = await createTalkSessionHub({ socketPath, main: metadata("main"), ...extra });
  t.after(() => hub.close());
  return { hub, socketPath, dir, connect: (name: string) => connectTalkSession({ socketPath, session: metadata(name) }) };
}
async function raw(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  await once(socket, "connect");
  return socket;
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail("Condition did not become true");
}

test("private hub, explicit named sessions, bidirectional RPC/events, and fresh instance identities", async (t) => {
  const events: unknown[] = [], removed: string[] = [];
  const f = await fixture(t, {
    onRequest: (peer, method, payload) => ({ name: peer.identity.name, method, payload }),
    onEvent: (peer, event, payload) => { events.push([peer.identity.name, event, payload]); },
    onDisconnect: (peer) => { removed.push(peer.identity.instanceId); },
  });
  assert.equal(lstatSync(join(f.dir, "talk-multisession")).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.socketPath).mode & 0o777, 0o600);
  assert.equal(f.hub.sessions().length, 1);
  const a = await f.connect("alpha");
  t.after(() => a.close());
  assert.equal(a.identity.name, "alpha");
  assert.equal(a.identity.cwd, process.cwd());
  assert.equal(a.identity.isMain, false);
  assert.equal(f.hub.sessions()[0].isMain, true);
  assert.ok(Object.isFrozen(a.identity));
  assert.equal(f.hub.getPeer("alpha")!.identity.instanceId, a.identity.instanceId);
  assert.deepEqual(await a.request("echo", { x: 1 }), { name: "alpha", method: "echo", payload: { x: 1 } });
  a.onRequest = (method, payload) => [method, payload];
  assert.deepEqual(await f.hub.getPeer("alpha")!.request("snapshot", null), ["snapshot", null]);
  a.onEvent = (event, payload) => { events.push([event, payload]); };
  a.notify("activity", "busy");
  f.hub.broadcast("voice", { active: true });
  await waitFor(() => events.length === 2);
  assert.deepEqual(events, [["alpha", "activity", "busy"], ["voice", { active: true }]]);
  const old = a.identity.instanceId;
  a.close();
  await waitFor(() => !f.hub.getPeer("alpha"));
  assert.deepEqual(removed, [old]);
  const next = await f.connect("alpha");
  t.after(() => next.close());
  assert.notEqual(next.identity.instanceId, old);
});

test("duplicate exact names rejected, metadata updates/listing preserve immutable identity", async (t) => {
  let changes = 0;
  const f = await fixture(t, { onSessions: () => { changes++; } });
  const a = await f.connect("alpha"); t.after(() => a.close());
  await assert.rejects(f.connect("alpha"), /already connected/);
  await assert.rejects(f.connect("main"), /already connected/);
  await assert.rejects(connectTalkSession({ socketPath: f.socketPath,
    session: { ...metadata("another-name"), sessionId: "session-alpha" } }), /identity already connected/);
  await assert.rejects(connectTalkSession({ socketPath: f.socketPath,
    session: { ...metadata("another-main-name"), sessionId: "session-main" } }), /identity already connected/);
  const distinct = await f.connect("Alpha"); t.after(() => distinct.close());
  const instanceId = a.identity.instanceId;
  await a.update({ ...metadata("alpha"), cwd: "/absolute/project", state: "working", activity: "Running tests" });
  assert.equal(a.identity.instanceId, instanceId);
  const listing = await a.sessions();
  assert.equal(listing.length, 3);
  assert.deepEqual(listing.find((s) => s.name === "alpha"), a.identity);
  assert.equal(a.identity.activity, "Running tests");
  f.hub.updateMain({ ...metadata("main"), state: "unavailable", activity: "Voice offline" });
  assert.equal((await a.sessions())[0].state, "unavailable");
  await assert.rejects(a.update(metadata("renamed")), /Immutable/);
  assert.throws(() => f.hub.updateMain(metadata("renamed")), /Immutable/);
  assert.ok(changes >= 5);
});

test("disconnect rejects pending calls, notifies once, and never reconnects or replays", async (t) => {
  let calls = 0, disconnects = 0;
  const f = await fixture(t, { onRequest: () => { calls++; return new Promise(() => {}); } });
  const a = await connectTalkSession({ socketPath: f.socketPath, session: metadata("a"), onDisconnect: () => { disconnects++; } });
  const pending = a.request("submit", null);
  const rejected = assert.rejects(pending, /disconnected.*unknown/);
  await waitFor(() => calls === 1);
  await f.hub.close();
  await rejected;
  await waitFor(() => disconnects === 1);
  a.close();
  await delay();
  assert.equal(calls, 1);
  assert.equal(disconnects, 1);
  await assert.rejects(a.request("submit", null), /unavailable/);
  assert.equal(existsSync(f.socketPath), false);
});

test("timeouts, outbound bounds, inbound concurrency, and generic remote errors", async (t) => {
  let calls = 0;
  const f = await fixture(t, { onRequest: (_peer, method) => {
    if (method === "secret") throw new Error("PRIVATE CREDENTIAL");
    calls++; return new Promise(() => {});
  } });
  const a = await f.connect("a"); t.after(() => a.close());
  await assert.rejects(a.request("secret", null), (error: Error) => {
    assert.equal(error.message, "Talk remote request failed"); return true;
  });
  await assert.rejects(a.request("large", "x".repeat(TALK_MAX_FRAME_BYTES)), /too large/);
  // Either endpoint's deadline may win under parallel-suite scheduling.
  await assert.rejects(a.request("hang", null, 200), /timed out.*not retried|remote request failed/);
  // Timed-out handlers keep their inbound slots until actual settlement.
  const requests = Array.from({ length: TALK_MAX_PENDING_REQUESTS }, () => a.request("hang", null, 250));
  const outcomes = Promise.allSettled(requests);
  await assert.rejects(a.request("overflow", null), /Too many/);
  await outcomes;
  assert.equal(calls, TALK_MAX_PENDING_REQUESTS);
  await assert.rejects(a.request("still full", null), /remote request failed/);
  await assert.rejects(a.request("bad timeout", null, Infinity), /timeout/);
});

test("unknown frames, oversized/unterminated input, and duplicate request IDs disconnect only offending socket", async (t) => {
  const f = await fixture(t);
  for (const input of [
    '{"v":2,"type":"hello"}\n',
    '{"v":1,"type":"unknown"}\n',
    'not json\n',
    "x".repeat(TALK_MAX_FRAME_BYTES + 1),
  ]) {
    const socket = await raw(f.socketPath);
    const closed = once(socket, "close");
    socket.on("error", () => {});
    socket.write(input);
    await closed;
  }
  const socket = await raw(f.socketPath);
  socket.on("error", () => {});
  socket.write(JSON.stringify({ v: 1, type: "hello", session: { ...metadata("raw"), cwd: process.cwd() } }) + "\n");
  await once(socket, "data");
  const closed = once(socket, "close");
  const request = JSON.stringify({ v: 1, type: "request", id: 1, method: "test", payload: null, deadline: Date.now() + 1000 }) + "\n";
  socket.write(request + request);
  socket.resume();
  await closed;
  await waitFor(() => !f.hub.getPeer("raw"));
  const a = await f.connect("healthy"); a.close();
});

test("unsafe directories, symlinks, existing socket paths, and unsafe socket modes are refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createTalkSessionHub({ socketPath: f.socketPath, main: metadata("other") }), /already exists/);
  const unsafe = join(f.dir, "unsafe"); mkdirSync(unsafe, { mode: 0o755 });
  await assert.rejects(createTalkSessionHub({ socketPath: join(unsafe, "hub.sock"), main: metadata("x") }), /owner-only/);
  const link = join(f.dir, "link"); symlinkSync(join(f.dir, "talk-multisession"), link);
  await assert.rejects(connectTalkSession({ socketPath: join(link, "hub.sock"), session: metadata("x") }), /Unsafe/);
  chmodSync(f.socketPath, 0o666);
  await assert.rejects(f.connect("badmode"), /Unsafe Talk socket/);
  chmodSync(f.socketPath, 0o600);
  const file = join(f.dir, "talk-multisession", "file"); writeFileSync(file, "not a socket", { mode: 0o600 });
  await assert.rejects(connectTalkSession({ socketPath: file, session: metadata("x") }), /Unsafe/);
  const linkSocket = join(f.dir, "talk-multisession", "link.sock"); symlinkSync(f.socketPath, linkSocket);
  await assert.rejects(connectTalkSession({ socketPath: linkSocket, session: metadata("x") }), /Unsafe/);
  assert.equal(existsSync(f.socketPath), true);
});

test("stale sockets are never automatically removed or claimed", async (t) => {
  const f = await fixture(t);
  const stale = join(f.dir, "talk-multisession", "s.sock");
  await promisify(execFile)(process.execPath, ["-e",
    'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', stale]);
  assert.ok(lstatSync(stale).isSocket());
  await assert.rejects(createTalkSessionHub({ socketPath: stale, main: metadata("replacement") }), /already exists/);
  assert.ok(lstatSync(stale).isSocket());
});

test("peer handler setters do not replace metadata control RPC and expired RPC never runs", async (t) => {
  let calls = 0;
  const f = await fixture(t, { onPeer: (peer) => { peer.onRequest = () => { calls++; return "custom"; }; } });
  const a = await f.connect("a"); t.after(() => a.close());
  assert.equal(await a.request("custom", null), "custom");
  await a.update({ ...metadata("a"), activity: "Updated" });
  assert.equal((await a.sessions())[1].activity, "Updated");
  assert.equal(calls, 1);
  const socket = await raw(f.socketPath);
  socket.write(JSON.stringify({ v: 1, type: "hello", session: { ...metadata("raw"), cwd: process.cwd() } }) + "\n");
  await once(socket, "data");
  socket.write(JSON.stringify({ v: 1, type: "request", id: 1, method: "expired", payload: null, deadline: Date.now() - 1 }) + "\n");
  const [data] = await once(socket, "data");
  assert.deepEqual(JSON.parse(data.toString()), { v: 1, type: "response", id: 1, ok: false, payload: null });
  assert.equal(calls, 1);
  socket.destroy();
});

test("invalid metadata is rejected locally and wire metadata must contain absolute cwd", async (t) => {
  const f = await fixture(t);
  for (const session of [{ ...metadata("x"), cwd: "relative" }, metadata(" bad "),
    metadata("👩‍💻"), metadata("名".repeat(128)), metadata("hidden\u202ename"),
    { ...metadata("x"), cwd: `/project/${"名".repeat(1400)}` },
    { ...metadata("x"), activity: "x".repeat(513) }]) {
    await assert.rejects(connectTalkSession({ socketPath: f.socketPath, session }), /Invalid session/);
  }
  const socket = await raw(f.socketPath);
  const closed = once(socket, "close");
  socket.write(JSON.stringify({ v: 1, type: "hello", session: metadata("raw") }) + "\n");
  await closed;
  assert.equal(f.hub.sessions().length, 1);
  const valid = await f.connect("開発😀");
  t.after(() => valid.close());
  assert.equal(valid.identity.name, "開発😀", "display-safe Unicode names remain supported");
});

test("replacement public socket survives original hub close and remains usable", async (t) => {
  const f = await fixture(t);
  const oldInode = lstatSync(f.socketPath).ino;
  unlinkSync(f.socketPath);
  const replacement = await createTalkSessionHub({ socketPath: f.socketPath, main: metadata("replacement") });
  t.after(() => replacement.close());
  const inode = lstatSync(f.socketPath).ino;
  assert.notEqual(inode, oldInode);
  await f.hub.close();
  assert.equal(lstatSync(f.socketPath).ino, inode);
  const client = await f.connect("still usable");
  t.after(() => client.close());
  assert.equal((await client.sessions())[0].name, "replacement");
  assert.deepEqual(readdirSync(join(f.dir, "talk-multisession")), ["hub.sock"]);
});

test("racing publications preserve the winner and remove all failed staging sockets", async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "talk-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = talkSessionSocketPath(dir);
  // Both synchronous prechecks finish before either listen continuation publishes.
  const outcomes = await Promise.allSettled([
    createTalkSessionHub({ socketPath, main: metadata("first") }),
    createTalkSessionHub({ socketPath, main: metadata("second") }),
  ]);
  const winners = outcomes.filter((r) => r.status === "fulfilled");
  assert.equal(winners.length, 1);
  const winner = winners[0].value;
  t.after(() => winner.close());
  const failure = outcomes.find((r) => r.status === "rejected")!;
  assert.equal(failure.reason.code, "EEXIST");
  const inode = lstatSync(socketPath).ino;
  assert.deepEqual(readdirSync(join(dir, "talk-multisession")), ["hub.sock"]);
  const client = await connectTalkSession({ socketPath, session: metadata("healthy") });
  client.close();
  assert.equal(lstatSync(socketPath).ino, inode);
  await winner.close();
  assert.deepEqual(readdirSync(join(dir, "talk-multisession")), []);
});

test("a file appearing after the precheck survives failed publication with no staging leaks", async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "talk-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = talkSessionSocketPath(dir);
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (this: Server, ...args: Parameters<Server["listen"]>) {
    this.prependOnceListener("listening", () => {
      writeFileSync(socketPath, "collision owner", { mode: 0o600, flag: "wx" });
    });
    return Reflect.apply(listen, this, args);
  });
  await assert.rejects(createTalkSessionHub({ socketPath, main: metadata("main") }), { code: "EEXIST" });
  assert.ok(lstatSync(socketPath).isFile());
  assert.equal(lstatSync(socketPath).size, Buffer.byteLength("collision owner"));
  assert.deepEqual(readdirSync(join(dir, "talk-multisession")), ["hub.sock"]);
});

test("main plus 64 destinations is the cap; released slots accept new sessions", async (t) => {
  const f = await fixture(t);
  const clients: TalkSessionClient[] = [];
  t.after(() => { for (const client of clients) client.close(); });
  for (let i = 0; i < TALK_MAX_SESSIONS; i++) clients.push(await f.connect(`s${i}`));
  assert.equal(f.hub.sessions().length, 65);
  assert.equal((await clients[0].sessions()).length, 65);
  await assert.rejects(f.connect("overflow"), /closed before handshake/);
  assert.equal(f.hub.sessions().length, 65);
  clients.pop()!.close();
  await waitFor(() => f.hub.sessions().length === 64);
  clients.push(await f.connect("replacement"));
  assert.equal((await clients[0].sessions()).length, 65);
});

test("async events are serialized without blocking metadata or RPC and drain FIFO", async (t) => {
  const seen: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, { onEvent: async (_peer, _event, payload) => {
    seen.push(payload as number);
    if (payload === 0) await gate;
  } });
  const client = await f.connect("a"); t.after(() => client.close());
  client.notify("snapshot", 0);
  await waitFor(() => seen.length === 1);
  for (let i = 1; i <= TALK_MAX_PENDING_REQUESTS; i++) client.notify("snapshot", i);
  await client.update({ ...metadata("a"), activity: "Still live" });
  assert.equal((await client.sessions())[1].activity, "Still live");
  assert.deepEqual(seen, [0]);
  release();
  await waitFor(() => seen.length === TALK_MAX_PENDING_REQUESTS + 1);
  assert.deepEqual(seen, Array.from({ length: 65 }, (_, i) => i));
});

test("stalled event handlers cannot accumulate unbounded work; overflow disconnects", async (t) => {
  let calls = 0;
  const f = await fixture(t, { onEvent: () => { calls++; return new Promise(() => {}); } });
  const client = await f.connect("a"); t.after(() => client.close());
  client.notify("snapshot", null);
  await waitFor(() => calls === 1);
  for (let i = 0; i <= TALK_MAX_PENDING_REQUESTS; i++) client.notify("snapshot", i);
  await waitFor(() => !client.connected);
  assert.equal(calls, 1);
  const healthy = await f.connect("healthy"); healthy.close();
});
