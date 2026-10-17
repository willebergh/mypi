import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderBrowserPage } from "../extensions/talk/browser-page.ts";

function page(token = "a".repeat(43)) {
  const html = renderBrowserPage("nonce_123");
  const script = html.match(/<script nonce="nonce_123">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script);
  assert.match(html, /<style nonce="nonce_123">/);
  assert.match(html, /<script nonce="nonce_123">/);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b[^>]*(?:src|href)=/i);
  const handlers: Record<string, Function> = {};
  const elements: Record<string, any> = Object.fromEntries(["status", "start", "stop", "audio", "speaker"].map(id => [id, {
    id, disabled: false, textContent: "", srcObject: null, paused: false,
    play: async () => {}, pause() { this.paused = true; },
  }]));
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  let resolveMic!: (v: any) => void, micCalls = 0;
  const mic = new Promise<any>(r => { resolveMic = r; });
  const sent: any[] = [], sockets: any[] = [], pcs: any[] = [];
  class WS {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; listeners: any = {};
    onclose: any; onerror: any; onmessage: any;
    url: string; protocols: string[];
    constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols; sockets.push(this); }
    addEventListener(n: string, f: any) { this.listeners[n] = f; }
    send(x: string) { sent.push(JSON.parse(x)); } close() { this.readyState = 3; }
    emit(n: string) { this.listeners[n]?.(); }
  }
  class PC {
    connectionState = "new"; iceGatheringState = "complete"; localDescription: any;
    remote: any; closed = false;
    onconnectionstatechange: any; channel: any;
    constructor() { pcs.push(this); }
    addTrack() {}
    createDataChannel(label: string) { assert.equal(label, "oai-events"); return this.channel = { readyState: "connecting", bufferedAmount: 0, send: (x: string) => sent.push(JSON.parse(x)), close() { this.readyState = "closed"; } }; }
    async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
    async setLocalDescription(x: any) { this.localDescription = x; }
    async setRemoteDescription(x: any) { this.remote = x; }
    addEventListener() {} removeEventListener() {} close() { this.connectionState = "closed"; this.closed = true; }
  }
  const context: any = { URLSearchParams, URL, TextEncoder, setTimeout, clearTimeout,
    location: { hash: `#token=${token}`, pathname: "/talk", host: "localhost" }, history: { replaceState: (...a: any[]) => { context.historyArgs = a; } },
    document: { getElementById: (id: string) => elements[id] }, window: { addEventListener: (n: string, f: Function) => handlers[n] = f },
    WebSocket: WS, RTCPeerConnection: PC, MediaStream: class {}, navigator: { mediaDevices: { getUserMedia: (opts: any) => { micCalls++; context.micOptions = opts; return mic; } } } };
  vm.runInNewContext(script, context);
  return { context, elements, handlers, tracks, sent, sockets, pcs, resolveMic, get micCalls() { return micCalls; } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("browser page relays WebRTC lifecycle and cleans up", async () => {
  const h = page();
  h.elements.start.onclick();
  assert.equal(h.sockets[0].url, "ws://localhost/peer");
  assert.deepEqual(Array.from(h.sockets[0].protocols), ["mypi-talk", "a".repeat(43)]);
  h.sockets[0].emit("open"); await flush();
  assert.equal(h.micCalls, 1);
  assert.equal(h.context.micOptions.audio.echoCancellation, true);
  assert.equal(h.context.micOptions.audio.noiseSuppression, true);
  h.resolveMic({ getTracks: () => h.tracks }); await flush();
  const pc = h.pcs[0], dc = pc.channel;
  assert.ok(h.sent.some(x => x.type === "offer" && x.sdp === "offer-sdp"));
  h.sockets[0].onmessage({ data: JSON.stringify({ type: "answer", sdp: "answer" }) }); await flush();
  assert.equal(pc.remote.type, "answer"); assert.equal(pc.remote.sdp, "answer");
  dc.readyState = "open"; dc.onopen(); pc.connectionState = "connected"; pc.onconnectionstatechange();
  assert.equal(h.sent.filter(x => x.type === "ready").length, 1);
  dc.onmessage({ data: '{"text":"hi"}' });
  assert.deepEqual(h.sent.at(-1), { type: "event", event: { text: "hi" } });
  h.sockets[0].onmessage({ data: JSON.stringify({ type: "send", event: { say: "hi" } }) });
  assert.deepEqual(h.sent.at(-1), { say: "hi" });
  h.elements.stop.onclick();
  assert.equal(pc.closed, true); assert.equal(h.tracks[0].stopped, true);
  assert.equal(h.elements.audio.srcObject, null);
});

test("invalid token skips microphone; late permission and page/server stop clean up", async () => {
  const bad = page("bad"); bad.elements.start.onclick(); await flush(); assert.equal(bad.micCalls, 0);
  for (const stop of [(h: ReturnType<typeof page>) => h.sockets[0].onmessage({ data: '{"type":"stop"}' }), (h: ReturnType<typeof page>) => h.handlers.pagehide()]) {
    const h = page(); h.elements.start.onclick(); h.sockets[0].emit("open"); await flush();
    stop(h); h.resolveMic({ getTracks: () => h.tracks }); await flush();
    assert.equal(h.tracks[0].stopped, true); assert.equal(h.pcs.length, 0);
  }
});

test("speaker playback rejection offers a retry", async () => {
  const h = page();
  h.elements.audio.play = () => Promise.reject(new Error("blocked"));
  h.elements.speaker.onclick(); await flush();
  assert.match(h.elements.status.textContent, /Enable speaker|Speaker is not ready/);
});
