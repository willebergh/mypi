import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTodoState } from "../todos/core.ts";
import { idleTalkVisual, LIVE_HUD_MAX_EVENTS, LIVE_HUD_TOOL_NAME, type LiveHudEvent, type LiveHudSnapshot, type TalkVisualState } from "./webcam/src/shared/live-protocol.ts";

type RecordValue = Record<string, unknown>;
export function plainRecord(value: unknown): value is RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return (proto === Object.prototype || proto === null) &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every(field => Object.hasOwn(field, "value"));
  } catch { return false; }
}
export function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}
const tokenRate = (value: unknown) => {
  const n = nonnegative(value);
  return n !== undefined && n <= 1_000_000 ? n : undefined;
};
const positive = (value: unknown) => {
  const n = nonnegative(value);
  return n !== undefined && n > 0 ? n : undefined;
};
const percent = (value: unknown) => {
  const n = nonnegative(value);
  return n !== undefined && n <= 100 ? n : null;
};
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
// Only these explicitly consented text fields are copied. No object spreads,
// stringification of source objects, or reading message content/tool inputs.
function text(value: unknown, limit = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, limit).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
}
const MAX_AGENTS = 24;
const AGENT_COMPLETION_MS = 3000;
type Agent = LiveHudSnapshot["agents"][number];
const terminalAgent = (agent: Pick<Agent, "status">) => ["completed", "failed", "aborted"].includes(agent.status);
const agentRunKey = (agent: Pick<Agent, "id" | "startedAt">) => `${agent.id}:${agent.startedAt ?? "queued"}`;
const statuses = new Set(["queued", "starting", "thinking", "running", "completed", "failed", "aborted"]);
export function projectAgents(payload: unknown): LiveHudSnapshot["agents"] | undefined {
  if (!plainRecord(payload) || !Array.isArray(payload.states)) return undefined;
  const agents: LiveHudSnapshot["agents"] = [];
  const seen = new Set<number>();
  for (const raw of payload.states.slice(0, MAX_AGENTS)) {
    if (!plainRecord(raw) || !id(raw.id) || seen.has(raw.id) || !statuses.has(raw.status as string)) continue;
    const label = text(raw.label, 96), task = text(raw.task);
    if (label === undefined || task === undefined) continue;
    seen.add(raw.id);
    const agent: LiveHudSnapshot["agents"][number] = {
      id: raw.id, label, task, status: raw.status as LiveHudSnapshot["agents"][number]["status"],
      contextTokens: nonnegative(raw.contextTokens) ?? null,
    };
    const model = text(raw.model, 96);
    if (model) agent.model = model;
    for (const key of ["startedAt", "endedAt", "tokensPerSecond"] as const) {
      const n = key === "tokensPerSecond" ? tokenRate(raw[key]) : nonnegative(raw[key]);
      if (n !== undefined) agent[key] = n;
    }
    const window = positive(raw.contextWindow);
    if (window !== undefined) agent.contextWindow = window;
    agents.push(agent);
  }
  return agents;
}
/** Retain only projected presentation data, never task/prompt/result/error/cwd.
 * The required task slot stays empty; no protocol extension is necessary. */
function completionRow(agent: Agent): Agent {
  const row: Agent = { id: agent.id, label: agent.label, task: "", status: agent.status, contextTokens: agent.contextTokens };
  if (agent.model !== undefined) row.model = agent.model;
  for (const key of ["startedAt", "endedAt", "contextWindow", "tokensPerSecond"] as const) {
    const value = agent[key];
    if (value !== undefined) row[key] = value;
  }
  return row;
}
interface AgentCompletion { row: Agent; expiresAt: number }
interface ObservedAgent {
  id: number;
  startedAt?: number;
  status: Agent["status"];
  eligible: boolean;
  completion?: Agent;
  /** Set only when an already-retained run is repeated by the producer. */
  completionDeadline?: number;
}
/** Producer-specific, notification-only settlement adapter. runner.ts publishes
 * provisional terminal states (including retryable failures). Even its finally
 * publication can be superseded if client.stop throws. index.ts settle publishes
 * the definitive state and immediately removes the job. Stage the latest terminal
 * endedAt-bearing event until that removal; absence by itself NEVER supplies an
 * outcome. Every definitive producer path supplies endedAt, including queued
 * cancellation; bare terminal statuses are provisional and are not retained.
 *
 * At most 24 current identities, 24 staged rows and 24 retained rows; output is
 * capped at 24 total, active first. Three-second deadlines start at confirmed
 * removal, never reconnect/duplicates. Staged data belongs to the current source
 * snapshot only; no task text is kept for terminal rows.
 */
