import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { heardSpeechSuffix } from "./heard-speech.ts";

const MAX_INPUT_BYTES = 4096 + 64;
const MAX_WIRE_BYTES = 8192;
const normalizeReadback = (text: string) => text.normalize("NFKC").toLowerCase()
  .replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
type Role = "user" | "assistant";
type Phase = "answer" | "confirm" | undefined;
type Target = {
  readonly pending: boolean;
  readonly phase: Phase;
  answer(text: string): boolean;
  cancel(): void;
  view(): string[];
};

/** Delegations commit verified heard speech, never model-supplied answers. Wire both
 * transcript and turn globally; user finals are intentionally not a source.
 * The lazy target also supports helpers that publish during propose/ask.
 */
export function createTalkReplyChannel(
  replyKey: "talk_answer" | "talk_task_answer",
  target: () => Target,
  callbacks: { speak(text: string): void; context(text: string): void; changed(): void },
) {
  const label = replyKey === "talk_answer" ? "Question" : "Task";
  const type = replyKey === "talk_answer" ? "talk.question" : "talk.task_confirmation";
  const IGNORED = "Waiting for a voice reply matching heard speech.";
  const keyPattern = new RegExp(`"${replyKey}"\\s*:`, "u");
  let commits = 0;
  let ignoredReplies = 0;
  let token: string | undefined;
  let raw = "";
  let overflow = false;
  let assistantTurnActive = false;
  let oldAssistant = false;
  let readbackStarted = false;
  let expectedPrompt = "";
  let confirmationReady = false;
  let diagnostic = "";
  let callbackDepth = 0;
  const clearInput = () => { raw = ""; overflow = false; };
  const reset = () => {
    token = undefined;
    clearInput();
    oldAssistant = readbackStarted = confirmationReady = false;
    expectedPrompt = "";
    diagnostic = "";
  };
  const notify = (fn: () => void) => {
    callbackDepth++;
    try { fn(); } finally { callbackDepth--; }
  };
  const changed = () => notify(() => callbacks.changed());
  const onPrompt = (text: string, phase: Phase) => {
    if (!target().pending) {
      // Helper fallback notices are not confirmation prompts.
      notify(() => callbacks.speak(text));
      return;
    }
    const generation = randomUUID();
    token = generation;
    clearInput();
    diagnostic = "";
    oldAssistant = assistantTurnActive;
    expectedPrompt = phase === "confirm" ? normalizeReadback(text) : "";
    readbackStarted = confirmationReady = false;
    notify(() => {
      callbacks.context(JSON.stringify({ type, token: generation, phase, mode: "spoken-reply" }));
      // Context may cancel; never speak a stale prompt (or a fallback as consent).
      if (target().pending && token === generation) callbacks.speak(text);
    });
    if (!target().pending) reset();
  };
  const onChanged = () => {
    if (!target().pending) reset();
    changed();
  };
  const ignored = () => {
    ignoredReplies++;
    if (target().pending) {
      diagnostic = IGNORED;
      if (!callbackDepth) {
        try { changed(); } catch { /* Diagnostics cannot strand the source. */ }
      }
    }
    return true;
  };

  return {
    onPrompt, onChanged,
    transcript(role: Role, delta: string) {
      if (role === "assistant") {
        const starting = !assistantTurnActive;
        assistantTurnActive = true;
        if (!callbackDepth && target().phase === "confirm" && !oldAssistant && starting && delta) {
          readbackStarted = true;
        }
        return;
      }
      if (role !== "user" || callbackDepth || !target().pending || !token || overflow) return;
      if (Buffer.byteLength(raw) + Buffer.byteLength(delta) > MAX_INPUT_BYTES) {
        raw = "";
        overflow = true; // Reject ordinary handoffs; legacy commits retain atomic fallback.
      } else raw += delta;
      diagnostic = "";
      try { changed(); } catch { /* Streaming UI failure cannot commit input. */ }
    },
    turn(role: Role, text: string) {
      if (role !== "assistant") return; // Late/corrected user finals never cross generations.
      assistantTurnActive = false;
      const started = readbackStarted;
      readbackStarted = false; // An unrelated final cannot qualify a later startless final.
      if (oldAssistant) { oldAssistant = false; return; }
      if (!callbackDepth && target().phase === "confirm" && started && !confirmationReady &&
          expectedPrompt && normalizeReadback(text) === expectedPrompt) {
        clearInput(); // Discard premature or same-utterance Yes.
        confirmationReady = true;
        diagnostic = "";
        try { changed(); } catch { /* UI failure is not approval. */ }
      }
    },
    delegate(input: string) {
      // Reserved legacy replies must never escape as project tasks, even idle.
      // Ordinary delegations while pending are always local attempted replies.
      if (typeof input !== "string") return target().pending ? ignored() : false;
      const reserved = keyPattern.test(input);
      const bytes = Buffer.byteLength(input);
      if (bytes > MAX_WIRE_BYTES || (reserved && bytes > MAX_INPUT_BYTES)) {
        return reserved || target().pending ? ignored() : false;
      }
      let value: unknown;
      try { value = JSON.parse(input); } catch { /* Plain spoken reply. */ }
      const reply = value && typeof value === "object" && !Array.isArray(value) &&
        Object.hasOwn(value, replyKey) ? value as Record<string, unknown> : undefined;
      if (reserved || reply) {
        if (!reply || Object.keys(reply).length !== 1 || typeof reply[replyKey] !== "string" ||
            !target().pending || reply[replyKey] !== token) return ignored();
      } else if (!target().pending) return false;
      if (callbackDepth || !token || (!overflow && !raw.trim()) ||
          (target().phase === "confirm" && !confirmationReady)) return ignored();
      const actual = reply ? (overflow ? "x".repeat(MAX_INPUT_BYTES + 1) : raw) :
        overflow ? undefined : heardSpeechSuffix(raw, input);
      if (actual === undefined) return ignored();
      // Relinquish ownership before source callbacks can publish/reenter.
      token = undefined;
      clearInput();
      diagnostic = "";
      commits++; // Visible before source callbacks can reenter.
      if (!target().answer(actual)) commits--;
      return true;
    },
    cancel() { target().cancel(); },
    get commits() { return commits; },
    get ignored() { return ignoredReplies; },
    get pending() { return target().pending; },
    view() {
      if (!target().pending) return [];
      const state = target().phase === "confirm" && !confirmationReady ? "waiting for readback to finish" :
        raw.trim() || overflow ? "heard reply; waiting for voice handoff" : "listening";
      return [...target().view(), `${diagnostic ? diagnostic + " " : ""}${label} ${target().phase}: ${state}`];
    },
  };
}
