import { captionCallActive, LIVE_HUD_STALE_MS, type LiveHudState, type TalkVisualPhase } from './live-protocol.ts';
import { parsePresentation } from './presentation-protocol.ts';
import { mockHudSnapshot, type HudSnapshot, type HudTalkPreflight } from './hud-data.ts';

const phases: readonly TalkVisualPhase[] = ['preparing', 'summarizing', 'starting-native', 'creating-offer', 'connecting-voice', 'connecting-audio', 'ready', 'connected'];
const steps = [
  'Prepare voice session', 'Summarize context', 'Start native audio', 'Create voice offer',
  'Connect voice', 'Connect audio', 'Voice ready', 'Connected',
].map((label, i) => ({ id: phases[i], label }));
export const OFFLINE_LIVE_HUD: LiveHudState = { mode: 'live', connection: 'offline', snapshot: null };

/** Presentation only. Unknowns stay null/absent; never synthesizes cwd, files or message events. */
export function projectLiveHud(state: LiveHudState, timeSeconds = 0, now = Date.now()): HudSnapshot {
  if (state.mode === 'demo') return mockHudSnapshot(timeSeconds, state.demo);
  const s = state.connection === 'live' ? state.snapshot : null;
  const identity = s ? state.multisession?.sessions.find(row => row.isActive) : undefined;
  const talk = s?.talk;
  const captions = s?.captions;
  const active = !!talk && talk.mode !== 'inactive' && phases.includes(talk.phase);
  const ready = active && !!talk?.voiceReady && (talk.phase === 'ready' || talk.phase === 'connected');
  const preflight: HudTalkPreflight = {
    source: s ? 'live' : 'offline', active, generation: s ? JSON.stringify([s.streamId, s.sessionId, s.talk.runId ?? null]) : 'offline',
    steps: active ? steps : [{ id: talk?.phase ?? 'offline', label: !s ? `Pi ${state.connection}` : talk?.phase === 'error' ? 'Voice unavailable' : talk?.phase === 'stopping' ? 'Stopping voice' : 'No active call' }],
    currentStep: active ? Math.max(0, phases.indexOf(talk!.phase)) : 0,
    readyToAnswer: ready, audioEnabled: active && !!talk?.audioEnabled, answerSubmitted: false,
    status: { state: !active ? 'idle' : ready ? 'listening' : 'connecting', elapsedMs: talk?.elapsedMs },
  };
  return {
    source: s ? 'live' : 'offline', connection: state.connection,
    session: { id: s?.sessionId ?? '', name: s ? identity?.name || 'Pi session' : `Pi ${state.connection}`, cwd: identity?.cwd ?? null, branch: null,
      provider: s?.session.provider ?? '', model: s?.session.model ?? '', startedAt: s?.session.startedAt ?? null,
      elapsedMs: s?.session.elapsedMs ?? null, status: s?.session.status ?? 'idle' },
    context: { tokens: s?.context.tokens ?? null, contextWindow: s?.context.contextWindow ?? null,
      percent: s?.context.percent ?? null, tokensPerSecond: s?.context.tokensPerSecond,
      source: s ? 'live' : 'unknown' },
    talk: preflight,
    subagents: s?.agents.map(a => ({ ...a })) ?? [],
    todos: { items: s?.todos.map(t => ({ ...t })) ?? [], nextId: 0,
      ...(s?.todoCounts ? { counts: { ...s.todoCounts } } : {}) },
    usage: !s || s.usage.status === 'inactive' ? { status: 'inactive' }
      : s.usage.status === 'ready' ? { status: 'ready', snapshot: { updatedAt: s.usage.updatedAt ?? s.timestamp,
        secondary: s.usage.weekly ? { label: 'weekly', usedPercent: s.usage.weekly.usedPercent ?? undefined,
          remainingPercent: s.usage.weekly.remainingPercent ?? undefined, resetAt: s.usage.weekly.resetAt } : undefined } }
      : s.usage.status === 'loading' ? { status: 'loading' }
      : { status: 'error', message: 'Usage unavailable', updatedAt: s.usage.updatedAt ?? s.timestamp },
    // Only the safe display DTO crosses into Activity; never reconstruct text
    // from legacy events or carry raw message/result objects into the renderer.
    transcript: s?.transcript?.map(block => ({ id: block.id, role: block.role, text: block.text })) ?? [],
    // Expiry is absolute, not restarted by heartbeat, subscription or renderer
    // creation. Also clear locally if main stops delivering connection updates.
    captions: s && captionCallActive(s.talk) && captions && captions.runId === s.talk.runId
      && now - s.timestamp < LIVE_HUD_STALE_MS && s.timestamp - now <= 1000
      ? captions.lines.filter(line => line.expiresAt > now && line.updatedAt <= now + 1000)
        .map(line => ({ ...line })) : [],
    ...(s && now - s.timestamp < LIVE_HUD_STALE_MS && s.timestamp - now <= 1000
      && s.presentation ? { presentation: parsePresentation(s.presentation, {
        displayScopeId: s.displayScopeId,
        callRunId: captionCallActive(s.talk) ? s.talk.runId : undefined,
      }) } : {}),
    events: [],
    files: [],
  };
}

/** Readiness is not latched across stops, reconnects, session changes, or a new preparation. */
export function createTalkReadiness() {
  let generation: string | undefined, readyAt: number | null = null, previousTime = -Infinity;
  return (talk: HudTalkPreflight, time: number): number | null => {
    if (generation !== talk.generation || time < previousTime || !talk.readyToAnswer) readyAt = null;
    generation = talk.generation; previousTime = time;
    if (talk.readyToAnswer && readyAt === null) readyAt = time;
    return readyAt;
  };
}
