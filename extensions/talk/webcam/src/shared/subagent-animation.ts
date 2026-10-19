/** Pure presentation state. No clock, renderer, protocol, or SDK dependencies.
 * Feed accepted snapshots, then tick with only nowMs. All times are milliseconds
 * on ONE caller-owned animation clock (not producer Unix timestamps).
 */
export type SubagentActiveStatus = 'queued' | 'starting' | 'thinking' | 'running';
export type SubagentTerminalStatus = 'completed' | 'failed' | 'aborted';

export interface SubagentAnimationRow {
  /** Stable for the entire run, including queued -> started. Scoped by generation.
   * Prefer a producer run UUID; otherwise bind id + startedAt when available.
   * A producer that never reuses IDs within a session may use String(id).
   * Do not change this key when a queued run first acquires startedAt.
   */
  runKey: string;
  id: number;
  label: string;
  status: SubagentActiveStatus;
  model?: string;
  contextTokens: number | null;
  contextWindow?: number;
  tokensPerSecond?: number;
}

export interface SubagentAnimationOutcome {
  runKey: string;
  /** REQUIRED authoritative, final run outcome, not disappearance or tool success.
   * Outcomes for a run must be immutable; drop stale/out-of-order source frames.
   */
  status: SubagentTerminalStatus;
}

export interface SubagentAnimationLayout {
  maxRows: number;
  rowPitch: number;
  headerHeight: number;
  /** New rows fade and slide one rowPitch down into their initial slot. */
  enterMs: number;
  pulseMs: number;
  fadeMs: number;
  reflowMs: number;
  unknownHoldMs: number;
  /** Absolute bound from first disappearance/terminal observation, even if an
   * unknown exit is subsequently upgraded by an authoritative outcome.
   */
  maxRetentionMs: number;
}

export const DEFAULT_SUBAGENT_ANIMATION_LAYOUT: Readonly<SubagentAnimationLayout> = Object.freeze({
  maxRows: 3, rowPitch: 52, headerHeight: 52,
  enterMs: 160, pulseMs: 420, fadeMs: 320, reflowMs: 260,
  unknownHoldMs: 180, maxRetentionMs: 1800,
});

type Tween = { from: number; to: number; at: number; duration: number };
type Exit = {
  firstAt: number;
  pulseAt: number;
  pulseUntil: number;
  endsAt: number;
  opacity: number;
  outcome: SubagentTerminalStatus | null;
};
type StoredRow = {
  data: SubagentAnimationRow;
  slot: number;
  y: Tween;
  opacity: Tween;
  exit: Exit | null;
};

/** Opaque-by-convention, serializable state. Do not mutate or persist as history.
 * Only current capped candidates and capped visible rows are retained.
 */
export interface SubagentAnimationState {
  generation: string;
  nowMs: number;
  layout: SubagentAnimationLayout;
  active: readonly SubagentAnimationRow[];
  rows: readonly StoredRow[];
  height: Tween;
}

export interface SubagentAnimationInput {
  nowMs: number;
  /** Include source mode, publisher stream, and session/reset generation.
   * Never use a Talk/voice run ID: unrelated voice restarts are not agent resets.
   */
  generation: string;
  online: boolean;
  /** A complete current active/queued list in desired order, BEFORE the HUD cap.
   * Omit on render-only ticks. Terminal rows belong in outcomes, never here.
   */
  snapshot?: readonly SubagentAnimationRow[];
  /** May arrive with the disappearance snapshot or later while its row survives.
   * Unseen/expired runs are not resurrected to replay old completion history.
   */
  outcomes?: readonly SubagentAnimationOutcome[];
  layout?: Partial<SubagentAnimationLayout>;
}

export interface SubagentAnimatedRow {
  key: string;
  row: SubagentAnimationRow;
  status: SubagentActiveStatus | SubagentTerminalStatus | 'unknown';
  /** Entering includes an unknown disappearance reversing back to live. */
  phase: 'entering' | 'active' | 'exiting';
  /** Row top relative to the content origin; caller adds header/text baseline.
   * New rows start one pitch above their initial canonical slot (possibly < 0).
   * Apply this position directly; do not add a second renderer entry offset.
   */
  y: number;
  opacity: number;
  highlight: number;
  tint: 'green' | 'amber' | 'red' | null;
}

