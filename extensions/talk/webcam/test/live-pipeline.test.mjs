import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, live } from './live-test-support.mjs';
const { projectAgents, projectTodos, projectUsage, projectTalk, projectContext } = await import('../../webcam-projection.ts');
const { parseLiveHudSnapshot } = await import('../src/shared/live-validation.ts');
const { projectLiveHud, createTalkReadiness } = await import('../src/shared/live-projection.ts');

test('real Pi projections survive the webcam wire validator, including fractional runtime clocks', () => {
  const context = projectContext({ model: { provider: 'openai-codex', id: 'test-model', contextWindow: 128000 },
    getContextUsage: () => ({ tokens: 6000, contextWindow: 128000, percent: 4.6875 }) }, 12.5);
  const todos = projectTodos({ state: { items: [{ id: 1, text: 'Link the HUD', completed: false }], nextId: 2 } });
  const value = snapshot(1, {
    session: { provider: context.provider, model: context.model, status: 'running', startedAt: Date.now() - 1000, elapsedMs: 1000.125 },
    context: context.context,
    agents: projectAgents({ states: [{ id: 1, label: 'Worker', task: 'Review the shared scene', status: 'running',
      contextTokens: 1200, contextWindow: 128000, tokensPerSecond: 20.25, cwd: '/private/not-on-wire', output: 'secret tool result' }] }),
    todos: todos.items, todoCounts: todos.counts,
    usage: projectUsage({ status: 'ready', snapshot: { updatedAt: Date.now(), secondary: {
      label: 'weekly', remainingPercent: 75, usedPercent: 25, windowSeconds: 604800, resetAt: Date.now() / 1000 + 600,
    } } }),
    talk: projectTalk({ phase: 'ready', mode: 'facetime', voiceReady: true, audioEnabled: false, elapsedMs: 13.375, runId: 'voice-attempt-one' }),
  });
  const decoded = parseLiveHudSnapshot(JSON.parse(JSON.stringify(value)));
  assert.ok(decoded, 'a legitimate producer snapshot must not drop the live connection');
  assert.equal(decoded.talk.runId, 'voice-attempt-one');
  assert.equal(decoded.talk.elapsedMs, 13.375);
  const projected = projectLiveHud(live(decoded));
  assert.equal(projected.source, 'live');
  assert.equal(projected.talk.readyToAnswer, true);
  assert.equal(projected.talk.audioEnabled, false);
  assert.equal(projected.todos.items[0].text, 'Link the HUD');
  assert.deepEqual(projected.todos.counts, { total: 1, pending: 1, completed: 0 });
  assert.deepEqual(projected.events, []);
  assert.deepEqual(projected.files, []);
  assert.doesNotMatch(JSON.stringify(decoded), /private|secret tool result/);
});

test('full counts and pending tail survive bounded producer, strict wire parser and live presentation', () => {
  const source = Array.from({ length: 103 }, (_, i) => ({ id: i + 1, text: `Task ${i + 1}`, completed: i < 50 }));
  const todos = projectTodos({ state: { items: source, nextId: 104 } });
  const decoded = parseLiveHudSnapshot(JSON.parse(JSON.stringify(snapshot(1, { todos: todos.items, todoCounts: todos.counts }))));
  assert.ok(decoded);
  const projected = projectLiveHud(live(decoded));
  assert.deepEqual(projected.todos.items.map(item => item.id), Array.from({ length: 48 }, (_, i) => i + 51));
  assert.deepEqual(projected.todos.counts, { total: 103, completed: 50, pending: 53 });
  assert.notEqual(projected.todos.counts, decoded.todoCounts);
  assert.deepEqual(projectLiveHud({ ...live(decoded), connection: 'stale' }).todos.items, []);
  assert.equal(projectLiveHud({ ...live(decoded), connection: 'stale' }).todos.counts, undefined);
});

test('a new voice attempt resets eye opening even when a fast restart skips the preparing snapshot', () => {
  const readiness = createTalkReadiness();
  const state = runId => projectLiveHud(live(snapshot(1, { talk: projectTalk({
    phase: 'ready', mode: 'facetime', voiceReady: true, audioEnabled: false, runId,
  }) })));
  assert.equal(readiness(state('one').talk, 10), 10);
  assert.equal(readiness(state('one').talk, 20), 10);
  assert.equal(readiness(state('two').talk, 21), 21);
});