export function createAgentCompletionRetention() {
  let observed = new Map<number, ObservedAgent>();
  const retained = new Map<string, AgentCompletion>();
  let active: Agent[] = [];
  let initialized = false;
  let epoch = 0;
  let clock = 0;
  function reset(at: number): void {
    observed.clear(); retained.clear(); active = [];
    initialized = false;
    epoch = clock = nonnegative(at) ?? 0;
  }
  function prune(at: number): number {
    const time = nonnegative(at) ?? clock;
    if (time < clock) reset(time);
    clock = time;
    for (const [key, completion] of retained) if (completion.expiresAt <= time) retained.delete(key);
    return time;
  }
  function discard(key: string): void {
    if (retained.delete(key)) {
      // Capacity/ID eviction is loss, not a deferred replay. Reject unknown
      // terminal events predating it, without keeping an unbounded ID history.
      epoch = Math.max(epoch, clock);
    }
  }
  function snapshot(at: number): Agent[] {
    prune(at);
    // New work takes priority. Drop oldest tombstones, rather than hiding them
    // in a backlog that would replay when active rows later disappear.
    const room = MAX_AGENTS - active.length;
    while (retained.size > room) discard(retained.keys().next().value!);
    return [...active, ...[...retained.values()].reverse().map(completion => completion.row)];
  }
  function update(rows: Agent[], at: number): Agent[] {
    const time = prune(at);
    if (!initialized) epoch = time;
    const next = new Map<number, ObservedAgent>();
    active = [];
    for (const row of rows.slice(0, MAX_AGENTS)) {
      const previous = observed.get(row.id);
      // Bind queued -> started once; never attach an older started run's outcome
      // to a new timestamp (or to a newly queued reuse of the same numeric ID).
      const matching = previous && (previous.startedAt === row.startedAt ||
        (previous.startedAt === undefined && !terminalAgent(previous) && row.startedAt !== undefined)) ? previous : undefined;
      const terminal = terminalAgent(row);
      const entry: ObservedAgent = {
        id: row.id, startedAt: row.startedAt, status: row.status,
        eligible: matching ? matching.eligible : !terminal || (initialized && row.endedAt !== undefined &&
          row.endedAt > epoch && row.endedAt <= time && time - row.endedAt < AGENT_COMPLETION_MS),
      };
      if (terminal) {
        if (entry.eligible && row.endedAt !== undefined) {
          // Keep corrections through cleanup, but a repeated retained outcome
          // must not extend its original deadline.
          entry.completion = completionRow(row);
          entry.completionDeadline = matching?.completionDeadline ?? retained.get(agentRunKey(row))?.expiresAt;
        }
      } else {
        entry.eligible = true;
        active.push(row);
      }
      next.set(row.id, entry);
      // Validators require unique numeric IDs. A reuse supersedes an old run;
      // never emit its tombstone beside, or after, the replacement run.
      for (const [key, completion] of retained) {
        if (completion.row.id === row.id && (!terminal || key !== agentRunKey(row))) discard(key);
      }
    }
    for (const entry of observed.values()) {
      if (next.has(entry.id)) continue; // Present or replaced: not settlement.
      const row = entry.completion;
      if (row && (entry.completionDeadline === undefined || entry.completionDeadline > time)) {
        retained.set(agentRunKey(entry), { row, expiresAt: entry.completionDeadline ?? time + AGENT_COMPLETION_MS });
        while (retained.size > MAX_AGENTS) discard(retained.keys().next().value!);
      }
    }
    observed = next;
    initialized = true; // Empty snapshots are a baseline too, never a reset.
    return snapshot(time);
  }
  return { reset, update, snapshot };
}