export interface SubagentAnimationFrame {
  state: SubagentAnimationState;
  rows: readonly SubagentAnimatedRow[];
  /** Zero when empty; otherwise headerHeight + row pitches, smoothly interpolated. */
  containerHeight: number;
  targetHeight: number;
  /** While true, sample at render cadence, NOT the telemetry paint interval. */
  animating: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
function value(tween: Tween, now: number): number {
  const t = tween.duration === 0 ? 1 : clamp((now - tween.at) / tween.duration);
  const eased = t * t * (3 - 2 * t);
  return tween.from + (tween.to - tween.from) * eased;
}
function moving(tween: Tween, now: number): boolean {
  return tween.from !== tween.to && now < tween.at + tween.duration;
}
function retarget(tween: Tween, to: number, now: number, duration: number): Tween {
  // Repeated telemetry/frames must not restart the same trajectory.
  return tween.to === to ? tween : { from: value(tween, now), to, at: now, duration };
}
function fixed(n: number, now: number): Tween {
  return { from: n, to: n, at: now, duration: 0 };
}
function opacity(row: StoredRow, now: number): number {
  const exit = row.exit;
  if (!exit) return value(row.opacity, now);
  const span = exit.endsAt - exit.pulseUntil;
  return exit.opacity * (1 - (span <= 0 ? Number(now >= exit.endsAt)
    : clamp((now - exit.pulseUntil) / span)));
}
function safeRow(row: SubagentAnimationRow): SubagentAnimationRow {
  // Explicit allowlist: a caller may pass a structurally wider HUD DTO. Never
  // retain task/prompt/cwd/activity/result/error fields by spreading that DTO.
  return { runKey: row.runKey, id: row.id, label: row.label, status: row.status,
    model: row.model, contextTokens: row.contextTokens,
    contextWindow: row.contextWindow, tokensPerSecond: row.tokensPerSecond };
}
function isActive(status: string): status is SubagentActiveStatus {
  return status === 'queued' || status === 'starting' || status === 'thinking' || status === 'running';
}
function isTerminal(status: string): status is SubagentTerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}
function layoutFor(previous: SubagentAnimationState | undefined, input: SubagentAnimationInput): SubagentAnimationLayout {
  const layout = { ...DEFAULT_SUBAGENT_ANIMATION_LAYOUT, ...previous?.layout, ...input.layout };
  for (const [key, n] of Object.entries(layout)) {
    if (!Number.isFinite(n) || n < 0) throw new RangeError(`Invalid subagent animation layout: ${key}`);
  }
  if (!Number.isInteger(layout.maxRows)) throw new RangeError('maxRows must be an integer');
  return layout;
}
function startExit(row: StoredRow, outcome: SubagentTerminalStatus | null, now: number,
  layout: SubagentAnimationLayout): StoredRow {
  // Repeated final outcomes cannot extend retention or retrigger the pulse.
  if (row.exit && (row.exit.outcome !== null || outcome === null)) return row;
  const firstAt = row.exit?.firstAt ?? now;
  const endsAt = Math.min(firstAt + layout.maxRetentionMs,
    now + (outcome === null ? layout.unknownHoldMs : layout.pulseMs) + layout.fadeMs);
  const hold = outcome === null ? layout.unknownHoldMs : layout.pulseMs;
  return { ...row, exit: { firstAt, endsAt, pulseAt: now, pulseUntil: Math.min(now + hold, endsAt),
    opacity: opacity(row, now), outcome } };
}

/** Preserve exit slots while live rows follow current source order. Exits count
 * against the SAME visible cap; new rows wait rather than overflowing the card.
 * A cap eviction is not a completion and has no success/unknown flash.
 * Admission, including a queued row waiting behind exits, starts its entry at
 * that instant, not when its source snapshot first arrived. Its origin is fixed
 * once: one pitch above the assigned slot. Reorders thereafter retarget from
 * sampled positions, never recompute an origin or restart an unchanged target.
 */
function reflow(state: SubagentAnimationState, now: number): SubagentAnimationState {
  const { layout } = state;
  const exits = state.rows.filter(row => row.exit).sort((a, b) => a.slot - b.slot).slice(0, layout.maxRows);
  const exitKeys = new Set(exits.map(row => row.data.runKey));
  const old = new Map(state.rows.map(row => [row.data.runKey, row]));
  const rows: StoredRow[] = state.active.filter(row => !exitKeys.has(row.runKey))
    .slice(0, layout.maxRows - exits.length).map(data => {
      const retained = old.get(data.runKey);
      if (retained) return { ...retained, data };
      return { data, slot: 0, y: fixed(0, now),
        opacity: { from: 0, to: 1, at: now, duration: layout.enterMs }, exit: null };
    });
  for (const exit of exits) rows.splice(Math.min(exit.slot, rows.length), 0, exit);
  const positioned = rows.map((row, slot) => {
    const target = slot * layout.rowPitch;
    return { ...row, slot,
      y: old.has(row.data.runKey) ? retarget(row.y, target, now, layout.reflowMs)
        : { from: target - layout.rowPitch, to: target, at: now, duration: layout.enterMs } };
  });
  const height = positioned.length ? layout.headerHeight + positioned.length * layout.rowPitch : 0;
  return { ...state, rows: positioned, height: retarget(state.height, height, now, layout.reflowMs) };
}

