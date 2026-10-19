import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { liveServiceError } from "./diagnostics.ts";
import type { TalkVisualPhase } from "./webcam/src/shared/live-protocol.ts";

export interface LiveTurn {
  id: string;
  startMs?: number;
  endMs?: number;
}

export interface LiveDelegation {
  userTurnId?: string;
}

/** Actual ASR fragment identity, independent of authoritative whole-turn IDs. */
export interface LiveTranscript {
  itemId?: string;
}

/** Caption-only source data. Identities are protocol aliases, retained locally only.
 * Fragments append; authoritative finals replace the whole utterance. */
export interface LiveCaption {
  role: "user" | "assistant";
  text: string;
  final: boolean;
  identities: string[];
}

export interface LiveCallbacks {
  onCaption?(caption: LiveCaption): void;
  onAudio(pcm: Buffer): void;
  onTranscript(role: "user" | "assistant", delta: string, startMs: number, endMs: number, source?: "delta" | "final", metadata?: LiveTranscript): void;
  onTurn?(role: "user" | "assistant", text: string, turn?: LiveTurn): void;
  onTurnStart?(role: "user" | "assistant", id: string): void;
  onDelegation(id: string, offsetMs: number, input?: string, metadata?: LiveDelegation): void;
  onConnectUrl?(url: string): void;
  onProgress?(message: string): void;
  /** Structured presentation state; never interpreted as call authorization. */
  onPhase?(phase: TalkVisualPhase): void;
  onError(error: Error): void;
  onClosed(info: { confirmed: boolean; seconds?: number; reason?: string }): void;
}

type CloseInfo = Parameters<LiveCallbacks["onClosed"]>[0];
export interface LiveSession {
  append(pcm: Buffer): void;
  commentary(id: string | null, content: string): void;
  thinking(id: string | null, content: string): void;
  /** Peer audio gate, when supported; does not change the public PCM transport. */
  setAudioEnabled?(enabled: boolean): void;
  close(): Promise<CloseInfo>;
}
export type SocketFactory = (
  url: string,
  options: { headers: Record<string, string>; maxPayload: number },
) => Pick<WebSocket, "on" | "send" | "terminate" | "bufferedAmount">;

