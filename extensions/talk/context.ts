type Role = "user" | "assistant";
type Fragment = {
  id: number; role: Role; text: string; startMs: number; endMs: number;
  consumed: boolean; truncated: boolean;
};

const MAX_BYTES = 32 * 1024;
const MAX_FRAGMENTS = 512;
const REQUEST_BYTES = 4 * 1024;
const MAX_TURNS = 16;
const OMITTED = "[Older context omitted]\n";

// Keep a suffix without cutting a surrogate pair. Budgets are UTF-8 bytes.
function tail(text: string, budget: number): string {
  let start = text.length;
  let bytes = 0;
  while (start > 0) {
    let next = start - 1;
    const low = text.charCodeAt(next);
    if (low >= 0xdc00 && low <= 0xdfff && next > 0) {
      const high = text.charCodeAt(next - 1);
      if (high >= 0xd800 && high <= 0xdbff) next--;
    }
    const size = Buffer.byteLength(text.slice(next, start));
    if (bytes + size > budget) break;
    bytes += size;
    start = next;
  }
  return text.slice(start);
}

function sanitize(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029]/gu, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

function timestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export type TalkContextSnapshot = {
  text: string | undefined;
  hasUser: boolean;
  commit(): void;
};

type Turn = { role: Role; text: string; hasUser: boolean };
function render(turn: Turn): string {
  return `${turn.role === "user" ? "You" : "Voice"}: ${turn.text.replace(/\n/g, "\n  ")}`;
}

export function createTalkContext() {
  let fragments: Fragment[] = [];
  let bytes = 0;
  let nextId = 0;
  let epoch = 0;
  // A bounded loss notice, not retained transcript. Versioning prevents a pending
  // snapshot from acknowledging storage loss that happened after it was made.
  let droppedStart = Infinity;
  let lossVersion = 0;
  function noteLoss(fragment: Fragment) {
    if (fragment.consumed) return;
    droppedStart = Math.min(droppedStart, fragment.startMs);
    lossVersion++;
  }

  function snapshot(offsetMs: number): TalkContextSnapshot {
    if (!timestamp(offsetMs)) throw new Error("Invalid talk delegation offset");
    const selected = fragments.filter((f) => !f.consumed && f.startMs <= offsetMs + 1000)
      .sort((a, b) => a.startMs - b.startMs || a.id - b.id);
    const ids = new Set(selected.map((f) => f.id));
    const snapshotEpoch = epoch;
    const snapshotLossVersion = lossVersion;
    const lost = droppedStart <= offsetMs + 1000;
    let omitted = lost || selected.some((f) => f.truncated);
    let hasUser = false;
    const turns: Turn[] = [];
    for (const fragment of selected) {
      const eligibleUser = fragment.role === "user" && fragment.startMs <= offsetMs && Boolean(fragment.text.trim());
      const last = turns.at(-1);
      if (last?.role === fragment.role) {
        last.text += fragment.text;
        last.hasUser ||= eligibleUser;
      } else turns.push({ role: fragment.role, text: fragment.text, hasUser: eligibleUser });
    }
    if (turns.length > MAX_TURNS) omitted = true;
    const recent = turns.slice(-MAX_TURNS);
    const lines: string[] = [];
    // Reserve the notice even before truncation is known to be necessary.
    let remaining = REQUEST_BYTES - Buffer.byteLength(OMITTED);
    for (let i = recent.length - 1; i >= 0; i--) {
      const turn = recent[i];
      let line = render(turn);
      const separator = lines.length ? 1 : 0;
      if (Buffer.byteLength(line) + separator > remaining) {
        omitted = true;
        let low = 0, high = Math.min(Buffer.byteLength(turn.text), remaining);
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          const candidate = render({ ...turn, text: tail(turn.text, mid) });
          if (Buffer.byteLength(candidate) + separator <= remaining) low = mid;
          else high = mid - 1;
        }
        const text = tail(turn.text, low);
        line = render({ ...turn, text });
        if (text && Buffer.byteLength(line) + separator <= remaining) {
          lines.unshift(line);
          hasUser ||= turn.hasUser && Boolean(text.trim());
        }
        break;
      }
      lines.unshift(line);
      hasUser ||= turn.hasUser && Boolean(turn.text.trim());
      remaining -= Buffer.byteLength(line) + separator;
    }
    const text = lines.length ? (omitted ? OMITTED : "") + lines.join("\n") : undefined;
    let committed = false;
    return {
      text,
      hasUser,
      commit() {
        if (committed || epoch !== snapshotEpoch) return;
        committed = true;
        // Never use an arrival-order watermark: an earlier ID may be future speech.
        for (const fragment of fragments) if (ids.has(fragment.id)) fragment.consumed = true;
        if (lost && lossVersion === snapshotLossVersion) droppedStart = Infinity;
      },
    };
  }

  return {
    append(role: Role, delta: string, startMs: number, endMs: number) {
      if ((role !== "user" && role !== "assistant") || typeof delta !== "string" ||
          !timestamp(startMs) || !timestamp(endMs) || endMs < startMs) {
        throw new Error("Invalid talk transcript fragment");
      }
      const safe = sanitize(delta);
      if (!safe) return;
      const text = tail(safe, MAX_BYTES);
      fragments.push({ id: nextId++, role, text, startMs, endMs, consumed: false, truncated: text !== safe });
      bytes += Buffer.byteLength(text);
      while (fragments.length > MAX_FRAGMENTS || bytes > MAX_BYTES) {
        const first = fragments[0];
        const size = Buffer.byteLength(first.text);
        if (fragments.length > MAX_FRAGMENTS || size <= bytes - MAX_BYTES) {
          noteLoss(first);
          fragments.shift();
          bytes -= size;
        } else {
          first.text = tail(first.text, size - (bytes - MAX_BYTES));
          first.truncated = true;
          bytes -= size - Buffer.byteLength(first.text);
        }
      }
    },
    snapshot,
    request(offsetMs: number): string | undefined {
      const result = snapshot(offsetMs);
      return result.hasUser ? result.text : undefined;
    },
    caption(role: Role): string {
      const text = fragments.filter((f) => f.role === role).map((f) => f.text).join("");
      let start = Math.max(0, text.length - 400);
      if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start++;
      return text.slice(start);
    },
    reset() {
      fragments = [];
      bytes = 0;
      droppedStart = Infinity;
      epoch++;
    },
  };
}

/** Conservative Live append payload (the service also imposes a 500-token limit). */
export function safeLiveUpdate(text: string): string {
  let result = "";
  let bytes = 0;
  for (const char of text) {
    // Strip terminal/control and bidi formatting characters; keep readable whitespace.
    if (/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(char)) continue;
    const safe = /^[\uD800-\uDFFF]$/u.test(char) ? "\uFFFD" : char;
    const size = Buffer.byteLength(safe);
    if (bytes + size > 450) break;
    result += safe;
    bytes += size;
  }
  return result;
}
