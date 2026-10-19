// Source-only coverage. Not executed for the HUD simplification / Demo controls change.
import assert from 'node:assert/strict';
import test from 'node:test';
const { createDemoHudState, parseDemoHudAction, reduceDemoHud, expireDemoAgents,
  DEMO_MAX_AGENTS, DEMO_MAX_TODOS, DEMO_TERMINAL_MS, DEMO_CONTEXT_WINDOW } = await import('../src/shared/demo-hud.ts');
const { createDemoHudController } = await import('../src/main/demo-hud.ts');
const { projectLiveHud } = await import('../src/shared/live-projection.ts');
const { selectTodoDisplay } = await import('../src/shared/todo-display.ts');
const { validateSceneConfig, DEFAULT_SCENE_CONFIG } = await import('../src/shared/scene-config.ts');
const { reduceSubagentAnimation } = await import('../src/shared/subagent-animation.ts');
const action = (type, fields = {}) => parseDemoHudAction({ version: 1, type, ...fields });
const project = demo => projectLiveHud({ mode: 'demo', connection: 'offline', snapshot: null, demo }, 20);

test('strict Demo action DTO rejects extra fields, private text, arrays, enum/protocol/numeric overflow', () => {
  for (const value of [null, [], { version: 2, type: 'reset' }, { version: 1, type: 'live' },
    { version: 1, type: 'reset', text: 'private' }, { version: 1, type: 'todo-add', todos: [] },
    { version: 1, type: 'agent-status', id: 1, status: 'success' },
    { version: 1, type: 'offline', value: 1 }, ...[-1, 101, 1.5, NaN, Infinity, '50'].map(percent => ({ version: 1, type: 'weekly', percent })),
    ...[0, -1, 1.5, 1_000_000_001, Infinity, '1'].map(id => ({ version: 1, type: 'agent-remove', id }))]) {
    assert.throws(() => parseDemoHudAction(value), /Invalid Demo/);
  }
  const dto = { version: 1, type: 'agent-context', id: 1, percent: 100 };
  assert.deepEqual(parseDemoHudAction(dto), dto);
  assert.notEqual(parseDemoHudAction(dto), dto);
});

test('controlled projection has consistent tokens/weekly complements and no timer-driven status/context drift', () => {
  let state = createDemoHudState(1000);
  const original = structuredClone(state);
  state = reduceDemoHud(state, action('main-context', { percent: 92 }), 2000);
  state = reduceDemoHud(state, action('weekly', { percent: 100 }), 2000);
  state = reduceDemoHud(state, action('agent-context', { id: 1, percent: 17 }), 2000);
  const p = project(state);
  assert.deepEqual([p.context.tokens, p.context.contextWindow, p.context.percent], [DEMO_CONTEXT_WINDOW * .92, DEMO_CONTEXT_WINDOW, 92]);
  assert.equal(p.subagents[0].contextTokens, DEMO_CONTEXT_WINDOW * .17);
  assert.equal(p.usage.snapshot.secondary.usedPercent, 100);
  assert.equal(p.usage.snapshot.secondary.remainingPercent, 0);
  const later = projectLiveHud({ mode: 'demo', connection: 'offline', snapshot: null, demo: state }, 9999);
  assert.deepEqual(later.context, p.context);
  assert.deepEqual(later.subagents, p.subagents);
  assert.deepEqual(later.usage, p.usage);
  assert.equal(p.source, 'mock');
  assert.equal(p.talk.audioEnabled, false);
  assert.equal(p.talk.answerSubmitted, false);
  assert.deepEqual(p.captions ?? [], []);
  assert.deepEqual(createDemoHudState(1000), original, 'fixture is deterministic and detached');
});

test('terminal outcomes are immutable, pulse green through the existing reducer, expire at three seconds, reopen uses new identity', () => {
  const before = createDemoHudState(1000);
  const state = reduceDemoHud(before, action('agent-status', { id: 1, status: 'completed' }), 2000);
  assert.equal(before.agents[0].status, 'running');
  assert.equal(state.agents[0].endedAt, 2000);
  const repeated = reduceDemoHud(state, action('agent-status', { id: 1, status: 'failed' }), 2500);
  assert.equal(repeated.agents[0].status, 'completed');
  assert.equal(repeated.agents[0].endedAt, 2000);
  assert.equal(expireDemoAgents(state, 2000 + DEMO_TERMINAL_MS - 1).agents.length, 3);
  assert.equal(expireDemoAgents(state, 2000 + DEMO_TERMINAL_MS).agents.length, 2);
  const reopened = reduceDemoHud(state, action('agent-reopen', { id: 1 }), 2100);
  assert.equal(reopened.agents[0].id, before.nextAgentId);
  assert.equal(reopened.agents[0].startedAt, 2100);
  assert.equal(reopened.agents[0].endedAt, undefined);
  assert.notEqual(reopened.agents[0].id, 1);
  const row = a => ({ ...a, contextTokens: 0, contextWindow: DEMO_CONTEXT_WINDOW, runKey: String(a.id) });
  const initial = reduceSubagentAnimation(undefined, { nowMs: 0, generation: 'demo', online: true, snapshot: before.agents.map(row) });
  const exited = reduceSubagentAnimation(initial.state, { nowMs: 200, generation: 'demo', online: true,
    snapshot: state.agents.filter(a => a.status !== 'completed').map(row), outcomes: [{ runKey: '1', status: 'completed' }] });
  assert.equal(exited.rows.find(r => r.row.id === 1).tint, 'green');
  assert.equal(exited.rows.find(r => r.row.id === 1).phase, 'exiting');
});