/** Consume timed removals at their actual deadlines, not at the next render's
 * timestamp. Long frame gaps therefore catch up instead of restarting reflow.
 */
function advance(state: SubagentAnimationState, now: number): SubagentAnimationState {
  for (;;) {
    const deadline = Math.min(...state.rows.filter(row => row.exit).map(row => row.exit!.endsAt));
    if (deadline > now) return state;
    state = reflow({ ...state, rows: state.rows.filter(row => !row.exit || row.exit.endsAt > deadline) }, deadline);
  }
}

export function reduceSubagentAnimation(previous: SubagentAnimationState | undefined,
  input: SubagentAnimationInput): SubagentAnimationFrame {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) throw new RangeError('nowMs must be finite and nonnegative');
  const now = input.nowMs;
  const reset = !previous || previous.generation !== input.generation || now < previous.nowMs || !input.online;
  const layout = layoutFor(reset ? undefined : previous, input);
  let state: SubagentAnimationState = reset
    ? { generation: input.generation, nowMs: now, layout, active: [], rows: [], height: fixed(0, now) }
    : advance(previous!, now);

  if (input.online) {
    // Layout changes retarget only after advancing the previous trajectories.
    state = { ...state, layout };
    if (input.snapshot !== undefined) {
      const seen = new Set<string>();
      const snapshot = input.snapshot.filter(row => {
        if (!isActive(row.status) || seen.has(row.runKey)) return false;
        seen.add(row.runKey);
        return true;
      });
      const byKey = new Map(snapshot.map(row => [row.runKey, row]));
      const rows = state.rows.map(row => {
        const current = byKey.get(row.data.runKey);
        if (!current) return startExit(row, null, now, layout);
        if (row.exit?.outcome) return row; // Definitive finality never reverses.
        return { ...row, data: safeRow(current), exit: null,
          opacity: row.exit ? { from: opacity(row, now), to: 1, at: now, duration: layout.enterMs } : row.opacity };
      });
      state = { ...state, rows, active: snapshot.slice(0, layout.maxRows).map(safeRow) };
    }
    // Explicit outcome wins over a simultaneous missing/active observation.
    // Only rows previously visible have data to retain; no historical pop-ins.
    for (const outcome of input.outcomes ?? []) {
      if (!isTerminal(outcome.status)) continue;
      state = { ...state,
        active: state.active.filter(row => row.runKey !== outcome.runKey),
        rows: state.rows.map(row => row.data.runKey === outcome.runKey
          ? startExit(row, outcome.status, now, layout) : row) };
    }
    state = advance(reflow(state, now), now); // Also handles zero-duration exits.
  }
  state = { ...state, nowMs: now };
  const rows: SubagentAnimatedRow[] = state.rows.map(row => {
    const exit = row.exit;
    const pulseDuration = exit ? exit.pulseUntil - exit.pulseAt : 0;
    const pulse = exit?.outcome && pulseDuration > 0 && now < exit.pulseUntil
      ? Math.sin(clamp((now - exit.pulseAt) / pulseDuration) * Math.PI * 2) ** 2 : 0;
    return { key: JSON.stringify([state.generation, row.data.runKey]), row: row.data,
      status: exit ? exit.outcome ?? 'unknown' : row.data.status,
      phase: exit ? 'exiting' : moving(row.opacity, now) ? 'entering' : 'active',
      y: value(row.y, now), opacity: opacity(row, now),
      highlight: pulse,
      tint: !exit?.outcome ? null : exit.outcome === 'completed' ? 'green' : exit.outcome === 'aborted' ? 'amber' : 'red' };
  });
  return { state, rows, containerHeight: value(state.height, now), targetHeight: state.height.to,
    animating: moving(state.height, now) || state.rows.some(row => !!row.exit || moving(row.y, now) || moving(row.opacity, now)) };
}