export interface ProjectedTodos {
  items: LiveHudSnapshot["todos"];
  counts: NonNullable<LiveHudSnapshot["todoCounts"]>;
}
const emptyTodos = (): ProjectedTodos => ({ items: [], counts: { total: 0, pending: 0, completed: 0 } });
export function projectTodos(payload: unknown): ProjectedTodos | undefined {
  if (!plainRecord(payload) || !plainRecord(payload.state) || !Array.isArray(payload.state.items)) return undefined;
  const pending: LiveHudSnapshot["todos"] = [], completed: LiveHudSnapshot["todos"] = [];
  const counts = { total: 0, pending: 0, completed: 0 };
  const seen = new Set<number>();
  // Validate/count the FULL replacement. Never claim full totals for a partly
  // valid list, or let a completed prefix hide later pending work. Only bounded,
  // allowlisted rows survive this call; no tool state is mutated or retained.
  for (const raw of payload.state.items) {
    if (!plainRecord(raw) || !id(raw.id) || seen.has(raw.id) || typeof raw.completed !== "boolean") return undefined;
    const label = text(raw.text);
    if (label === undefined) return undefined;
    const at = nonnegative(raw.completedAt);
    if (raw.completedAt !== undefined && at === undefined) return undefined;
    seen.add(raw.id);
    counts.total++;
    counts[raw.completed ? "completed" : "pending"]++;
    const rows = raw.completed ? completed : pending;
    if (raw.completed) {
      if (pending.length + completed.length >= 48) continue;
    } else {
      if (pending.length >= 48) continue;
      if (pending.length + completed.length >= 48) completed.pop();
    }
    const item: LiveHudSnapshot["todos"][number] = { id: raw.id, text: label, completed: raw.completed };
    if (at !== undefined) item.completedAt = at;
    rows.push(item);
  }
  // Canonical order within each category, not newest-first or ID order.
  return { items: [...pending, ...completed], counts };
}

/** Active-branch structured todo results only. The core exposes a validator,
 * not a reconstruction helper; mirror its branch walk without reading texts. */
export function initialTodos(ctx: ExtensionContext): ProjectedTodos {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]!;
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== "todo") continue;
      const details: unknown = message.details;
      if (plainRecord(details) && plainRecord(details.state)) {
        // Use the same full-list validation/selection for events and history.
        const projected = projectTodos({ state: details.state });
        if (projected && isTodoState(details.state)) return projected;
      }
    }
  } catch { /* An unavailable context has no known todos. */ }
  return emptyTodos();
}
/** All activity times are integer Unix milliseconds within JS Date's range. */
export function activityTimestamp(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && value.length <= 32
    ? Date.parse(value) : nonnegative(value);
  return n !== undefined && Number.isFinite(n) && n >= 0 && n <= 8_640_000_000_000_000 ? Math.floor(n) : undefined;
}
export function activityToolName(value: unknown): string | undefined {
  return typeof value === "string" && LIVE_HUD_TOOL_NAME.test(value) ? value : undefined;
}
/** Only the active main branch; never inspect message content, arguments, results,
 * details, stop reasons or errors. Past tool outcomes are deliberately unknown.
 * Run/tool-start events are transient and cannot be inferred from history. */
