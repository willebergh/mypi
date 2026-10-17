import type { LiveCallbacks, LiveDelegation, LiveTranscript, LiveTurn } from "./live.ts";

type Callbacks = Pick<LiveCallbacks, "onTranscript" | "onTurn" | "onTurnStart" | "onDelegation" | "onError"> & {
  onDelegation(id: string, offsetMs: number, input?: string, metadata?: LiveDelegation): void;
};
type Role = "user" | "assistant";
const MAX_TEXT = 16 * 1024;
const MAX_TASK = 8 * 1024;
const MAX_IDS = 256;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && Buffer.byteLength(value) <= limit && Buffer.from(value).toString("utf8") === value;
function safely(callback: () => void) {
  try { callback(); } catch { /* Consumer exceptions must not escape transport handlers. */ }
}

/** Pure OG Codex data-channel adapter: no transport, audio, or task execution. */
export function createCodexWire(callbacks: Callbacks): {
  receive(event: unknown): void;
  context(id: string | null, content: string, speakable: boolean): object;
} {
  const started = performance.now();
  let offset = 0;
  let failed = false;
  const ids = new Set<string>();
  const partial: Record<Role, string> = { user: "", assistant: "" };
  type Final = { value: string; keys: string[] };
  const finalized: Record<Role, Final | undefined> = { user: undefined, assistant: undefined };
  const pending: Record<Role, Set<string>> = { user: new Set(), assistant: new Set() };
  const completed = new Set<string>();
  const events = new Set<string>();
  const startedTurns = new Set<string>();
  function remember(memory: Set<string>, keys: Iterable<string>) {
    for (const key of keys) {
      memory.add(key);
      if (memory.size > MAX_IDS) memory.delete(memory.values().next().value!);
    }
  }
  function identity(event: Record<string, unknown>, item: Record<string, unknown>, role: Role) {
    const keys: string[] = [];
    const add = (kind: string, value: unknown) => {
      if (validId(value)) keys.push(`${role}:${kind}:${value}`);
    };
    add("turn", event.turn_id);
    add("turn", item.turn_id);
    add("item", event.item_id);
    add("item", item.item_id);
    add(event.type === "turn.done" ? "turn" : "item", item.id);
    return keys;
  }
  function now() {
    offset = Math.max(offset, performance.now() - started, 0);
    return offset;
  }
  function fail() {
    if (failed) return;
    failed = true;
    // Never expose server text, task contents, or credentials in diagnostics.
    safely(() => callbacks.onError(new Error("Codex voice protocol error; restart the session")));
  }
  function emit(role: Role, delta: string, source: "delta" | "final", metadata?: LiveTranscript) {
    if (!delta) return;
    const ms = now();
    safely(() => metadata
      ? callbacks.onTranscript(role, delta, ms, ms, source, metadata)
      : callbacks.onTranscript(role, delta, ms, ms, source));
  }
  function transcript(role: Role, value: unknown, final: boolean, keys: string[], finalMetadata?: LiveTurn, metadata?: LiveTranscript) {
    if (keys.some((key) => completed.has(key))) {
      remember(completed, keys);
      return;
    }
    // OG turn.done may omit its transcript when earlier events already carried it.
    if (!(final && value == null) && !text(value, MAX_TEXT)) { fail(); return; }
    const previous = partial[role];
    if (!final) {
      if (Buffer.byteLength(previous) + Buffer.byteLength(value as string) > MAX_TEXT) { fail(); return; }
      if (!previous) finalized[role === "user" ? "assistant" : "user"] = undefined;
      remember(pending[role], keys);
      partial[role] += value;
      finalized[role] = undefined;
      emit(role, value as string, "delta", metadata);
      return;
    }
    const last = finalized[role];
    // Missing IDs can only correlate adjacent finals within the same turn
    // boundary. Two explicitly distinct identities never dedupe by text.
    if (!previous && last && (value == null || value === last.value)
      && (!keys.length || !last.keys.length)) {
      remember(completed, keys);
      last.keys = keys.length ? keys : last.keys;
      return;
    }
    if (value == null && !previous) return;
    const result = value == null ? previous : value as string;
    if (!previous) finalized[role === "user" ? "assistant" : "user"] = undefined;
    const allKeys = [...pending[role], ...keys];
    remember(completed, allKeys);
    pending[role].clear();
    partial[role] = "";
    finalized[role] = { value: result, keys: allKeys };
    // Keep final captions, but label synthesized text so it cannot masquerade as fresh speech.
    // The streaming callback is append-only; corrections go through onTurn.
    if (previous) {
      if (result.startsWith(previous)) emit(role, result.slice(previous.length), "final");
    } else {
      emit(role, result, "final");
    }
    const turn = finalMetadata;
    if (turn) safely(() => callbacks.onTurn?.(role, result, turn));
    else safely(() => callbacks.onTurn?.(role, result));
  }
  return {
    receive(event) {
      if (failed) return;
      if (!record(event) || typeof event.type !== "string") { fail(); return; }
      if (event.type === "error") { fail(); return; }
      const eventId = validId(event.event_id) ? event.event_id : event.id;
      if (validId(eventId)) {
        if (events.has(eventId)) return;
        remember(events, [eventId]);
      }
      if (event.type === "input_transcript.added" || event.type === "output_transcript.added") {
        if (!record(event.item)) { fail(); return; }
        const role = event.type === "input_transcript.added" ? "user" : "assistant";
        // Only the actual fragment item ID is ASR identity, never event/turn aliases.
        const metadata: LiveTranscript | undefined = validId(event.item.id) ? { itemId: event.item.id } : undefined;
        transcript(role, event.item.text, false, identity(event, event.item, role), undefined, metadata);
      } else if (event.type === "turn.created") {
        if (!record(event.turn)) return;
        const turn = event.turn;
        if ((turn.role !== "user" && turn.role !== "assistant") || !validId(turn.id)) return;
        const role = turn.role as Role;
        const id = turn.id as string;
        const key = `${role}:${id}`;
        if (startedTurns.has(key)) return;
        if (startedTurns.size >= MAX_IDS) return;
        startedTurns.add(key);
        safely(() => callbacks.onTurnStart?.(role, id));
      } else if (event.type === "turn.done") {
        if (!record(event.turn)) { fail(); return; }
        if (event.turn.role === "user" || event.turn.role === "assistant") {
          const turn = event.turn;
          const role = turn.role as Role;
          const metadata: LiveTurn | undefined = validId(turn.id) ? {
            id: turn.id,
            ...(timestamp(turn.start_ms) ? { startMs: turn.start_ms } : {}),
            ...(timestamp(turn.end_ms) ? { endMs: turn.end_ms } : {}),
          } : undefined;
          transcript(role, turn.transcript, true, identity(event, turn, role),
            typeof turn.transcript === "string" ? metadata : undefined);
        }
      } else if (event.type === "delegation.created") {
        const item = event.item;
        if (!record(item)) { fail(); return; }
        if (item.type !== "delegation" || item.target !== "client") return;
        if (!validId(item.id)) { fail(); return; }
        if (ids.has(item.id)) return;
        if (ids.size >= MAX_IDS || !Array.isArray(item.content)) { fail(); return; }
        let input = "";
        let bytes = 0;
        for (const part of item.content) {
          if (!record(part) || part.type !== "input_text") continue;
          if (!text(part.text, MAX_TASK)) { fail(); return; }
          bytes += Buffer.byteLength(part.text);
          if (bytes > MAX_TASK) { fail(); return; }
          input += part.text;
        }
        if (!input.trim()) { fail(); return; }
        ids.add(item.id); // Record before calling out, including reentrant receives.
        const id = item.id, ms = now();
        const metadata: LiveDelegation | undefined = validId(item.user_bidi_turn_id)
          ? { userTurnId: item.user_bidi_turn_id }
          : undefined;
        safely(() => metadata
          ? callbacks.onDelegation(id, ms, input, metadata)
          : callbacks.onDelegation(id, ms, input));
      }
    },
    context(id, content, speakable) {
      if (id !== null && !validId(id)) throw new Error("Invalid Codex delegation ID");
      if (!text(content, MAX_TEXT)) throw new Error("Invalid Codex context");
      return {
        type: id === null ? "session.context.append" : "delegation.context.append",
        ...(id === null ? {} : { delegation_item_id: id }),
        channel: speakable ? "speakable" : "commentary",
        content: [{ type: "input_text", text: content }],
      };
    },
  };
}
