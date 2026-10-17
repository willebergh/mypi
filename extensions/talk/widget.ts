import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Role = "user" | "assistant";
type Info = { state: "starting" | "active" | "closing"; progress?: string; browserUrl?: string; elapsedMs?: number; showStatus?: boolean };
type EscapeState = "text" | "escape" | "intermediate" | "csi" | "string" | "stringEscape";
const MAX_TEXT = 2048;

function formatElapsed(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.floor(Math.max(0, elapsedMs) / 1000) : 0;
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  return `${minutes >= 60 ? `${pad(Math.floor(minutes / 60))}:` : ""}${pad(minutes % 60)}:${pad(seconds % 60)}`;
}

// Stateful so an escape sequence split across caption deltas never becomes text.
function caption(keepTail = false) {
  let state: EscapeState = "text";
  let text = "";
  let clipped = false;
  return {
    append(input: string) {
      for (const char of input) {
        const code = char.codePointAt(0)!;
        if (state === "string" || state === "stringEscape") {
          if (char === "\x07" || char === "\x9c" || (state === "stringEscape" && char === "\\")) state = "text";
          else state = char === "\x1b" ? "stringEscape" : "string";
          continue;
        }
        if (char === "\x1b") { state = "escape"; continue; }
        if (char === "\x9b") { state = "csi"; continue; }
        if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { state = "string"; continue; }
        if (state === "escape") {
          if (char === "[") state = "csi";
          else if ("]PX^_".includes(char)) state = "string";
          else state = code >= 0x20 && code <= 0x2f ? "intermediate" : "text";
          continue;
        }
        if (state === "intermediate") {
          if (code >= 0x30 && code <= 0x7e) state = "text";
          continue;
        }
        if (state === "csi") {
          if (code >= 0x40 && code <= 0x7e) state = "text";
          continue;
        }
        if ((code < 32 && char !== "\n" && char !== "\t") || (code >= 0x7f && code <= 0x9f)) continue;
        if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u.test(char)) continue;
        const safe = char === "\t" ? " " : char === "\u2028" || char === "\u2029" ? "\n" : char;
        if (keepTail) {
          text += safe;
          if (text.length > MAX_TEXT) {
            let start = text.length - MAX_TEXT;
            // Never retain the low half of a code point at the tail boundary.
            if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
            text = text.slice(start);
            clipped = true;
          }
        } else if (text.length + safe.length <= MAX_TEXT && !clipped) text += safe;
        else clipped = true;
      }
    },
    value: () => text,
    clipped: () => clipped,
  };
}

function clean(text: string): string {
  const value = caption();
  value.append(text);
  return value.value();
}

