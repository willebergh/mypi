/** Render-only DTOs modeled on mypi resource-status/subagents/todos/openai-usage.
 * No files, credentials, sessions, sockets or provider APIs are read at runtime.
 * Mock values below are authored demo data; live projections contain only published fields.
 */
import type { Presentation } from './presentation-protocol';
import { createDemoHudState, DEMO_CONTEXT_WINDOW, type DemoHudState } from './demo-hud.ts';
import type { LiveCaptionLine, LiveHudEvent, LiveHudTodoCounts, LiveHudTranscriptBlock } from './live-protocol.ts';

export type HudAgentStatus = 'queued' | 'starting' | 'thinking' | 'running' | 'completed' | 'failed' | 'aborted';
export interface HudAgent {
  id: number; label: string; task: string; cwd?: string; status: HudAgentStatus; activity?: string;
  model?: string; startedAt?: number; endedAt?: number; turns?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  tokensPerSecond?: number; contextTokens: number | null; contextWindow?: number;
  agentFiles?: number; loadedSkills?: number; todosCompleted?: number; todosTotal?: number;
}
export interface HudTodo { id: number; text: string; completed: boolean; completedAt?: number }
export interface HudUsageWindow {
  label: string; usedPercent?: number; remainingPercent?: number;
  resetAt?: number; resetAfterSeconds?: number; windowSeconds?: number;
}
export interface HudEvent {
  id: string; parentId: string | null; timestamp: number;
  role: LiveHudEvent['role']; summary: string; toolName?: string; isError?: boolean;
  /** Absent for the original authored demo events. */
  kind?: LiveHudEvent['kind']; status?: LiveHudEvent['status'];
}
/** Mirrors the existing Talk status event. It has detail strings, not stage IDs. */
export interface HudTalkStatus {
  state: 'idle' | 'connecting' | 'listening' | 'closing';
  mode?: 'facetime'; detail?: string; elapsedMs?: number;
}
/** Render-only voice boot projection, NOT a wire protocol or an answer/audio command.
 * Demo never claims an answer or opens audio; live uses validated structured state.
 */
export interface HudTalkPreflight {
  source: 'mock' | 'live' | 'offline'; status: HudTalkStatus;
  active?: boolean; generation?: string;
  steps: readonly { id: string; label: string }[];
  currentStep: number; readyToAnswer: boolean;
  audioEnabled: boolean; answerSubmitted: false;
}
export interface HudSnapshot {
  source: 'mock' | 'live' | 'offline';
  connection?: string;
  session: { id: string; name: string; cwd: string | null; branch: string | null; provider: string; model: string;
    startedAt: number | null; elapsedMs: number | null; status: 'thinking' | 'running' | 'idle' };
  context: { tokens: number | null; contextWindow: number | null; percent: number | null; tokensPerSecond?: number;
    source: 'mock' | 'live' | 'provider-usage' | 'estimate' | 'unknown' };
  talk: HudTalkPreflight;
  subagents: HudAgent[];
  todos: { items: HudTodo[]; nextId: number; counts?: LiveHudTodoCounts };
  usage: { status: 'inactive' } | { status: 'loading' } | { status: 'error'; message: string; updatedAt: number }
    | { status: 'ready'; snapshot: { planType?: string; primary?: HudUsageWindow; secondary?: HudUsageWindow; updatedAt: number } };
  transcript: LiveHudTranscriptBlock[];
  /** Live in-call speech only; absent in authored demo data. */
  captions?: LiveCaptionLine[];
  presentation?: Presentation; // Metadata only; scene image feed is separate.
  /** Authored demo metadata only; live Activity uses transcript exclusively. */
  events: HudEvent[];
  files: { path: string; action: 'read' | 'edit' | 'create' }[];
}

const EPOCH = Date.UTC(2026, 9, 18, 16, 0, 0); // Deliberately fixed demo clock, not actual session time.
// Compatibility fixtures for explicit Demo on an older main. No state drift.
const DEFAULT_DEMO_HUD = createDemoHudState(EPOCH);
const events: HudEvent[] = [
  { id: 'demo-01', parentId: null, timestamp: EPOCH + 50000, role: 'user', summary: 'Compose a screen-lit workspace.' },
  { id: 'demo-02', parentId: 'demo-01', timestamp: EPOCH + 54000, role: 'assistant', summary: 'Splitting material and lighting review.' },
  { id: 'demo-03', parentId: 'demo-02', timestamp: EPOCH + 61000, role: 'toolResult', toolName: 'read', summary: 'Scene configuration inspected', isError: false },
  { id: 'demo-04', parentId: 'demo-03', timestamp: EPOCH + 92000, role: 'toolResult', toolName: 'edit', summary: 'Screen emission adjusted', isError: false },
  { id: 'demo-05', parentId: 'demo-04', timestamp: EPOCH + 121000, role: 'toolResult', toolName: 'bash', summary: 'Authored fixture: panel contrast comparison', isError: false },
  { id: 'demo-06', parentId: 'demo-05', timestamp: EPOCH + 145000, role: 'assistant', summary: 'Reviewing the portrait composition.' },
];
const files: HudSnapshot['files'] = [
  { path: 'src/avatar/robot.ts', action: 'read' }, { path: 'src/avatar/room.ts', action: 'edit' },
  { path: 'src/avatar/hud.ts', action: 'create' }, { path: 'src/shared/hud-data.ts', action: 'create' },
];

