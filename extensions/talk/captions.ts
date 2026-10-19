import type { LiveCaption } from "./live.ts";
import { sanitizeTranscriptText } from "./webcam-transcript.ts";
import { LIVE_CAPTION_FINAL_MS, LIVE_CAPTION_PARTIAL_MS, LIVE_CAPTION_MAX_TEXT,
  type LiveCaptionLine, type LiveCaptions } from "./webcam/src/shared/live-protocol.ts";

type Entry = { keys: Set<string>; turnKey?: string; raw: string; line: LiveCaptionLine };
/** One reducer per voice run. No history reads/writes, audio, approvals or timers.
 * Ambiguous/unidentified fragments are omitted, never attributed by speaker alone. */
export function createTalkCaptions(runId: string, now = Date.now): {
  gate(enabled: boolean): void;
  start(role: LiveCaption['role'], id: string): void;
  update(event: LiveCaption): void;
  snapshot(): LiveCaptions;
} {
  const entries = new Map<LiveCaption['role'], Entry>();
  const retired = new Set<string>();
  let enabled = false, exhausted = false, serial = 0;
  function retire(keys: Iterable<string>) {
    for (const key of keys) {
      if (retired.size >= 1024) { exhausted = true; entries.clear(); return; }
      retired.add(key);
    }
  }
  function clear() {
    for (const entry of entries.values()) retire(entry.keys);
    entries.clear();
  }
  function expire() {
    const at = now();
    for (const [role, entry] of entries) if (entry.line.expiresAt <= at) {
      retire(entry.keys);
      entries.delete(role);
    }
  }
  return {
    gate(value) { if (!value) clear(); enabled = value; },
    start(role, id) {
      expire();
      const key = `${role}:turn:${id}`;
      if (!enabled || exhausted || retired.has(key)) { retire([key]); return; }
      const entry = entries.get(role);
      if (entry?.turnKey === key) return;
      // The transport can announce the turn after its first identified item.
      if (entry && !entry.turnKey && !entry.line.final) {
        entry.turnKey = key; entry.keys.add(key); return;
      }
      if (entry) retire(entry.keys);
      const at = now();
      entries.set(role, { keys: new Set([key]), turnKey: key, raw: '',
        line: { id: `cc-${++serial}`, speaker: role, text: '', final: false,
          updatedAt: at, expiresAt: at + LIVE_CAPTION_PARTIAL_MS } });
    },
    update(event) {
      expire();
      if (!event.final && !event.text) return;
      const keys = new Set(event.identities);
      if (!keys.size || exhausted) return;
      if (!enabled || [...keys].some(key => retired.has(key))) { retire(keys); return; }
      let entry = entries.get(event.role);
      const turnKeys = [...keys].filter(key => key.startsWith(`${event.role}:turn:`));
      if (entry?.turnKey && !entry.line.final && turnKeys.some(key => key !== entry.turnKey)) {
        // An explicit different turn cannot borrow a current item's alias or
        // displace a live announced turn. Wait for its own turn.created edge.
        return;
      }
      // turn.created scopes subsequent item fragments, but an explicitly
      // different turn is never relabelled with the current turn's identity.
      const matches = entry && ([...keys].some(key => entry!.keys.has(key))
        || (!event.final && entry.turnKey && !entry.line.final && !turnKeys.length));
      if (entry && !matches) {
        // A late unrelated final cannot consume a newer live fragment. Distinct
        // fresh fragments replace this speaker; never concatenate across items.
        if (event.final && !entry.line.final) { retire(keys); return; }
        retire(entry.keys);
        entries.delete(event.role);
        entry = undefined;
      }
      if (!entry) {
        entry = { keys, turnKey: turnKeys[0], raw: '', line: { id: `cc-${++serial}`, speaker: event.role,
          text: '', final: false, updatedAt: 0, expiresAt: 0 } };
        entries.set(event.role, entry);
      }
      for (const key of keys) entry.keys.add(key);
      // Full final corrections replace, including authoritative empty text.
      // Keep the complete bounded source until sanitation so split ANSI/OSC and
      // credentials cannot escape merely by crossing a fragment boundary.
      const raw = event.final ? event.text : entry.raw + event.text;
      if (Buffer.byteLength(raw) > 16 * 1024) {
        retire(entry.keys); entries.delete(event.role); return;
      }
      entry.raw = raw;
      const at = now();
      entry.line = { ...entry.line,
        text: sanitizeTranscriptText(raw, LIVE_CAPTION_MAX_TEXT).replace(/\s+/gu, ' ').trim(),
        final: event.final, updatedAt: at,
        expiresAt: at + (event.final ? LIVE_CAPTION_FINAL_MS : LIVE_CAPTION_PARTIAL_MS) };
      if (event.final) { retire(entry.keys); entry.raw = ''; }
    },
    snapshot() {
      expire();
      return { runId, lines: enabled && !exhausted ? [...entries.values()]
        .filter(entry => entry.line.text).map(entry => ({ ...entry.line })) : [] };
    },
  };
}