/** Ephemeral captions only: no session history, persistence, or Pi API calls. */
export function createTalkWidget(): {
  start(role: Role, turnId: string): void;
  append(role: Role, delta: string): void;
  finish(role: Role, text: string, turnId?: string): void;
  removeRecorded(isRecorded: (role: Role, turnId: string) => boolean): void;
  render(width: number, theme: Pick<Theme, "fg" | "bold">, info: Info): string[];
} {
  type Entry = { role: Role; live: boolean; hidden: boolean; caption: ReturnType<typeof caption>; turnId?: string };
  let entries: Entry[] = [];
  const pending = new Map<Role, Entry>();
  // Retain one completion ID per speaker even after its caption is replaced/cleared.
  const lastCompleted = new Map<Role, string>();
  function createLive(role: Role, turnId?: string): Entry {
    const entry: Entry = { role, live: true, hidden: false, caption: caption(true), turnId };
    pending.set(role, entry);
    entries = entries.filter((item) => item.role !== role);
    entries.push(entry);
    return entry;
  }
  return {
    start(role, turnId) {
      if (lastCompleted.get(role) === turnId) return;
      const entry = pending.get(role);
      // The first partial can precede turn.created; bind it without resetting text
      // or visibility. A different identified turn replaces only this speaker.
      if (entry && (entry.turnId === undefined || entry.turnId === turnId)) entry.turnId = turnId;
      else createLive(role, turnId);
    },
    append(role, delta) {
      if (!delta) return;
      const entry = pending.get(role) ?? createLive(role);
      entry.caption.append(delta);
    },
    finish(role, text, turnId) {
      // A repeated/stale completion must not consume a newer identified turn.
      const entry = pending.get(role);
      if (turnId !== undefined && entry?.turnId !== undefined && entry.turnId !== turnId) return;
      const completedId = turnId ?? entry?.turnId;
      if (completedId !== undefined && lastCompleted.get(role) === completedId) return;
      if (completedId !== undefined) lastCompleted.set(role, completedId);
      const final = caption();
      final.append(text);
      pending.delete(role);
      if (!final.value().trim()) {
        if (entry) entries = entries.filter((item) => item !== entry);
      } else if (entry) {
        entry.caption = final;
        entry.live = false;
        entry.turnId = completedId;
      } else {
        entries = entries.filter((item) => item.role !== role);
        entries.push({ role, live: false, hidden: false, caption: final, turnId: completedId });
      }
    },
    removeRecorded(isRecorded) {
      entries = entries.filter((entry) => {
        if (entry.turnId === undefined || !isRecorded(entry.role, entry.turnId)) return true;
        // Keep a hidden pending entry to absorb suffixes until its final arrives.
        if (!entry.live) return false;
        entry.hidden = true;
        return true;
      });
    },
    render(width, theme, info) {
      width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      if (!width) return [];
      const fit = (text: string) => truncateToWidth(text, width, "…");
      const lines: string[] = [];
      if (info.showStatus !== false) lines.push(fit(theme.fg("accent", theme.bold("Talk")) +
        theme.fg("dim", ` · ${info.state === "starting" ? "connecting" : info.state === "closing" ? "stopping" : "live"}${info.elapsedMs === undefined ? "" : ` · ${formatElapsed(info.elapsedMs)}`} · /talk stop`)));
      // A browser capability link still needs an actionable display, not a clipped dashboard label.
      for (const detail of [info.showStatus === false ? undefined : info.progress, info.browserUrl]) {
        if (detail) lines.push(fit(theme.fg("muted", clean(detail).replace(/\n/g, " "))));
      }
      const blocks = entries.filter((entry) => !entry.hidden && entry.caption.value().trim()).map((entry) => {
        const label = `${entry.role === "user" ? "You" : "Voice"}${entry.live ? " …" : ""}: `;
        const text = entry.caption.value().trim();
        const wrapped = wrapTextWithAnsi(label + text, width);
        if (entry.live && (wrapped.length > 3 || entry.caption.clipped())) {
          // Keep the speaker visible, and spend the remaining rows on the newest
          // words. The prefix ellipsis marks omitted history, not a clipped end.
          const tail = wrapTextWithAnsi(text, width).slice(-2).map(fit);
          return { entry, rows: [fit(label.trimEnd() + " …"), ...tail] };
        }
        const limit = entry.live ? 3 : 2;
        const rows = wrapped.slice(0, limit).map(fit);
        if (!entry.live && (wrapped.length > limit || entry.caption.clipped())) {
          const last = rows.length - 1;
          rows[last] = truncateToWidth(rows[last], Math.max(0, width - visibleWidth("…")), "") + "…";
        }
        return { entry, rows };
      });
      // At most one caption per speaker; each already has a bounded row count.
      for (const block of blocks) {
        const color = block.entry.role === "user" ? "userMessageText" : "accent";
        lines.push(...block.rows.map((row) => theme.fg(color, row)));
      }
      if (!blocks.length && info.showStatus !== false) lines.push(fit(theme.fg("dim", info.state === "active" ? "Ready — start speaking" : info.state === "closing" ? "Stopping voice…" : "Connecting voice…")));
      return lines;
    },
  };
}