test('agent/todo collections are capped; reset/new entries have unique monotonic numeric IDs, ordering and full counts survive edits/empty', () => {
  let state = createDemoHudState(1000);
  for (let i = 0; i < 70; i++) {
    state = reduceDemoHud(state, action('agent-add'), 2000 + i);
    state = reduceDemoHud(state, action('todo-add'), 2000 + i);
  }
  assert.equal(state.agents.length, DEMO_MAX_AGENTS);
  assert.equal(state.todos.length, DEMO_MAX_TODOS);
  assert.equal(new Set(state.agents.map(a => a.id)).size, state.agents.length);
  assert.equal(new Set(state.todos.map(t => t.id)).size, state.todos.length);
  const movedId = state.agents[1].id;
  state = reduceDemoHud(state, action('agent-up', { id: movedId }), 3000);
  assert.equal(state.agents[0].id, movedId);
  state = reduceDemoHud(state, action('todo-toggle', { id: 2 }), 3000);
  assert.equal(state.todos[1].completedAt, 3000);
  state = reduceDemoHud(state, action('todo-toggle', { id: 2 }), 3100);
  assert.equal(state.todos[1].completedAt, undefined);
  for (const todo of state.todos.filter(t => !t.completed)) state = reduceDemoHud(state, action('todo-toggle', { id: todo.id }), 3200);
  const p = project(state), display = selectTodoDisplay(p.todos.items, 5);
  assert.deepEqual(p.todos.counts, { total: DEMO_MAX_TODOS, completed: DEMO_MAX_TODOS, pending: 0 });
  assert.equal(display.rows.length, 1);
  assert.equal(display.rows[0].id, DEMO_MAX_TODOS);
  state = reduceDemoHud(state, action('agents-clear'), 4000);
  state = reduceDemoHud(state, action('todos-clear'), 4000);
  assert.deepEqual(project(state).todos.counts, { total: 0, completed: 0, pending: 0 });
  assert.deepEqual(project(state).subagents, []);
  const reset = reduceDemoHud(state, action('reset'), 5000);
  assert.ok(reset.agents.every(a => a.id >= state.nextAgentId));
  assert.ok(reset.todos.every(t => t.id >= state.nextTodoId));
  assert.equal(reset.generation, state.generation + 1);
  assert.equal(reset.agents.length, 3);
  assert.equal(reset.todos.length, 6);
});

test('offline fixture is explicit; live projection ignores even supplied Demo state', () => {
  const demo = reduceDemoHud(createDemoHudState(1000), action('offline', { value: true }), 2000);
  const offline = project(demo);
  assert.equal(offline.source, 'offline');
  assert.equal(offline.connection, 'demo offline');
  assert.deepEqual(offline.subagents, []);
  assert.deepEqual(offline.transcript, []);
  assert.equal(offline.context.percent, null);
  const live = projectLiveHud({ mode: 'live', connection: 'offline', snapshot: null, demo });
  assert.equal(live.source, 'offline');
  assert.notEqual(live.session.id, offline.session.id);
  assert.equal(live.connection, 'offline');
});

test('one-shot main expiration publishes only while Demo, cancels on Live/dispose and fences old deadlines after reopen/reset', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000, published = 0;
  const controller = createDemoHudController(() => published++, () => now);
  t.after(() => controller.dispose());
  assert.throws(() => controller.update(action('reset')), /Select Demo/);
  controller.setActive(true);
  controller.update(action('agent-status', { id: 1, status: 'completed' }));
  assert.equal(published, 1);
  now += 2999; t.mock.timers.tick(2999);
  assert.equal(controller.read().agents.length, 3);
  now++; t.mock.timers.tick(1);
  assert.equal(controller.read().agents.length, 2);
  assert.equal(published, 2);
  controller.update(action('agent-status', { id: 2, status: 'completed' }));
  controller.update(action('agent-reopen', { id: 2 }));
  const reopened = controller.read().agents[0].id;
  now += 3000; t.mock.timers.tick(3000);
  assert.ok(controller.read().agents.some(a => a.id === reopened));
  controller.update(action('agent-status', { id: reopened, status: 'completed' }));
  controller.setActive(false);
  const frozen = controller.read(), count = published;
  now += 4000; t.mock.timers.tick(4000);
  assert.equal(controller.read(), frozen);
  assert.equal(published, count);
  assert.throws(() => controller.update(action('todo-add')), /Select Demo/);
  controller.setActive(true);
  assert.ok(!controller.read().agents.some(a => a.id === reopened));
  controller.update(action('reset'));
  const reset = controller.read();
  now += 4000; t.mock.timers.tick(4000);
  assert.equal(controller.read(), reset);
  controller.update(action('agent-status', { id: reset.agents[0].id, status: 'completed' }));
  controller.dispose();
  const disposed = controller.read(), afterDispose = published;
  now += 4000; t.mock.timers.tick(4000);
  assert.equal(controller.read(), disposed);
  assert.equal(published, afterDispose);
});

test('legacy Minimal configs canonicalize to Dashboard, while Off and independent panel flags stay unchanged', () => {
  assert.equal(validateSceneConfig({ ...DEFAULT_SCENE_CONFIG, hudMode: 'minimal' }).hudMode, 'dashboard');
  const off = validateSceneConfig({ ...DEFAULT_SCENE_CONFIG, hudMode: 'off', hudTodos: false, hudOpacity: .4, hudInsetTop: 5 });
  assert.equal(off.hudMode, 'off'); assert.equal(off.hudTodos, false);
  assert.equal(off.hudOpacity, .4); assert.equal(off.hudInsetTop, 5);
});
