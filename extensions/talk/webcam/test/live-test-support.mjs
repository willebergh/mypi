export function snapshot(sequence = 0, overrides = {}) {
  return {
    version: 1, streamId: 'publisher-a', sessionId: 'session-a', branchId: 'branch-a', events: [], sequence, timestamp: Date.now(),
    session: { provider: 'openai-codex', model: 'test-model', status: 'idle', startedAt: 1000, elapsedMs: 123 },
    context: { tokens: null, contextWindow: null, percent: null }, agents: [], todos: [],
    usage: { status: 'inactive' }, talk: { phase: 'idle', mode: 'inactive', voiceReady: false, audioEnabled: false },
    ...overrides,
  };
}
export const line = record => `${JSON.stringify(record)}\n`;
export const demo = { mode: 'demo', connection: 'offline', snapshot: null };
export const live = value => ({ mode: 'live', connection: 'live', snapshot: value });
