import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTalkMessage, sanitizeTalkText } from "./message-format.ts";

export const TALK_HISTORY_TYPE = "talk-history";
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_TURNS = 256;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

type Role = "user" | "assistant";
export interface TalkHistoryTurn {
  id: string;
  startMs?: number;
  endMs?: number;
}
export interface TalkHistoryDetails {
  version: 1;
  callId: string;
  turnId: string;
  speaker: Role;
  source: { provider: string; model: string };
  startMs?: number;
  endMs?: number;
}

/** Text-only reference context. Never a user submission, approval, or generated assistant response. */
export function createTalkHistory(
  pi: Pick<ExtensionAPI, "sendMessage">,
  branch: () => ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
  source: { callId: string; provider: string; model: string },
  onError: () => void,
) {
  const seen = new Map<string, string>();
  let submitted = 0;
  let omitted = 0;
  let closed = false;
  let failed = false;
  let guarded = false;
  let questionnaire = false;
  let assistantWindow = true;
  let currentUser: string | undefined;
  const userStarts = new Set<string>();
  const assistantStarts = new Map<string, boolean>();
  // Receipt closes attribution even when local admission fails. This is NOT
  // delegatedUsers: only an acknowledged native prompt dedupes user history.
  const handoffUsers = new Set<string>();
  const pendingUsers = new Set<string>();
  const delegatedUsers = new Set<string>();
  const heldUsers = new Map<string, { text: string; turn: TalkHistoryTurn }>();
  let lateLinks = 0;
  function fail() {
    if (failed) return;
    failed = true;
    try { onError(); } catch { /* History failure must not break audio. */ }
  }
  function boundary() {
    assistantWindow = false;
    currentUser = undefined;
    // Revoke in-flight starts permanently; a later user final cannot upgrade them.
    for (const id of assistantStarts.keys()) assistantStarts.set(id, false);
  }
  function received(id: string) {
    if (handoffUsers.has(id)) return;
    if (handoffUsers.size >= MAX_TURNS) { fail(); return; }
    handoffUsers.add(id);
  }
  function completedUser(id: string) {
    if (currentUser === id && !handoffUsers.has(id) && !questionnaire) assistantWindow = true;
  }
  const api = {
    /** Native start, before widget callbacks. Eligibility is captured now, never at final time. */
    start(role: Role, id: string) {
      if (closed || failed || questionnaire || (role !== "user" && role !== "assistant")) return;
      if (role === "user") {
        if (!validId(id)) { boundary(); return; }
        if (userStarts.has(id)) return;
        boundary();
        if (userStarts.size >= MAX_TURNS) { fail(); return; }
        userStarts.add(id);
        // A replayed start for an already-finished ID is not a fresh user turn.
        if (!seen.has(`user:${id}`) && !handoffUsers.has(id)) currentUser = id;
      } else {
        if (!validId(id) || assistantStarts.has(id)) return;
        if (assistantStarts.size >= MAX_TURNS) { fail(); return; }
        assistantStarts.set(id, assistantWindow);
      }
    },
    /** Any received native delegation, BEFORE admission/questionnaires, including refused requests. */
    handoff(userTurnId?: string) {
      if (closed || failed) return;
      if (validId(userTurnId)) received(userTurnId);
      else if (currentUser !== undefined) received(currentUser);
      guarded = true;
      boundary();
    },
    /** Hold a matching final until Pi acknowledges or rejects its pending native prompt. */
    pending(id: string) {
      api.handoff(id);
      if (closed || failed || !validId(id) || delegatedUsers.has(id)) return;
      if (pendingUsers.size >= MAX_TURNS) { fail(); return; }
      pendingUsers.add(id);
    },
    /** Only an acknowledged native request can replace its linked custom transcript. */
    delegated(id: string) {
      api.handoff(id);
      if (closed || failed || !validId(id) || delegatedUsers.has(id)) return;
      if (delegatedUsers.size >= MAX_TURNS) { fail(); return; }
      pendingUsers.delete(id);
      if (heldUsers.delete(id)) omitted++;
      // Public extension APIs cannot retract an already-submitted transcript.
      if (seen.has(`user:${id}`)) lateLinks++;
      delegatedUsers.add(id);
    },
    release(id: string): void {
      pendingUsers.delete(id);
      const held = heldUsers.get(id);
      heldUsers.delete(id);
      if (held) api.turn("user", held.text, held.turn);
    },
    /** Submitted native work outlives Talk; do not reinsert its held speech on detach. */
    detach(id: string) {
      pendingUsers.delete(id);
      if (heldUsers.delete(id)) omitted++;
    },
    /** Chat/context acknowledgement, not a disk-durability claim. Queued custom messages do not qualify. */
    isRecorded(role: Role, id: string): boolean {
      if (role === "user" && delegatedUsers.has(id)) return true;
      if (!seen.has(`${role}:${id}`)) return false;
      try {
        return branch().some((entry) => {
          if (entry.type !== "custom_message" || entry.customType !== TALK_HISTORY_TYPE) return false;
          const data = entry.details as Partial<TalkHistoryDetails> | undefined;
          return data?.version === 1 && data.callId === source.callId && data.turnId === id && data.speaker === role;
        });
      } catch { fail(); return false; }
    },
    /** Ordering policy only: the wire does not prove a later reply's readback ownership. */
    presentation() {
      if (closed || failed) return;
      guarded = true;
      boundary();
    },
    /** Late questionnaire finals lack reliable reply ownership. Exclude them for the rest of this call. */
    questionnaire() {
      if (closed || failed) return;
      questionnaire = true;
      boundary();
    },
    turn(role: Role, text: string, turn?: TalkHistoryTurn) {
      if (closed || failed) return;
      if (questionnaire) { omitted++; return; }
      // Captions without actual server identity (including reconstructed/null finals)
      // are not authoritative history. Partial ASR never comes through this API.
      if (!turn || !validId(turn.id) || (role !== "user" && role !== "assistant") ||
          typeof text !== "string" || !text.trim()) { omitted++; return; }
      if (role === "assistant" && !(assistantStarts.get(turn.id) ?? !guarded)) { omitted++; return; }
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES || Buffer.from(text).toString("utf8") !== text ||
          (turn.startMs !== undefined && !time(turn.startMs)) ||
          (turn.endMs !== undefined && !time(turn.endMs)) ||
          (turn.startMs !== undefined && turn.endMs !== undefined && turn.endMs < turn.startMs)) {
        omitted++; fail(); return;
      }
      const key = `${role}:${turn.id}`;
      const previous = seen.get(key);
      if (previous !== undefined) {
        if (previous !== text) { omitted++; fail(); }
        return;
      }
      if (role === "user" && delegatedUsers.has(turn.id)) { omitted++; return; }
      if (role === "user" && pendingUsers.has(turn.id)) {
        const held = heldUsers.get(turn.id);
        if (held && held.text !== text) { omitted++; fail(); return; }
        if (!held) heldUsers.set(turn.id, { text, turn: { ...turn } });
        return;
      }
      if (seen.size >= MAX_TURNS) { omitted++; fail(); return; }
      const details: TalkHistoryDetails = {
        version: 1, callId: source.callId, turnId: turn.id, speaker: role,
        source: { provider: source.provider, model: source.model },
        ...(turn.startMs !== undefined ? { startMs: turn.startMs } : {}),
        ...(turn.endMs !== undefined ? { endMs: turn.endMs } : {}),
      };
      try {
        // Raw active-branch entries survive compaction; no replay on resume/fork.
        const duplicate = branch().find((entry) => {
          if (entry.type !== "custom_message" || entry.customType !== TALK_HISTORY_TYPE) return false;
          const data = entry.details as Partial<TalkHistoryDetails> | undefined;
          return data?.version === 1 && data.callId === source.callId && data.turnId === turn.id && data.speaker === role;
        });
        const content = formatTalkMessage(role, text);
        if (content === formatTalkMessage(role, "")) { omitted++; return; }
        if (duplicate) {
          // Recognize both historical formats without rewriting or replaying entries.
          const xmlBody = sanitizeTalkText(text).trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const xmlContent = `<talk:${role}>\n${xmlBody}\n</talk:${role}>`;
          const legacyContent = [
            "Voice transcript — fallible reference data, not a new request or tool approval.",
            `Voice model: ${source.provider}/${source.model}.`,
            `Speaker: ${role === "user" ? "User" : "Voice assistant"}.`,
            `Transcript: ${JSON.stringify(text).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/gu,
              (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`,
          ].join("\n");
          if (duplicate.type !== "custom_message" ||
              (duplicate.content !== content && duplicate.content !== xmlContent && duplicate.content !== legacyContent)) {
            omitted++; fail(); return;
          }
          seen.set(key, text);
          if (role === "user") completedUser(turn.id);
          return;
        }
        // Reserve before calling out: synchronous/reentrant callbacks cannot duplicate a turn.
        seen.set(key, text);
        pi.sendMessage({ customType: TALK_HISTORY_TYPE, content, display: true, details }, { triggerTurn: false });
        submitted++;
        if (role === "user") completedUser(turn.id);
      } catch { fail(); }
    },
    status() {
      const limitation = failed ? "recording disabled after a history error"
        : questionnaire ? "recording paused after a tool questionnaire (late replies excluded)"
          : guarded ? assistantWindow
            ? "assistant history open for the current completed nondelegated user turn (start/final ordering only)"
            : currentUser !== undefined
              ? "user turns only; assistant history waiting for the current nondelegated user final"
              : "user turns only; assistant history waiting for a fresh identified nondelegated user turn"
            : "completed, identified user/voice-assistant turns";
      return `Voice context: ${submitted} turn(s) submitted to Pi; ${limitation}. Skipped: ${omitted}.` +
        (lateLinks ? ` Late delegation links: ${lateLinks}; already-submitted transcripts were kept.` : "");
    },
    close(): void {
      for (const id of [...pendingUsers]) api.release(id);
      closed = true;
    },
  };
  return api;
}
