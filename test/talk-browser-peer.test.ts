import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import { connect as connectTcp } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { createBrowserPeer } from "../extensions/talk/browser-peer.ts";

async function harness() {
  const controller = new AbortController();
  const events: unknown[] = [];
  const errors: Error[] = [];
  let ready = 0;
  let closed = 0;
  const peer = await createBrowserPeer({
    onEvent: (event) => events.push(event),
    onReady: () => { ready++; },
    onError: (error) => errors.push(error),
    onClosed: () => { closed++; },
  }, controller.signal);
  const url = new URL(peer.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  return {
    peer, controller, events, errors, url, token,
    get ready() { return ready; },
    get closed() { return closed; },
    client(options: { origin?: string; protocols?: string[]; host?: string; path?: string } = {}) {
      return new WebSocket(`ws://${url.host}${options.path ?? "/peer"}`, options.protocols ?? ["mypi-talk", token], {
        origin: options.origin ?? url.origin,
        headers: options.host ? { Host: options.host } : {},
      });
    },
  };
}

function request(url: string, headers = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    get(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject);
  });
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 25));

async function rejected(client: WebSocket) {
  const status = await new Promise<number>((resolve, reject) => {
    client.on("error", () => {});
    client.once("open", () => { client.terminate(); reject(new Error("Unauthorized connection accepted")); });
    client.once("unexpected-response", (_req, res) => { res.resume(); client.terminate(); resolve(res.statusCode!); });
  });
  assert.equal(status, 403);
}

test("serves only the static page with restrictive headers and no URL secret in HTML", async () => {
  const h = await harness();
  try {
    assert.equal(new URL(h.peer.url).hostname, "127.0.0.1");
    assert.match(h.token, /^[\w-]{43}$/);
    const page = await request(h.url.origin);
    assert.equal(page.status, 200);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["access-control-allow-origin"], undefined);
    const csp = String(page.headers["content-security-policy"]);
    assert.match(csp, /script-src 'nonce-[\w-]+'/);
    assert.match(csp, /style-src 'nonce-[\w-]+'/);
    assert.ok(csp.includes(`connect-src 'self' ws://${h.url.host}`));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!page.body.includes(h.token));
    assert.equal((await request(`${h.url.origin}/favicon.ico`)).status, 204);
    assert.equal((await request(`${h.url.origin}/peer`)).status, 404);
    assert.equal((await request(h.url.origin, { Host: "evil.test" })).status, 403);
  } finally { await h.peer.close(); }
});

test("rejects wrong origins, hosts, paths, secrets, and subprotocols without claiming the peer", async () => {
  const h = await harness();
  try {
    for (const options of [
      { origin: "http://evil.test" }, { origin: "null" }, { host: "localhost" },
      { path: "/other" }, { protocols: ["mypi-talk"] },
      { protocols: ["wrong", h.token] }, { protocols: ["mypi-talk", "x".repeat(43)] },
      { protocols: ["mypi-talk", h.token, "extra"] },
    ]) await rejected(h.client(options));
    await rejected(new WebSocket(`ws://${h.url.host}/peer`, ["mypi-talk", h.token]));
    const client = h.client();
    await once(client, "open");
    assert.equal(client.protocol, "mypi-talk");
    await rejected(h.client());
    client.terminate();
    await turn();
    assert.equal(h.closed, 1);
    assert.equal(h.errors.length, 0);
  } finally { await h.peer.close(); }
});

test("offer, answer, gated once-only ready, events, send, and graceful stop", async () => {
  const h = await harness();
  try {
    const client = h.client();
    await once(client, "open");
    const received: unknown[] = [];
    client.on("message", (data) => received.push(JSON.parse(data.toString())));
    client.send(JSON.stringify({ type: "ready" }));
    client.send(JSON.stringify({ type: "offer", sdp: "v=0\r\n" }));
    assert.equal(await h.peer.offer, "v=0\r\n");
    await turn();
    assert.equal(h.ready, 0);
    h.peer.applyAnswer("v=0\r\nanswer");
    client.send(JSON.stringify({ type: "ready" }));
    client.send(JSON.stringify({ type: "ready" }));
    client.send(JSON.stringify({ type: "event", event: { transcript: "hello" } }));
    h.peer.sendData({ greeting: "hi" });
    await turn();
    assert.equal(h.ready, 1);
    assert.deepEqual(h.events, [{ transcript: "hello" }]);
    assert.deepEqual(received, [
      { type: "answer", sdp: "v=0\r\nanswer" }, { type: "send", event: { greeting: "hi" } },
    ]);
    const closing = h.peer.close();
    assert.equal(h.peer.close(), closing);
    await closing;
    assert.deepEqual(received.at(-1), { type: "stop" });
    assert.equal(h.closed, 0);
    assert.equal(h.errors.length, 0);
    await assert.rejects(request(h.url.origin));
  } finally { await h.peer.close(); }
});