export function initialActivity(ctx: ExtensionContext, at: number): LiveHudEvent[] {
  const events: LiveHudEvent[] = [];
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0 && events.length < LIVE_HUD_MAX_EVENTS; i--) {
      const entry = branch[i]!;
      const timestamp = activityTimestamp(entry.timestamp);
      if (timestamp === undefined) continue;
      const base = { id: randomUUID(), timestamp: Math.min(at, timestamp) };
      if (entry.type === "compaction") {
        events.push({ ...base, role: "system", kind: "compaction", status: "completed" });
      } else if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "user") events.push({ ...base, role: "user", kind: "user_turn", status: "received" });
        else if (message.role === "assistant") events.push({ ...base, role: "assistant", kind: "assistant_finished", status: "finished" });
        else if (message.role === "toolResult") {
          const toolName = activityToolName(message.toolName);
          events.push({ ...base, role: "toolResult", kind: "tool", status: "recorded", ...(toolName ? { toolName } : {}) });
        }
      }
    }
  } catch { /* Unavailable branch has no known activity. */ }
  // Preserve branch order for equal timestamps; clock skew must not reorder the tail.
  events.reverse();
  let previous = 0;
  for (const event of events) { event.timestamp = Math.max(previous, event.timestamp); previous = event.timestamp; }
  return events;
}
export function projectUsage(payload: unknown): LiveHudSnapshot["usage"] | undefined {
  if (!plainRecord(payload)) return undefined;
  if (payload.status === "inactive" || payload.status === "loading") return { status: payload.status };
  if (payload.status === "error") {
    const usage: LiveHudSnapshot["usage"] = { status: "error" };
    const at = nonnegative(payload.updatedAt);
    if (at !== undefined) usage.updatedAt = at;
    return usage; // Deliberately never copy the provider's error message.
  }
  if (payload.status !== "ready" || !plainRecord(payload.snapshot)) return undefined;
  const snapshot = payload.snapshot;
  const at = nonnegative(snapshot.updatedAt);
  const usage: LiveHudSnapshot["usage"] = { status: "ready" };
  if (at !== undefined) usage.updatedAt = at;
  const weekly = [snapshot.primary, snapshot.secondary].find(window =>
    plainRecord(window) && (window.windowSeconds === 604_800 || window.label === "weekly" || window.label === "7d"));
  if (plainRecord(weekly)) {
    usage.weekly = { remainingPercent: percent(weekly.remainingPercent), usedPercent: percent(weekly.usedPercent) };
    const reset = nonnegative(weekly.resetAt);
    // Provider resetAt is seconds; all other timestamps in this DTO are ms.
    if (reset !== undefined) usage.weekly.resetAt = reset;
  }
  return usage;
}
const phases = new Set(["idle", "standby", "preparing", "summarizing", "starting-native", "creating-offer", "connecting-voice", "connecting-audio", "ready", "connected", "stopping", "error"]);
export function projectTalk(payload: unknown): TalkVisualState | undefined {
  if (!plainRecord(payload) || !phases.has(payload.phase as string) ||
      !["physical", "virtual", "facetime", "inactive"].includes(payload.mode as string) ||
      typeof payload.voiceReady !== "boolean" || typeof payload.audioEnabled !== "boolean" ||
      (payload.runId !== undefined && (typeof payload.runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.runId))) ||
      (payload.elapsedMs !== undefined && nonnegative(payload.elapsedMs) === undefined)) return undefined;
  const talk: TalkVisualState = { phase: payload.phase as TalkVisualState["phase"], mode: payload.mode as TalkVisualState["mode"],
    voiceReady: payload.voiceReady, audioEnabled: payload.audioEnabled };
  if (payload.runId !== undefined) talk.runId = payload.runId as string;
  if (payload.elapsedMs !== undefined) talk.elapsedMs = payload.elapsedMs as number;
  return talk;
}
export function projectContext(ctx: ExtensionContext | undefined, rate?: number): Pick<LiveHudSnapshot, "context"> & { provider: string; model: string } {
  let provider = "unknown", model = "unknown";
  const context: LiveHudSnapshot["context"] = { tokens: null, contextWindow: null, percent: null };
  if (ctx) {
    try {
      provider = text(ctx.model?.provider, 96) || "unknown";
      model = text(ctx.model?.id, 96) || "unknown";
      const usage = ctx.getContextUsage();
      context.tokens = nonnegative(usage?.tokens) ?? null;
      context.contextWindow = positive(usage?.contextWindow) ?? positive(ctx.model?.contextWindow) ?? null;
      context.percent = context.tokens === null ? null : percent(usage?.percent);
    } catch { /* Invalidated/offline context: unknown, never guessed zero. */ }
  }
  const value = tokenRate(rate);
  if (value !== undefined) context.tokensPerSecond = value;
  return { context, provider, model };
}
export function emptyProjection(): Pick<LiveHudSnapshot, "agents" | "todos" | "todoCounts" | "usage" | "talk" | "events"> {
  const todos = emptyTodos();
  return { agents: [], todos: todos.items, todoCounts: todos.counts, usage: { status: "inactive" }, talk: idleTalkVisual(), events: [] };
}
