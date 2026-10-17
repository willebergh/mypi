import { Buffer } from "node:buffer";
import { parseTalkReply } from "./replies.ts";

const INSTRUCTION = "Start this new task? Say Yes or No.";
const FALLBACK = "Local voice confirmation could not accept this request; it did not reach the coding agent. Please send the task in Pi's terminal. No work was started.";
const MAX_PROMPT_BYTES = 450;
const TIMEOUT_MS = 120_000;
// With /u, valid surrogate pairs are allowed, but lone surrogates are not.
const unsafe = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
type Task = { id: string; offset: number; input: string };
type Pending = { task: Task; prompt: string; timer?: ReturnType<typeof setTimeout> };

/** Only a later, explicit final user answer may release a proposed task. */
export function createTalkTaskConfirmation(callbacks: {
  speak(text: string): void;
  changed(): void;
  confirmed(task: Task): void;
  interrupted?(text: string): void;
}): {
  propose(id: string, offset: number, input: string): void;
  answer(text: string): boolean;
  cancel(): void;
  readonly pending: boolean;
  view(): string[];
} {
  let active: Pending | undefined;
  let notifying = 0;
  const guarded = (fn: () => void): boolean => {
    notifying++;
    try { fn(); return true; }
    catch { return false; }
    finally { notifying--; }
  };
  const finish = (state: Pending, confirm = false, interruption?: string) => {
    if (active !== state) return;
    active = undefined;
    clearTimeout(state.timer);
    // No callback can create/approve a replacement, even during teardown.
    guarded(() => {
      callbacks.changed();
      if (confirm) callbacks.confirmed({ ...state.task });
      else if (interruption) callbacks.interrupted?.(interruption);
    });
  };
  const publish = (state: Pending, text: string) => {
    const ok = guarded(() => {
      callbacks.speak(text);
      if (active === state) callbacks.changed();
    });
    if (!ok) finish(state);
  };
  const fallback = () => {
    guarded(() => {
      callbacks.speak(FALLBACK);
      callbacks.changed();
    });
  };

  return {
    propose(id, offset, input) {
      if (notifying || active) return;
      if (typeof id !== "string" || !id.trim() || unsafe.test(id) ||
        // The wire uses performance.now(): millisecond offsets are fractional.
        !Number.isFinite(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER ||
        typeof input !== "string" || !input.trim() || unsafe.test(input.replace(/[\n\t]/gu, ""))) {
        fallback();
        return;
      }
      const prompt = `${input}\n${INSTRUCTION}`;
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
        fallback();
        return;
      }
      const state: Pending = { task: { id, offset, input }, prompt };
      active = state;
      // A fixed deadline: repeats, duplicates, and unrelated speech cannot extend consent.
      state.timer = setTimeout(() => finish(state), TIMEOUT_MS);
      state.timer.unref?.();
      publish(state, prompt);
    },
    answer(text) {
      const state = active;
      if (!state) return false;
      if (notifying) return true;
      if (typeof text !== "string" || unsafe.test(text.replace(/[\n\t]/gu, "")) || Buffer.byteLength(text) > 4096) {
        finish(state);
        fallback();
        return true;
      }
      if (!text.trim()) return true;
      const reply = parseTalkReply(text);
      if (reply.kind === "confirm" && !reply.remainder) finish(state, true);
      else if ((reply.kind === "reject" || reply.kind === "cancel") && !reply.remainder) finish(state);
      else if (reply.kind === "repeat") publish(state, state.prompt);
      else if (reply.kind === "keyboard") { finish(state); fallback(); }
      // A new topic or qualified approval cancels this proposal, never executes
      // it and never traps the user in an endless exact-Yes/No loop.
      else finish(state, false, text);
      return true;
    },
    cancel() { if (active) finish(active); },
    get pending() { return active !== undefined; },
    view() { return active ? [active.task.input, INSTRUCTION] : []; },
  };
}
