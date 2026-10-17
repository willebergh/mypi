import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { renderBrowserPage } from "./browser-page.ts";

export interface BrowserPeer {
  url: string;
  offer: Promise<string>;
  applyAnswer(sdp: string): void;
  sendData(event: unknown): void;
  close(): Promise<void>;
}

const SDP_LIMIT = 256 * 1024;
const JSON_LIMIT = 300 * 1024;
const BUFFER_LIMIT = 512 * 1024;

function validSdp(value: unknown): value is string {
  return typeof value === "string" && /^v=0(?:\r?\n|$)/.test(value)
    && Buffer.byteLength(value) <= SDP_LIMIT;
}

export async function createBrowserPeer(callbacks: {
  onEvent(event: unknown): void;
  onReady(): void;
  onError(error: Error): void;
  onClosed(): void;
}, signal: AbortSignal): Promise<BrowserPeer> {
  if (signal.aborted) throw new Error("Browser peer aborted");
  const token = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const page = renderBrowserPage(nonce);
  let host = "";
  let origin = "";
  let ws: WebSocket | undefined;
  let claimed = false;
  let closed = false;
  let offered = false;
  let answered = false;
  let ready = false;
  let terminalNotified = false;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveOffer!: (sdp: string) => void;
  let rejectOffer!: (error: Error) => void;
  const offer = new Promise<string>((resolve, reject) => { resolveOffer = resolve; rejectOffer = reject; });
  // Closing before a caller starts awaiting the offer must not leak a rejection.
  void offer.catch(() => {});
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' ws://${host}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (closed || req.headers.host !== host) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
    if (req.method !== "GET" || req.url !== "/") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: JSON_LIMIT,
    perMessageDeflate: false,
    handleProtocols: () => "mypi-talk",
  });

  function safe(callback: () => void) {
    try { callback(); } catch { /* Consumer callbacks must not escape socket handlers. */ }
  }
  function notify(kind: "error" | "closed", message = "Browser peer failed") {
    if (terminalNotified || closed) return;
    terminalNotified = true;
    // Start cleanup before invoking a callback that may itself close the peer.
    void close();
    safe(() => kind === "error" ? callbacks.onError(new Error(message)) : callbacks.onClosed());
  }
  function deadline() {
    clearTimeout(timer);
    timer = setTimeout(() => notify("error", "Browser peer timed out"), 90_000);
  }
  function send(message: unknown): boolean {
    if (closed || !ws || ws.readyState !== WebSocket.OPEN) return false;
    let json: string;
    try { json = JSON.stringify(message); }
    catch { notify("error", "Could not encode browser peer message"); return false; }
    const size = Buffer.byteLength(json);
    if (size > JSON_LIMIT || ws.bufferedAmount + size > BUFFER_LIMIT) {
      notify("error", "Browser peer send limit exceeded");
      return false;
    }
    ws.send(json, (error) => { if (error) notify("error", "Could not send browser peer message"); });
    return true;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    rejectOffer(new Error("Browser peer closed"));
    closing = new Promise<void>((resolve) => {
      let finished = false;
      const force = setTimeout(() => {
        ws?.terminate();
        for (const socket of sockets) socket.destroy();
      }, 250);
      function done() {
        if (finished) return;
        finished = true;
        clearTimeout(force);
        for (const socket of sockets) socket.destroy();
        resolve();
      }
      if (ws?.readyState === WebSocket.OPEN) {
        // Best effort only: shutdown cannot wait for an unresponsive browser.
        if (ws.bufferedAmount < BUFFER_LIMIT) ws.send(JSON.stringify({ type: "stop" }));
        ws.close(1000);
      }
      wss.close(() => {});
      server.close(done);
      server.closeIdleConnections();
      if (!server.listening && sockets.size === 0) done();
    });
    return closing;
  }
  function abort() { void close(); }

  server.on("upgrade", (req, socket, head) => {
    const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ?? [];
    const supplied = protocols.length === 2 && protocols.includes("mypi-talk")
      ? protocols.find((value) => value !== "mypi-talk") ?? "" : "";
    const bytes = Buffer.from(supplied);
    const secret = Buffer.from(token);
    const authenticated = bytes.length === secret.length && timingSafeEqual(bytes, secret);
    if (closed || claimed || req.method !== "GET" || req.url !== "/peer"
      || req.headers.host !== host || req.headers.origin !== origin || !authenticated) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      claimed = true;
      ws = client;
      client.on("error", () => notify("error", "Browser peer connection failed"));
      client.on("close", () => notify("closed"));
      client.on("message", (data, binary) => {
        if (closed) return;
        try {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (binary || bytes.length > JSON_LIMIT) throw new Error();
          const message = JSON.parse(bytes.toString("utf8"));
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
          switch (message.type) {
            case "offer":
              if (offered || !validSdp(message.sdp)) throw new Error();
              offered = true;
              resolveOffer(message.sdp);
              deadline();
              break;
            case "ready":
              if (answered && !ready) {
                ready = true;
                clearTimeout(timer);
                safe(() => callbacks.onReady());
              }
              break;
            case "event":
              if (!("event" in message) || Buffer.byteLength(JSON.stringify(message.event)) > SDP_LIMIT) throw new Error();
              safe(() => callbacks.onEvent(message.event));
              break;
            case "error": notify("error", "Browser peer reported an error"); break;
            case "closed": notify("closed"); break;
            default: throw new Error();
          }
        } catch { notify("error", "Invalid browser peer message"); }
      });
    });
  });
  server.on("error", () => notify("error", "Browser peer server failed"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(new Error("Browser peer aborted")); };
      const onError = () => { cleanup(); reject(new Error("Could not start browser peer")); };
      function cleanup() {
        signal.removeEventListener("abort", onAbort);
        server.removeListener("error", onError);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        cleanup();
        if (closed) server.close();
        resolve();
      });
      if (signal.aborted) onAbort();
    });
    if (closed || signal.aborted) throw new Error("Browser peer closed during setup");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start browser peer");
    host = `127.0.0.1:${address.port}`;
    origin = `http://${host}`;
    deadline();
    return {
      url: `${origin}/#token=${token}`,
      offer,
      applyAnswer(sdp) {
        if (closed) return;
        if (!offered || answered || !validSdp(sdp)) { notify("error", "Invalid browser peer answer"); return; }
        answered = send({ type: "answer", sdp });
      },
      sendData(event) { send({ type: "send", event }); },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