test("invalid, duplicate, oversized messages and browser errors are generic and terminal", async () => {
  for (const messages of [
    ['{"type":"offer","sdp":"secret invalid SDP"}'],
    [JSON.stringify({ type: "offer", sdp: `v=0\n${"x".repeat(256 * 1024)}` })],
    [JSON.stringify({ type: "event", event: "x".repeat(256 * 1024) })],
    ["x".repeat(301 * 1024)],
    [JSON.stringify({ type: "error", error: "private secret" })],
    [JSON.stringify({ type: "offer", sdp: "v=0\n" }), JSON.stringify({ type: "offer", sdp: "v=0\n" })],
  ]) {
    const h = await harness();
    try {
      const client = h.client();
      await once(client, "open");
      client.on("error", () => {});
      const disconnected = once(client, "close");
      for (const message of messages) client.send(message);
      await disconnected;
      assert.equal(h.errors.length, 1);
      assert.doesNotMatch(h.errors[0].message, /secret|private|xxxx/);
      assert.equal(h.closed, 0);
    } finally { await h.peer.close(); }
  }
});

test("early abort and close reject pending offers, release ports and do not duplicate callbacks", async () => {
  const pre = new AbortController();
  pre.abort();
  const callbacks = { onEvent() {}, onReady() {}, onError() {}, onClosed() {} };
  await assert.rejects(createBrowserPeer(callbacks, pre.signal));
  const during = new AbortController();
  const setup = createBrowserPeer(callbacks, during.signal);
  during.abort();
  await assert.rejects(setup);
  for (const abort of [false, true]) {
    const h = await harness();
    if (abort) h.controller.abort();
    else await h.peer.close();
    await assert.rejects(h.peer.offer, /closed/);
    await h.peer.close();
    await assert.rejects(request(h.url.origin));
    assert.equal(h.errors.length, 0);
    assert.equal(h.closed, 0);
  }
});

test("offer and ready deadlines fail once with no late callbacks", async (t) => {
  for (const offered of [false, true]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await harness();
    try {
      const client = h.client();
      await once(client, "open");
      if (offered) {
        client.send(JSON.stringify({ type: "offer", sdp: "v=0\n" }));
        await h.peer.offer;
        h.peer.applyAnswer("v=0\n");
      }
      t.mock.timers.tick(90_000);
      assert.equal(h.errors.length, 1);
      assert.match(h.errors[0].message, /timed out/);
      t.mock.timers.tick(90_000);
      assert.equal(h.errors.length, 1);
      t.mock.timers.reset();
    } finally { t.mock.timers.reset(); await h.peer.close(); }
  }
});

test("outgoing oversize and throwing callbacks are contained", async () => {
  const h = await harness();
  try {
    const client = h.client();
    await once(client, "open");
    h.peer.sendData("x".repeat(301 * 1024));
    await h.peer.close();
    assert.equal(h.errors.length, 1);
  } finally { await h.peer.close(); }
  const controller = new AbortController();
  const peer = await createBrowserPeer({
    onEvent() { throw new Error("consumer"); }, onReady() { throw new Error("consumer"); },
    onError() { throw new Error("consumer"); }, onClosed() { throw new Error("consumer"); },
  }, controller.signal);
  try {
    const url = new URL(peer.url);
    const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
    const client = new WebSocket(`ws://${url.host}/peer`, ["mypi-talk", token], { origin: url.origin });
    await once(client, "open");
    client.send(JSON.stringify({ type: "event", event: {} }));
    client.send(JSON.stringify({ type: "error", error: "private" }));
    await once(client, "close");
  } finally { await peer.close(); }
});

test("close forcibly cleans up an idle HTTP connection", async () => {
  const h = await harness();
  const socket = connectTcp(Number(h.url.port), "127.0.0.1");
  try {
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\n");
    socket.on("error", () => {}); // Forced cleanup may reset a partial request.
    const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await h.peer.close();
    await ended;
    await assert.rejects(request(h.url.origin));
  } finally { socket.destroy(); await h.peer.close(); }
});
