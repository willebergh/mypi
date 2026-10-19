import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, live } from './live-test-support.mjs';
const { createHud, activityLines } = await import('../src/avatar/hud.ts');
const { projectLiveHud } = await import('../src/shared/live-projection.ts');
const { DEFAULT_SCENE_CONFIG } = await import('../src/shared/scene-config.ts');

test('camera HUD retains active subagent model/tokens without task text and paints main activity', t => {
  const previous = globalThis.document;
  const painted = [];
  const context = new Proxy({
    fillText: value => painted.push(String(value)),
    measureText: value => ({ width: String(value).length * 5 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => {} });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const value = projectLiveHud(live(snapshot(1, {
    agents: [{ id: 1, label: 'Scene agent', task: 'TASK TEXT HIDDEN', model: 'worker-model', status: 'running', contextTokens: null }],
    events: [{ id: 'event-a', timestamp: 1000, kind: 'tool', role: 'toolResult', status: 'failed', toolName: 'read' }],
    transcript: [{ id: 'text-a', role: 'tool', text: 'Actual compact preview' }],
    todos: [{ id: 1, text: 'TODO TEXT SHOWN', completed: false }],
  })));
  const hud = createHud(() => value);
  t.after(() => hud.dispose());
  hud.update(DEFAULT_SCENE_CONFIG, 1, 0);
  assert.ok(!painted.includes('TASK TEXT HIDDEN'));
  assert.ok(painted.includes('worker-model'));
  assert.ok(painted.includes('#1 TODO TEXT SHOWN'));
  assert.ok(painted.includes('1 received'));
  assert.ok(painted.includes('IDLE'));
  assert.ok(painted.includes('Actual compact preview'));
  assert.ok(!painted.includes('read') && !painted.includes('FAIL'));
  assert.ok(!painted.some(text => /Tool failed|Assistant response finished|Tool completed|^\[(user|assistant|tool)\]/.test(text)));
  assert.ok(!painted.some(text => text.includes('/workspace') || text.includes('low-signal')));
});

test('Activity wraps paragraphs/code indentation and keeps a chronological line-budget tail with internal roles', () => {
  const blocks = [{ id: 'a', role: 'user', text: 'First paragraph\n\n    code\n\tmore' },
    { id: 'b', role: 'assistant', text: 'Recent answer wraps here' }];
  const lines = activityLines(blocks, text => text.length, 18, 20);
  assert.deepEqual(lines.map(line => line.text), ['First paragraph', '', '    code', '    more', 'Recent answer ', 'wraps here']);
  assert.deepEqual(lines.map(line => line.role), ['user', 'user', 'user', 'user', 'assistant', 'assistant']);
  assert.deepEqual(activityLines(blocks, text => text.length, 18, 4), lines.slice(-4));
  assert.deepEqual(activityLines([{ id: 'c', role: 'tool', text: '    long code words next' }], text => text.length, 15, 6)
    .map(line => line.text), ['    long code ', '    words next']);
  assert.deepEqual(activityLines([], text => text.length, 18, 6), []);
});

test('todos paint full totals, explicit omissions and IDs without marking pending work complete', t => {
  const previous = globalThis.document;
  const painted = [], centers = [];
  const context = new Proxy({
    fillText: value => painted.push(String(value)),
    fillRect: (x, y, w, h) => { if (x === 19 && w === 4 && h === 4) centers.push([x, y]); },
    measureText: value => ({ width: String(value).length * 5 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => {} });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const items = Array.from({ length: 55 }, (_, i) => ({ id: i + 1, text: `Task ${i + 1}`, completed: i < 48 }));
  let value = projectLiveHud(live(snapshot(1, { todos: [...items.slice(48), ...items.slice(0, 41)],
    todoCounts: { total: 55, pending: 7, completed: 48 } })));
  const hud = createHud(() => value);
  t.after(() => hud.dispose());
  const config = { ...DEFAULT_SCENE_CONFIG, hudSession: false, hudSubagents: false, hudWeekly: false, hudTodos: true };
  const update = (mode, time) => { painted.length = centers.length = 0; hud.update({ ...config, hudMode: mode }, time, 0); };
  update('dashboard', 1);
  assert.ok(painted.includes('48/55 done'));
  assert.deepEqual(painted.filter(label => label.startsWith('#')), [49, 50, 51, 52, 53].map(id => `#${id} Task ${id}`));
  assert.ok(painted.includes('+2 pending · +48 done hidden'));
  assert.equal(centers.length, 0, 'next pending is only an outline, never a completed center');
  update('minimal', 2); // Legacy config must render the same Dashboard rows.
  assert.deepEqual(painted.filter(label => label.startsWith('#')), [49, 50, 51, 52, 53].map(id => `#${id} Task ${id}`));
  assert.ok(painted.includes('+2 pending · +48 done hidden'));
  assert.equal(centers.length, 0);
  value = projectLiveHud(live(snapshot(2, { todos: items.slice(0, 48), todoCounts: { total: 60, pending: 0, completed: 60 } })));
  update('dashboard', 3);
  assert.ok(painted.includes('60/60 done'));
  assert.ok(painted.includes('+59 done hidden'));
  assert.equal(centers.length, 1, 'at most one completed history row has a filled center');
  value = projectLiveHud(live(snapshot(3, { todos: items.slice(48) })));
  update('dashboard', 4);
  assert.ok(painted.includes('7 received'));
  assert.ok(painted.includes('+2 pending hidden (received)'));
  assert.ok(!painted.some(label => label.includes('/7')));
  value = projectLiveHud(live(snapshot(4, { todos: [], todoCounts: { total: 0, pending: 0, completed: 0 } })));
  update('dashboard', 5);
  assert.ok(painted.includes('0/0 done') && painted.includes('No tasks'));
  value = projectLiveHud({ ...live(snapshot()), connection: 'stale' });
  update('dashboard', 6);
  assert.ok(painted.includes('N/A') && painted.includes('Pi stale · no todo data'));
  assert.ok(!painted.includes('0/0 done'));
});

test('weekly/session/activity stack has real spacing in both orientations, independent of agents, with one snapshot per update', t => {
  const previous = globalThis.document;
  const painted = [];
  const context = new Proxy({
    fillText: value => painted.push(String(value)), measureText: value => ({ width: String(value).length * 5 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : () => {} });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const value = projectLiveHud(live(snapshot(1, {
    agents: Array.from({ length: 3 }, (_, id) => ({ id, label: `worker-${id}`, task: 'HIDDEN TASK', status: 'running', contextTokens: null })),
    transcript: Array.from({ length: 10 }, (_, i) => ({ id: `b-${i}`, role: 'tool', text: `tool_${i}` })),
  })));
  let reads = 0;
  const hud = createHud(() => { reads++; return value; });
  t.after(() => hud.dispose());
  const config = { ...DEFAULT_SCENE_CONFIG, hudMode: 'dashboard', hudSession: true, hudWeekly: true, hudSubagents: true, hudTodos: true,
    hudInsetTop: 15, hudInsetBottom: 15, hudInsetLeft: 15, hudInsetRight: 15,
    hudPortraitInsetTop: 15, hudPortraitInsetBottom: 15, hudPortraitInsetLeft: 15, hudPortraitInsetRight: 15 };
  const update = (config, time) => { const before = reads; hud.update(config, time, 0); assert.equal(reads, before + 1); };
  const boxes = () => hud.scene.children[0].children.map(mesh => ({ x: mesh.position.x - mesh.scale.x / 2,
    y: mesh.position.y - Math.abs(mesh.scale.y) / 2, w: mesh.scale.x, h: Math.abs(mesh.scale.y) }));
  const stacked = () => {
    const [weekly, session, events, agents, todos] = boxes();
    assert.equal(events.x, session.x);
    assert.ok(session.y >= weekly.y + weekly.h + 10);
    assert.ok(events.y >= session.y + session.h + 10);
    return { events, agents, todos };
  };
  update(config, 1);
  stacked();
  assert.ok(painted.includes('tool_4') && painted.includes('tool_9'));
  assert.ok(!painted.includes('tool_3') && !painted.includes('HIDDEN TASK'));
  hud.resize(720, 1280);
  update(config, 2);
  const portrait = stacked();
  assert.ok(portrait.agents.y >= portrait.events.y + portrait.events.h + 16);
  assert.ok(portrait.todos.y >= portrait.agents.y + portrait.agents.h + 16);
  const eventY = portrait.events.y;
  update(config, 4); // Finish openings before testing independent exits.
  update({ ...config, hudSubagents: false }, 5);
  update({ ...config, hudSubagents: false }, 6);
  assert.equal(boxes().length, 4);
  assert.equal(boxes()[2].y, eventY);
  update({ ...config, hudSubagents: false, hudSession: false }, 7);
  update({ ...config, hudSubagents: false, hudSession: false }, 8);
  assert.equal(boxes().length, 2); // Weekly + Todos; Session toggle owns Activity too.
});
