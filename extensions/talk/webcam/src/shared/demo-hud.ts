/** Authored, bounded display fixtures only. No Pi/session/tool/voice authority.
 * Main owns this state; editor submits strict actions, never arbitrary snapshots.
 */
import type { HudAgentStatus, HudTodo } from './hud-data';

export const DEMO_HUD_VERSION = 1;
export const DEMO_MAX_AGENTS = 12;
export const DEMO_MAX_TODOS = 48;
export const DEMO_TERMINAL_MS = 3000;
export const DEMO_CONTEXT_WINDOW = 128000;
const MAX_ID = 1_000_000_000;
export interface DemoAgent {
  id: number; label: string; task: string; model: string;
  status: HudAgentStatus; contextPercent: number; startedAt: number; endedAt?: number;
}
export interface DemoHudState {
  version: 1; generation: number; updatedAt: number; offline: boolean;
  mainContextPercent: number; weeklyUsedPercent: number;
  nextAgentId: number; nextTodoId: number;
  agents: DemoAgent[]; todos: HudTodo[];
}
export type DemoHudAction = { version: 1 } & (
  | { type: 'reset' | 'agent-add' | 'agents-clear' | 'todo-add' | 'todos-clear' }
  | { type: 'offline'; value: boolean }
  | { type: 'main-context' | 'weekly'; percent: number }
  | { type: 'agent-context'; id: number; percent: number }
  | { type: 'agent-status'; id: number; status: HudAgentStatus }
  | { type: 'agent-reopen' | 'agent-remove' | 'agent-up' | 'todo-toggle' | 'todo-remove'; id: number }
);
const statuses: readonly HudAgentStatus[] = ['queued', 'starting', 'thinking', 'running', 'completed', 'failed', 'aborted'];
export const demoAgentTerminal = (status: HudAgentStatus) => status === 'completed' || status === 'failed' || status === 'aborted';

/** Exact action allowlist: no inbound text, arrays, paths, images or live fields.
 * Every string is a fixed protocol enum; numbers are small bounded integers.
 */