// Source ordering: talk/facetime-mode.ts incoming/prepare, index.ts start,
// codex.ts startNative. Labels/IDs are presentation, not real progress enums.
const talkSteps = [
  { id: 'allowed', label: 'Allowed incoming call' },
  { id: 'session', label: 'Prepare Pi voice session' },
  { id: 'summary', label: 'Summarize conversation context' },
  { id: 'native', label: 'Start native audio / gates closed' },
  { id: 'offer', label: 'Create WebRTC offer' },
  { id: 'codex', label: 'Connect to Codex voice' },
  { id: 'webrtc', label: 'Establish WebRTC audio' },
  { id: 'voice-ready', label: 'Voice ready / audio still gated' },
  { id: 'answer-ready', label: 'Ready to answer' },
] as const;
const talkDetails = [
  'preparing',
  'Reading Pi credentials and preparing native audio…',
  'Summarizing this Pi conversation…',
  'Starting native microphone and speaker…',
  'Creating native WebRTC offer…',
  'Connecting to Codex voice…',
  'Establishing WebRTC audio…',
  'Waiting for FaceTime connection…',
  'Waiting for FaceTime connection…',
] as const;
export function mockTalkPreflight(timeSeconds: number): HudTalkPreflight {
  // One-shot demo boot: once ready, hold readiness so the robot keeps its eyes.
  // Never emits answer/connection evidence or implies an actual call occurred.
  const elapsed = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
  const currentStep = Math.min(talkSteps.length - 1, Math.floor(elapsed / 1.8));
  return {
    source: 'mock', steps: talkSteps, currentStep,
    readyToAnswer: currentStep === talkSteps.length - 1,
    audioEnabled: false, answerSubmitted: false,
    status: { state: currentStep === 0 ? 'idle' : currentStep >= 7 ? 'listening' : 'connecting',
      mode: 'facetime', detail: talkDetails[currentStep], elapsedMs: Math.floor(elapsed * 1000) },
  };
}

/** Main-controlled fixtures; renderer time drives only the existing mock preflight.
 * Context, usage, agent status and todos never drift or override editor choices.
 */
export function mockHudSnapshot(timeSeconds: number, demo: DemoHudState = DEFAULT_DEMO_HUD): HudSnapshot {
  const elapsedMs = 8 * 60000 + Math.max(0, Math.floor(timeSeconds * 1000));
  const completed = demo.todos.filter(todo => todo.completed).length;
  const snapshot: HudSnapshot = {
    source: 'mock',
    session: { id: `demo-session-${demo.generation}`, name: 'Demo · authored scene study', cwd: '/workspace/scene-studio', branch: 'demo/hud-study',
      provider: 'openai-codex', model: 'gpt-5.4', startedAt: EPOCH, elapsedMs, status: 'running' },
    context: { tokens: DEMO_CONTEXT_WINDOW * demo.mainContextPercent / 100, contextWindow: DEMO_CONTEXT_WINDOW,
      percent: demo.mainContextPercent, source: 'mock' },
    talk: mockTalkPreflight(timeSeconds),
    subagents: demo.agents.map(a => ({ id: a.id, label: a.label, task: a.task, model: a.model, status: a.status,
      startedAt: a.startedAt, ...(a.endedAt === undefined ? {} : { endedAt: a.endedAt }),
      contextTokens: DEMO_CONTEXT_WINDOW * a.contextPercent / 100, contextWindow: DEMO_CONTEXT_WINDOW })),
    todos: { items: demo.todos.map(todo => ({ ...todo })).sort((a, b) => a.id - b.id), nextId: demo.nextTodoId,
      counts: { total: demo.todos.length, completed, pending: demo.todos.length - completed } },
    usage: { status: 'ready', snapshot: { planType: 'demo', updatedAt: demo.updatedAt,
      primary: { label: '5h', usedPercent: 24, remainingPercent: 76, resetAfterSeconds: 10800, windowSeconds: 18000 },
      secondary: { label: 'weekly', usedPercent: demo.weeklyUsedPercent, remainingPercent: 100 - demo.weeklyUsedPercent,
        resetAfterSeconds: 345600, windowSeconds: 604800 } } },
    transcript: events.map(event => ({ id: event.id,
      role: event.role === 'toolResult' ? 'tool' : event.role === 'system' ? 'custom' : event.role,
      text: event.summary })),
    events, files,
  };
  if (!demo.offline) return snapshot;
  // Explicit demo offline fixture, not a real feed failure or live fallback.
  return { ...snapshot, source: 'offline', connection: 'demo offline',
    session: { ...snapshot.session, name: 'Demo offline', status: 'idle' },
    context: { tokens: null, contextWindow: null, percent: null, source: 'unknown' },
    talk: { source: 'mock', active: false, steps: [{ id: 'demo-offline', label: 'Demo offline' }], currentStep: 0,
      readyToAnswer: false, audioEnabled: false, answerSubmitted: false, status: { state: 'idle' } },
    subagents: [], todos: { items: [], nextId: demo.nextTodoId }, usage: { status: 'inactive' }, transcript: [], events: [], files: [] };
}