const MAX_EVENT = 256 * 1024;
const MAX_BUFFER = 512 * 1024;
const MAX_AUDIO = 192 * 1024;
const CLOSE_REASONS = new Set(["close_requested", "expired", "content", "remote_hangup", "connection_lost"]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
function safely(callback: () => void) {
  try { callback(); } catch { /* Consumer exceptions must not escape socket handlers. */ }
}

export function openLive(
  headers: Record<string, string>,
  signal: AbortSignal,
  callbacks: LiveCallbacks,
  factory: SocketFactory = (url, options) => new WebSocket(url, options),
): Promise<LiveSession> {
  return new Promise((resolve, reject) => {
    let socket: ReturnType<SocketFactory> | undefined;
    let state: "starting" | "active" | "closing" | "closed" = "starting";
    let startSent = false;
    let odd: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishClose!: (info: CloseInfo) => void;
    const closed = new Promise<CloseInfo>((done) => { finishClose = done; });

    function finish(info: CloseInfo, error?: Error) {
      if (state === "closed") return;
      const starting = state === "starting";
      state = "closed";
      odd = undefined;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Keep guarded listeners installed: ws may emit an error after termination.
      try { socket?.terminate(); } catch { /* Already disconnected. */ }
      if (starting) reject(error ?? new Error("Live session closed before startup"));
      finishClose(info);
      if (error) safely(() => callbacks.onError(error));
      safely(() => callbacks.onClosed(info));
    }
    function fail(reason: string) { finish({ confirmed: false, reason }, new Error(reason)); }
    function abort() { fail("Live session aborted"); }
    function send(event: object) {
      if (state === "closed") return;
      const data = JSON.stringify(event);
      if (!socket || socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER) {
        fail("Live upload buffer limit exceeded");
        return;
      }
      try {
        socket.send(data, (error) => { if (error) fail("Live send failed"); });
      } catch { fail("Live send failed"); }
    }
    function context(type: string, id: string | null, content: string) {
      // Reject rather than silently changing backend results, including multibyte text.
      if (id !== null && !validId(id)) throw new Error("Invalid Live delegation ID");
      if (typeof content !== "string" || Buffer.byteLength(content) > 450 || Buffer.from(content).toString("utf8") !== content) {
        throw new Error("Live context must be valid UTF-8 and at most 450 bytes");
      }
      if (state === "active") send({ type, event_id: randomUUID(), delegation_id: id, content });
    }
    const session: LiveSession = {
      append(pcm) {
        if (state !== "active" || !pcm.length) return;
        if (pcm.length > MAX_AUDIO) { fail("Live audio payload limit exceeded"); return; }
        const bytes = odd === undefined ? pcm : Buffer.concat([Buffer.from([odd]), pcm]);
        const length = bytes.length - bytes.length % 2;
        odd = length < bytes.length ? bytes[length] : undefined;
        if (length) send({ type: "session.input_audio.append", audio: bytes.subarray(0, length).toString("base64") });
      },
      commentary(id, content) { context("session.commentary.append", id, content); },
      thinking(id, content) { context("session.thinking.append", id, content); },
      close() {
        if (state === "active") {
          state = "closing";
          odd = undefined; // A trailing half-sample cannot be sent as PCM16.
          timer = setTimeout(() => fail("Live close timed out"), 15_000);
          send({ type: "session.close" });
        }
        return closed;
      },
    };

    function receive(raw: RawData) {
      if (state === "closed") return;
      const size = Array.isArray(raw) ? raw.reduce((n, chunk) => n + chunk.length, 0) : raw.byteLength;
      if (size > MAX_EVENT) { fail("Live event payload limit exceeded"); return; }
      let event: Record<string, unknown>;
      try {
        const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        const parsed: unknown = JSON.parse(data.toString("utf8"));
        if (!record(parsed) || typeof parsed.type !== "string") throw new Error();
        event = parsed;
      } catch { fail("Invalid Live event"); return; }
      if (event.type === "error") {
        fail(liveServiceError(event.error, headers, state === "starting" ? "startup" : state));
      } else if (event.type === "session.started" && state === "starting" && startSent) {
        clearTimeout(timer);
        state = "active";
        resolve(session);
      } else if (event.type === "session.closed") {
        const seconds = record(event.usage) ? event.usage.seconds : undefined;
        finish({ confirmed: true,
          ...(timestamp(seconds) ? { seconds } : {}),
          ...(typeof event.reason === "string" && CLOSE_REASONS.has(event.reason) ? { reason: event.reason } : {}),
        });
      } else if (state === "active" || state === "closing") {
        if (event.type === "session.output_audio.delta") {
          const delta = event.delta;
          if (typeof delta !== "string" || delta.length > MAX_AUDIO * 4 / 3 ||
              delta.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(delta)) {
            fail("Invalid Live audio"); return;
          }
          const pcm = Buffer.from(delta, "base64");
          if (pcm.length % 2 || pcm.toString("base64") !== delta) { fail("Invalid Live audio"); return; }
          safely(() => callbacks.onAudio(pcm));
        } else if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
          const { delta, start_ms: start, end_ms: end } = event;
          if (typeof delta !== "string" || Buffer.byteLength(delta) > 16 * 1024 || Buffer.from(delta).toString("utf8") !== delta ||
              !timestamp(start) || !timestamp(end) || end < start) {
            fail("Invalid Live transcript"); return;
          }
          // Public Live deltas have no unambiguous protocol ASR item ID; never infer one.
          safely(() => callbacks.onTranscript(event.type === "session.input_transcript.delta" ? "user" : "assistant", delta, start, end));
        } else if (event.type === "session.delegation.created") {
          const delegation = event.delegation;
          if (!record(delegation) || delegation.target !== "client") return;
          if (!validId(delegation.id) || !timestamp(event.offset_ms)) { fail("Invalid Live delegation"); return; }
          const id = delegation.id, offset = event.offset_ms;
          const metadata: LiveDelegation | undefined = validId(delegation.user_bidi_turn_id)
            ? { userTurnId: delegation.user_bidi_turn_id }
            : undefined;
          safely(() => metadata
            ? callbacks.onDelegation(id, offset, undefined, metadata)
            : callbacks.onDelegation(id, offset));
        }
      }
    }

    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => fail("Live setup timed out"), 10_000);
    try {
      socket = factory("wss://api.openai.com/v1/live/sessions", { headers, maxPayload: MAX_EVENT });
      socket.on("error", () => fail("Live connection failed"));
      socket.on("close", () => fail("Live connection closed without confirmation"));
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode;
        response.resume();
        fail(`Live connection rejected (HTTP ${Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : "unknown"})`);
      });
      socket.on("message", receive);
      socket.on("open", () => {
        if (state !== "starting" || startSent) return;
        startSent = true;
        send({ type: "session.start", session: {
          model: "gpt-live-1",
          instructions: "Be a concise conversational assistant in English or Swedish. Delegate all project and tool requests to the Pi backend. Never claim actions or success before verified backend results.",
          audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
          delegation: { type: "client" }, store: false,
        } });
      });
    } catch { fail("Live connection failed"); }
  });
}
