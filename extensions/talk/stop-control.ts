import { randomUUID } from "node:crypto";
import type { LiveDelegation, LiveTranscript } from "./live.ts";

type Role = "user" | "assistant";
export interface TalkStopOperation {
  busy: boolean;
  signal: AbortSignal | undefined;
}
export const TALK_STOP_REQUESTED = "Stop requested; voice remains connected; queued messages returned to editor";
const REFUSED = "This Stop Pi attempt was not verified against fresh speech and current work. No new stop was requested. Use Esc, or say only Stop Pi after voice finishes speaking.";
const MAX_IDS = 4096;
const MAX_SPEECH_BYTES = 512;
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(id);
const normalize = (text: string) => text.toLowerCase().trim().replace(/[.!]+$/u, "").trim().replace(/\s+/gu, " ");
const command = (text: string) => /^(?:stop|stoppa) pi$/u.test(normalize(text));
const stopLike = (text: string) => {
  const value = text.trim();
  // Reject malformed/qualified imperative attempts locally, but do not swallow
  // ordinary project questions such as “Explain how Stop Pi works”.
  return /^["'“‘]?\s*(?:stop|stoppa)\s+(?:inte\s+)?pi\b/iu.test(value) ||
    /^["'“‘]?\s*(?:(?:i|jag)\s+)?(?:don['’]?t|do not|inte|if|om|please|say|säg|can you|could you|would you|kan du|skulle du)\b[\s\S]*\b(?:stop|stoppa)\s+(?:inte\s+)?pi\b/iu.test(value);
};
// Even malformed/quoted/nested reserved controls must never become Pi tasks.
const reserved = (text: string) => /\btalk_stop\b/iu.test(text.replace(/\\u([\da-f]{4})/giu,
  (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))));

/** Per-call, synchronous local control. IDs identify fragments, NOT utterance ends.
 * A native handoff is the commit point for the entire locally captured speech.
 * Unknown identity/overlap fails closed; no timer or history can authorize a stop.
 * operationChanged must also be called at native user consumption, agent start,
 * and settlement: a signal can span several native requests.
 */
export function createTalkStopControl(callbacks: {
  operation(): TalkStopOperation;
  beforeInterrupt?(): void; // Detach owned bridge tracking; never cancel questions.
  interrupt(): void; // Synchronously call ctx.abort(); no await/drain.
  context(text: string): void;
  report(text: string): void;
}) {
  let active = false;
  let closed = false;
  let disabled = false;
  let committing = false;
  let playback = false;
  let assistantTurnId: string | undefined;
  let generation = 0;
  let nonce: string | undefined;
  let operation = callbacks.operation();
  let stoppedSignal: AbortSignal | undefined;
  let userTurnId: string | undefined;
  const fragments = new Set<string>();
  const turns = new Set<string>();
  let speech = "";
  let tainted = false;
  let captured: { generation: number; signal: AbortSignal | undefined; busy: boolean; turnId?: string } | undefined;

  function clear() { speech = ""; tainted = false; captured = undefined; }
  function poison() { speech = ""; tainted = true; }
  function remember(ids: Set<string>, id: string) {
    if (ids.has(id)) return false;
    if (ids.size >= MAX_IDS) {
      disabled = true; // Never evict old IDs and accidentally accept their replay.
      nonce = undefined;
      poison();
      return false;
    }
    ids.add(id);
    return true;
  }
  function announce() {
    if (!active || closed || disabled || committing || nonce ||
        (stoppedSignal && operation.signal === stoppedSignal)) return;
    nonce = randomUUID();
    try {
      callbacks.context(JSON.stringify({ type: "talk.stop", experimental: true,
        reply: { talk_stop: nonce }, commands: ["Stop Pi", "stoppa Pi"],
        instruction: "Only a fresh explicit standalone user command. Silent local handoff; never autonomous. Normal Esc semantics; queued messages return to editor, voice stays connected. Not Undo. If ambiguous use Esc." }));
    } catch { disabled = true; nonce = undefined; poison(); }
  }
  function change(next: TalkStopOperation) {
    const hadSpeech = captured !== undefined || tainted;
    operation = next;
    generation++;
    clear();
    if (hadSpeech) poison(); // A later suffix cannot retarget an in-flight command.
    announce();
  }
  function sync() {
    const next = callbacks.operation();
    if (next.busy !== operation.busy || next.signal !== operation.signal) change(next);
  }
  function playbackStart() {
    if (closed) return;
    playback = true;
    clear();
  }

  return {
    activate() {
      if (active || closed) return;
      clear();
      userTurnId = undefined;
      operation = callbacks.operation();
      active = true;
      announce();
    },
    operationChanged() { if (!closed) change(callbacks.operation()); },
    playbackStart,
    turnStart(role: Role, id: string) {
      if (closed) return;
      if (role === "assistant") {
        playbackStart();
        if (assistantTurnId !== undefined && assistantTurnId !== id) {
          disabled = true; // Overlapping identified playback has no safe boundary.
          nonce = undefined;
        }
        assistantTurnId = validId(id) ? id : undefined;
        return;
      }
      if (!validId(id)) { poison(); return; }
      if (id === userTurnId) return;
      if (!remember(turns, id)) { poison(); return; }
      // The first partial may precede turn.created. Only an unbound buffer can
      // be adopted; never move speech from one known user group into another.
      if (captured?.turnId !== undefined) poison();
      userTurnId = id;
      if (captured && captured.turnId === undefined) captured.turnId = id;
    },
    transcript(role: Role, delta: string, source?: "delta" | "final", metadata?: LiveTranscript) {
      if (closed) return;
      const id = metadata?.itemId;
      // Quarantine observed non-authorizing identities too: relabelling an old
      // assistant/final fragment as a user delta must not make it fresh.
      const fresh = validId(id) && remember(fragments, id);
      if (role === "assistant") { playbackStart(); return; }
      if (source === "final") { clear(); return; }
      sync();
      if (source !== "delta" || !fresh) { poison(); return; }
      if (!active || disabled || committing || playback) { poison(); return; }
      if (!captured) captured = { generation, signal: operation.signal, busy: operation.busy, turnId: userTurnId };
      if (tainted) return;
      if (Buffer.byteLength(speech) + Buffer.byteLength(delta) > MAX_SPEECH_BYTES ||
          Buffer.from(delta).toString("utf8") !== delta) { poison(); return; }
      speech += delta; // No suffix matching, chunk separators, or tail retention.
    },
    turnEnd(role: Role, id?: string) {
      if (closed) return;
      clear();
      if (role === "assistant") {
        // Require the observed start/end pair. Unidentified/final-only output
        // cannot prove playback ended; use Esc if the transport omits it.
        if (assistantTurnId === undefined || id !== assistantTurnId) return;
        playback = false;
        assistantTurnId = undefined;
      } else userTurnId = undefined;
    },
    /** Invoke at EVERY deduplicated native handoff, before question/task routing.
     * true means handled/refused locally; false leaves normal routing untouched.
     */
    delegate(input?: string, metadata?: LiveDelegation): boolean {
      if (!closed) sync();
      const raw = speech;
      const capture = captured;
      const invalid = tainted;
      clear(); // Consume even a normal, missing, malformed or refused handoff.
      const body = input ?? "";
      const isReserved = reserved(body);
      if (!isReserved && !stopLike(body) && !stopLike(raw)) return false;
      const token = /^\s*\{\s*"talk_stop"\s*:\s*"([^"\\]*)"\s*\}\s*$/u.exec(body)?.[1];
      const validBody = isReserved ? nonce !== undefined && token === nonce : command(body);
      const verified = active && !closed && !disabled && !committing && !playback && !invalid &&
        nonce !== undefined && capture !== undefined && command(raw) && validBody &&
        validId(userTurnId) && capture.turnId === userTurnId && metadata?.userTurnId === userTurnId &&
        capture.generation === generation && capture.busy && operation.busy &&
        capture.signal !== undefined && capture.signal === operation.signal && !capture.signal.aborted &&
        capture.signal !== stoppedSignal;
      if (!verified) {
        if (active && !closed && !committing) callbacks.report(REFUSED);
        return true;
      }
      // Invalidate BEFORE any callback: abort can synchronously emit lifecycle,
      // questionnaire cancellation, another delegation, or call shutdown.
      nonce = undefined;
      const commitGeneration = ++generation;
      stoppedSignal = capture.signal;
      committing = true;
      let requested = false;
      let uncertain = false;
      try {
        callbacks.beforeInterrupt?.();
        // Detachment observers can reenter too. Do not abort a replacement run
        // or a closed call if cleanup changed our target before the actual abort.
        const current = callbacks.operation();
        if (active && !closed && generation === commitGeneration && current.busy &&
            current.signal !== undefined && current.signal === capture.signal && !current.signal.aborted) {
          callbacks.interrupt(); // Pi owns Esc queue/editor behavior.
          requested = true;
        }
      } catch {
        // The native action may have partly run. Never retry or claim that
        // nothing happened merely because an abort/cleanup callback threw.
        uncertain = true;
      } finally { committing = false; }
      if (active && !closed) callbacks.report(uncertain
        ? "The stop request could not be confirmed. Voice remains connected; use Esc in Pi and check the terminal."
        : requested ? TALK_STOP_REQUESTED : REFUSED);
      return true;
    },
    close() {
      closed = true;
      active = false;
      nonce = undefined;
      generation++;
      clear();
      fragments.clear();
      turns.clear();
    },
  };
}
