import WebSocket, { type RawData } from "ws";

export interface Transcriber {
  append(pcm: Buffer): void;
  finish(): Promise<string>;
  close(): void;
}

/** Optional fifth argument to openTranscriber; production uses ws. */
export type SocketFactory = (
  url: string,
  options: { headers: Record<string, string>; maxPayload: number },
) => Pick<WebSocket, "on" | "send" | "terminate" | "bufferedAmount">;

const MAX_BUFFER = 512 * 1024;
const MAX_EVENT = 72 * 1024;
const MAX_TRANSCRIPT = 64 * 1024;
const MAX_AUDIO = 120 * 48_000;
const MIN_BYTES = 4_800;
const FINAL_SILENCE_BYTES = 12_000; // 250 ms of PCM24k mono16.
const MAX_SEGMENTS = 1_200;

type Segment = { previous: string | null; text: string; done: boolean };

export async function openTranscriber(
  headers: Record<string, string>,
  signal: AbortSignal,
  onError: (error: Error) => void,
  onTranscript?: (text: string) => void,
  createSocket: SocketFactory = (url, options) => new WebSocket(url, options),
): Promise<Transcriber> {
  return new Promise<Transcriber>((resolve, reject) => {
    let socket: ReturnType<SocketFactory> | undefined;
    let state: "starting" | "recording" | "finishing" | "closed" = "starting";
    let failure: Error | undefined;
    let audioBytes = 0;
    let explicitCommit = false;
    const chunks = new Map<string, Segment>();
    let published = "";
    let result: Promise<string> | undefined;
    let complete: ((text: string) => void) | undefined;
    let rejectFinish: ((error: Error) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function shutdown() {
      state = "closed";
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Keep the error listener installed: ws can emit errors after termination.
      try { socket?.terminate(); } catch { /* Already disconnected. */ }
    }
    function fail(message: string, notify = true) {
      if (state === "closed") return;
      failure = new Error(message);
      shutdown();
      reject(failure);
      rejectFinish?.(failure);
      if (notify) {
        try { onError(failure); } catch { /* Consumer errors must not escape socket events. */ }
      }
    }
    function abort() { fail("Transcription aborted"); }
    function send(event: object): boolean {
      const data = JSON.stringify(event);
      if (!socket || socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFER) {
        fail("Transcription upload buffer limit exceeded");
        return false;
      }
      try {
        socket.send(data, (error) => {
          if (error) fail("Transcription send failed");
        });
        return state !== "closed";
      } catch {
        fail("Transcription send failed");
        return false;
      }
    }

    function segment(id: string) {
      let chunk = chunks.get(id);
      if (!chunk) {
        if (chunks.size >= MAX_SEGMENTS) {
          fail("Transcription segment limit exceeded");
          return undefined;
        }
        // Live deltas can precede the commit acknowledgement. Keep a provisional
        // order until previous_item_id supplies the authoritative relationship.
        const previous = [...chunks.keys()].at(-1) ?? null;
        chunk = { previous, text: "", done: false };
        chunks.set(id, chunk);
      }
      return chunk;
    }
    function ordered() {
      const successors = new Map<string | null, [string, Segment]>();
      for (const entry of chunks) {
        if (!successors.has(entry[1].previous)) successors.set(entry[1].previous, entry);
      }
      const ordered: Segment[] = [];
      let previous: string | null = null;
      const seen = new Set<string>();
      while (true) {
        const entry = successors.get(previous);
        if (!entry || seen.has(entry[0])) break;
        seen.add(entry[0]);
        ordered.push(entry[1]);
        previous = entry[0];
      }
      return ordered;
    }
    function transcript() {
      const parts: string[] = [];
      for (const chunk of ordered()) {
        if (!chunk.text && !chunk.done) break;
        if (chunk.text.trim()) parts.push(chunk.text.trim());
      }
      return parts.join(" ");
    }
    function publish() {
      const cumulative = transcript();
      if (cumulative !== published) {
        published = cumulative;
        try { onTranscript?.(cumulative); } catch { /* Consumer errors must not escape socket events. */ }
      }
    }
    function settle() {
      if (state === "finishing" && !explicitCommit &&
          ordered().length === chunks.size && [...chunks.values()].every((chunk) => chunk.done)) {
        const text = transcript();
        shutdown();
        complete?.(text);
      }
    }

    const transcriber: Transcriber = {
      append(pcm) {
        if (state !== "recording" || pcm.length === 0) return;
        // Check before base64 encoding, so a huge caller buffer is never copied.
        if (pcm.length > Math.floor((MAX_BUFFER - 64) * 3 / 4)) {
          fail("Transcription audio payload limit exceeded");
          return;
        }
        if (audioBytes + pcm.length > MAX_AUDIO) {
          fail("Transcription duration limit exceeded");
          return;
        }
        audioBytes += pcm.length;
        send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
      },
      finish() {
        if (result) return result;
        if (state === "closed") return Promise.reject(failure ?? new Error("Transcriber closed"));
        if (audioBytes === 0) {
          result = Promise.resolve("");
          shutdown();
          return result;
        }
        state = "finishing";
        result = new Promise<string>((resolveFinish, rejectResult) => {
          complete = resolveFinish;
          rejectFinish = rejectResult;
        });
        timer = setTimeout(() => fail("Transcription completion timed out"), 20_000);
        // Live transcription streams without commits. Finalize the single turn
        // on release, after the recorder has drained its last microphone chunks.
        explicitCommit = true;
        // Supply a little acoustic lookahead for short/one-word utterances.
        // Generate silence locally: do not keep the microphone open on release.
        if (!send({
          type: "input_audio_buffer.append",
          audio: Buffer.alloc(Math.max(FINAL_SILENCE_BYTES, MIN_BYTES - audioBytes)).toString("base64"),
        })) return result;
        if (!send({ type: "input_audio_buffer.commit" })) return result;
        settle();
        return result;
      },
      close() { fail("Transcriber closed", false); },
    };

    function receive(raw: RawData) {
      if (state === "closed") return;
      const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (data.length > MAX_EVENT) {
        fail("Transcription event payload limit exceeded");
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data.toString("utf8"));
        if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error();
      } catch {
        fail("Invalid transcription event");
        return;
      }
      if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed" ||
          event.type === "input_audio_transcription.failed") {
        const error = event.error as { code?: string } | undefined;
        if (event.type === "error" && error?.code === "input_audio_buffer_commit_empty" &&
            state === "finishing" && explicitCommit) {
          // Treat an empty final buffer as benign only for our pending commit.
          explicitCommit = false;
          settle();
        } else {
          // Remote messages can echo secrets.
          fail(state === "starting"
            ? "Transcription service error: gpt-live-transcribe setup rejected. Model access with your existing Codex login is not confirmed."
            : "Transcription service error");
        }
      } else if (state === "starting" &&
          (event.type === "session.updated" || event.type === "transcription_session.updated")) {
        clearTimeout(timer);
        state = "recording";
        resolve(transcriber);
      } else if (state === "recording" || state === "finishing") {
        const id = typeof event.item_id === "string" ? event.item_id : undefined;
        if (event.type === "input_audio_buffer.committed") {
          if (!id) return;
          const chunk = segment(id);
          if (!chunk) return;
          if (typeof event.previous_item_id === "string" || event.previous_item_id === null) {
            chunk.previous = event.previous_item_id;
          }
          explicitCommit = false;
          publish();
          settle();
          return;
        }
        const done = event.type === "conversation.item.input_audio_transcription.completed" ||
          event.type === "input_audio_transcription.completed";
        const delta = event.type === "conversation.item.input_audio_transcription.delta" ||
          event.type === "input_audio_transcription.delta";
        if (!done && !delta) return;
        const chunk = id ? segment(id) : undefined;
        if (!chunk || chunk.done) return;
        const text = done ? event.transcript : event.delta;
        if (typeof text !== "string" || Buffer.byteLength(text) > MAX_TRANSCRIPT) {
          fail("Invalid transcription result");
          return;
        }
        const next = done ? text : chunk.text + text;
        const bytes = [...chunks.values()].reduce((total, c) => total + Buffer.byteLength(c === chunk ? next : c.text), 0);
        if (bytes + chunks.size - 1 > MAX_TRANSCRIPT) {
          fail("Invalid transcription result");
          return;
        }
        chunk.text = next;
        chunk.done = done;
        publish();
        settle();
      }
    }

    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => fail("Transcription setup timed out"), 10_000);
    try {
      socket = createSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
        headers, maxPayload: MAX_EVENT,
      });
      socket.on("unexpected-response", (_request, response) => {
        const status = response.statusCode;
        response.resume();
        fail(`Transcription connection rejected (HTTP ${status ?? "unknown"}).${status === 401 || status === 403 ? " OpenAI did not accept your existing Codex login for transcription." : ""}`);
      });
      socket.on("error", () => fail("Transcription connection failed"));
      socket.on("close", () => fail("Transcription connection closed"));
      socket.on("message", receive);
      socket.on("open", () => {
        if (state !== "starting") return;
        send({
          type: "session.update",
          session: {
            type: "transcription",
            audio: { input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model: "gpt-live-transcribe", languages: ["en", "sv"], delay: "low" },
              // This model streams before commit and does not support server VAD.
              turn_detection: null,
            } },
          },
        });
      });
    } catch {
      fail("Transcription connection failed");
    }
  });
}