export function parseDemoHudAction(value: unknown): DemoHudAction {
  const invalid = () => { throw new Error('Invalid Demo HUD action'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  if (v.version !== DEMO_HUD_VERSION || typeof v.type !== 'string') return invalid();
  let fields: string[];
  switch (v.type) {
    case 'reset': case 'agent-add': case 'agents-clear': case 'todo-add': case 'todos-clear': fields = []; break;
    case 'offline':
      if (typeof v.value !== 'boolean') return invalid();
      fields = ['value']; break;
    case 'main-context': case 'weekly': fields = ['percent']; break;
    case 'agent-context': fields = ['id', 'percent']; break;
    case 'agent-status':
      if (!statuses.includes(v.status as HudAgentStatus)) return invalid();
      fields = ['id', 'status']; break;
    case 'agent-reopen': case 'agent-remove': case 'agent-up': case 'todo-toggle': case 'todo-remove': fields = ['id']; break;
    default: return invalid();
  }
  for (const key of fields.filter(key => key === 'id' || key === 'percent')) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < (key === 'id' ? 1 : 0)
      || n > (key === 'id' ? MAX_ID : 100)) return invalid();
  }
  const keys = ['version', 'type', ...fields];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))) return invalid();
  return Object.fromEntries(keys.map(key => [key, v[key]])) as DemoHudAction;
}
const studies = [
  ['material-study', 'Review fictional scene materials', 'gpt-5.4'],
  ['light-review', 'Compare authored lighting references', 'claude-sonnet-4-6'],
  ['layout-review', 'Review fictional portrait layout', 'gpt-5.4-mini'],
] as const;
function agent(id: number, now: number, index = id - 1): DemoAgent {
  const [label, task, model] = studies[index % studies.length]!;
  return { id, label: `${label}-${id}`, task, model, status: 'running', contextPercent: 25, startedAt: now };
}
export function createDemoHudState(now = Date.UTC(2026, 9, 18, 16), generation = 1, nextAgentId = 1, nextTodoId = 1): DemoHudState {
  return { version: 1, generation, updatedAt: now, offline: false, mainContextPercent: 68, weeklyUsedPercent: 61,
    nextAgentId: nextAgentId + 3, nextTodoId: nextTodoId + 6,
    agents: [0, 1, 2].map(i => ({ ...agent(nextAgentId + i, now, i),
      status: (['running', 'thinking', 'queued'] as const)[i]!, contextPercent: [29, 15, 0][i]! })),
    todos: ['Inspect scene references', 'Draft panel spacing', 'Review portrait layout', 'Refine panel contrast', 'Compare context bars', 'Review empty states']
      .map((text, i) => ({ id: nextTodoId + i, text, completed: i === 0, ...(i === 0 ? { completedAt: now } : {}) })),
  };
}
/** One-shot expiration; repeated terminal frames never extend their deadline. */
export function expireDemoAgents(state: DemoHudState, now: number): DemoHudState {
  const agents = state.agents.filter(a => a.endedAt === undefined || now < a.endedAt + DEMO_TERMINAL_MS);
  return agents.length === state.agents.length ? state : { ...state, agents, updatedAt: now };
}
export function reduceDemoHud(state: DemoHudState, action: DemoHudAction, now: number): DemoHudState {
  if (action.type === 'reset') {
    if (state.nextAgentId > MAX_ID - 3 || state.nextTodoId > MAX_ID - 6 || state.generation >= MAX_ID) throw new Error('Demo identity limit reached');
    return createDemoHudState(now, state.generation + 1, state.nextAgentId, state.nextTodoId);
  }
  let next = state;
  switch (action.type) {
    case 'offline': next = { ...state, offline: action.value }; break;
    case 'main-context': next = { ...state, mainContextPercent: action.percent }; break;
    case 'weekly': next = { ...state, weeklyUsedPercent: action.percent }; break;
    case 'agent-add':
      if (state.agents.length >= DEMO_MAX_AGENTS || state.nextAgentId >= MAX_ID) break;
      next = { ...state, nextAgentId: state.nextAgentId + 1, agents: [...state.agents, agent(state.nextAgentId, now)] }; break;
    case 'agents-clear': next = { ...state, agents: [] }; break;
    case 'agent-remove': next = { ...state, agents: state.agents.filter(a => a.id !== action.id) }; break;
    case 'agent-up': {
      const agents = [...state.agents], i = agents.findIndex(a => a.id === action.id);
      if (i <= 0) break;
      [agents[i - 1], agents[i]] = [agents[i]!, agents[i - 1]!];
      next = { ...state, agents }; break;
    }
    case 'agent-context':
      next = { ...state, agents: state.agents.map(a => a.id === action.id && !demoAgentTerminal(a.status)
        ? { ...a, contextPercent: action.percent } : a) }; break;
    case 'agent-status':
      next = { ...state, agents: state.agents.map(a => a.id !== action.id || demoAgentTerminal(a.status) ? a
        : { ...a, status: action.status, ...(demoAgentTerminal(action.status) ? { endedAt: now } : {}) }) }; break;
    case 'agent-reopen': {
      if (state.nextAgentId >= MAX_ID) break;
      const previous = state.agents.find(a => a.id === action.id && demoAgentTerminal(a.status));
      if (!previous) break;
      const reopened: DemoAgent = { id: state.nextAgentId, label: previous.label, task: previous.task, model: previous.model,
        status: 'running', contextPercent: previous.contextPercent, startedAt: now };
      next = { ...state, nextAgentId: state.nextAgentId + 1, agents: state.agents.map(a => a === previous ? reopened : a) }; break;
    }
    case 'todo-add':
      if (state.todos.length >= DEMO_MAX_TODOS || state.nextTodoId >= MAX_ID) break;
      next = { ...state, nextTodoId: state.nextTodoId + 1,
        todos: [...state.todos, { id: state.nextTodoId, text: `Review authored scene detail ${state.nextTodoId}`, completed: false }] }; break;
    case 'todos-clear': next = { ...state, todos: [] }; break;
    case 'todo-remove': next = { ...state, todos: state.todos.filter(t => t.id !== action.id) }; break;
    case 'todo-toggle':
      next = { ...state, todos: state.todos.map(t => t.id !== action.id ? t : {
        id: t.id, text: t.text, completed: !t.completed, ...(!t.completed ? { completedAt: now } : {}),
      }) }; break;
  }
  return next === state ? state : { ...next, updatedAt: now };
}
