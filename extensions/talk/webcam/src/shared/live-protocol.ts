import type { Presentation } from './presentation-protocol';
import type { DemoHudState } from './demo-hud';

/** Read-only Pi → webcam projection. Bounded public display text; no commands, raw tool payloads or audio. */
export const LIVE_HUD_VERSION = 1;
export const LIVE_HUD_MAX_BYTES = 128 * 1024;
export const LIVE_HUD_STALE_MS = 5000;
export const LIVE_HUD_MAX_EVENTS = 10;
export const LIVE_HUD_MAX_TRANSCRIPT_BLOCKS = 10;
/** UTF-8 bytes, not JavaScript string length. */
export const LIVE_HUD_MAX_TRANSCRIPT_TEXT = 2048;
export const LIVE_HUD_MAX_TRANSCRIPT_BYTES = 32768;
/** Public visible text only; opaque local identity, chronological array order.
 * Roles are internal styling hints, never displayed metadata prefixes.
 * Nonempty text permits newline/tab, but no other controls, bidi or terminal escapes.
 */
export interface LiveHudTranscriptBlock {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'custom';
  text: string;
}
/** Tool identifiers only, never paths, arguments or display/error text. */
export const LIVE_HUD_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,47}$/;
export interface LiveHudEvent {
  /** Locally generated opaque ID; never a provider/tool/session-entry ID. */
  id: string;
  timestamp: number;
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  kind: 'user_turn' | 'assistant_finished' | 'tool' | 'run' | 'compaction';
  status: 'received' | 'finished' | 'started' | 'completed' | 'failed' | 'settled' | 'aborted' | 'recorded';
  toolName?: string;
}
/** No arbitrary summaries on the wire. Reconstructed tool history has no inferred outcome. */
export function activitySummary(event: LiveHudEvent): string {
  if (event.kind === 'user_turn') return 'User turn received';
  if (event.kind === 'assistant_finished') return 'Assistant response finished';
  if (event.kind === 'tool') return `Tool ${event.status === 'recorded' ? 'result recorded' : event.status}`;
  return `${event.kind === 'run' ? 'Run' : 'Compaction'} ${event.status}`;
}
export const TALK_CAPTIONS_EVENT = 'mypi:talk-captions-changed';
export const LIVE_CAPTION_MAX_TEXT = 1024; // UTF-8 bytes per speaker
export const LIVE_CAPTION_PARTIAL_MS = 8000;
export const LIVE_CAPTION_FINAL_MS = 4000;
export interface LiveCaptionLine {
  /** Locally generated opaque identity, never a provider item/turn ID. */
  id: string;
  speaker: 'user' | 'assistant';
  text: string;
  final: boolean;
  updatedAt: number;
  expiresAt: number;
}
/** Complete latest per-speaker replacement, never a transcript history. */
export interface LiveCaptions {
  runId: string;
  lines: LiveCaptionLine[];
}
/** FaceTime's local audio gate opens only for an owned verified connected call.
 * Regular physical/virtual Talk deliberately does not publish camera captions. */
export function captionCallActive(talk: TalkVisualState): boolean {
  return talk.mode === 'facetime' && talk.phase === 'connected' && !!talk.runId
    && talk.voiceReady && talk.audioEnabled;
}
export const TALK_VISUAL_EVENT = 'mypi:talk-visual-changed';
export type TalkVisualPhase = 'idle' | 'standby' | 'preparing' | 'summarizing' | 'starting-native' | 'creating-offer' | 'connecting-voice' | 'connecting-audio' | 'ready' | 'connected' | 'stopping' | 'error';
export interface TalkVisualState {
  phase: TalkVisualPhase;
  mode: 'physical' | 'virtual' | 'facetime' | 'inactive';
  /** New for each voice attempt; fences readiness animation between calls. */
  runId?: string;
  /** Peer/voice setup succeeded. Does not authorize answering or imply open audio. */
  voiceReady: boolean;
  /** Authoritative local Talk audio gate only; never derived from display text. */
  audioEnabled: boolean;
  elapsedMs?: number;
}
/** Full current validated todo state, BEFORE the producer's 48-row limit.
 * Optional for legacy publishers; absence means full totals are unknown.
 * Nonnegative safe integers; total = pending + completed; each category must
 * cover its transmitted rows. Fixed-size metadata, never inferred from IDs. */
export interface LiveHudTodoCounts {
  total: number;
  pending: number;
  completed: number;
}
export interface LiveHudSnapshot {
  version: 1;
  streamId: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  /** Rotates on active-branch navigation; not a source leaf/branch identifier. */
  branchId: string;
  /** Legacy metadata remains compatible, but is not Activity display content. */
  events: LiveHudEvent[];
  transcript?: LiveHudTranscriptBlock[];
  captions?: LiveCaptions;
  /** Explicit presentation metadata only; prepared image bytes use separate main IPC. */
  presentation?: Presentation;
  /** Optional v1 HUD evolution: opaque publisher/session/branch display generation. */
  displayScopeId?: string;
  session: {
    provider: string;
    model: string;
    status: 'idle' | 'thinking' | 'running';
    startedAt: number;
    elapsedMs: number;
  };
  context: { tokens: number | null; contextWindow: number | null; percent: number | null; tokensPerSecond?: number };
  agents: {
    id: number; label: string; task: string;
    status: 'queued' | 'starting' | 'thinking' | 'running' | 'completed' | 'failed' | 'aborted';
    model?: string; startedAt?: number; endedAt?: number;
    contextTokens: number | null; contextWindow?: number; tokensPerSecond?: number;
  }[];
  todos: { id: number; text: string; completed: boolean; completedAt?: number }[];
  todoCounts?: LiveHudTodoCounts;
  usage: {
    status: 'inactive' | 'loading' | 'error' | 'ready';
    weekly?: { remainingPercent: number | null; usedPercent: number | null; resetAt?: number };
    updatedAt?: number;
  };
  talk: TalkVisualState;
}
export interface LiveHudState {
  mode: 'live' | 'demo';
  connection: 'offline' | 'connecting' | 'live' | 'stale' | 'error';
  /** Generic diagnostics only, never raw errors or private filesystem paths. */
  detail?: string;
  snapshot: LiveHudSnapshot | null;
  /** Main-authored fixtures, never accepted by the Pi live protocol. Absent on older main. */
  demo?: DemoHudState;
}
export function idleTalkVisual(): TalkVisualState {
  return { phase: 'idle', mode: 'inactive', voiceReady: false, audioEnabled: false };
}
