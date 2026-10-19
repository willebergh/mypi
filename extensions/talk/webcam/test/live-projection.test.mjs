import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot, live, demo } from './live-test-support.mjs';
const { projectLiveHud: project, createTalkReadiness, OFFLINE_LIVE_HUD } = await import('../src/shared/live-projection.ts');
const { createLiveHudFeed, acquireLiveHudFeed } = await import('../src/shared/live-feed.ts');
const { mockHudSnapshot } = await import('../src/shared/hud-data.ts');

test('default/offline/stale projection contains no mock session or invented context, files or messages', () => {
  for (const connection of ['offline', 'connecting', 'stale', 'error']) {
    const p = project({ ...live(snapshot(1, { todos: [{ id: 1, text: 'Old', completed: false }],
      todoCounts: { total: 100, pending: 100, completed: 0 },
      transcript: [{ id: 'old', role: 'user', text: 'Old conversation' }] })), connection });
    assert.equal(p.source, 'offline');
    assert.deepEqual([p.context.tokens, p.context.contextWindow, p.context.percent], [null, null, null]);
    assert.deepEqual([p.session.cwd, p.session.branch, p.session.elapsedMs], [null, null, null]);
    assert.deepEqual([p.subagents, p.todos.items, p.events, p.files, p.transcript], [[], [], [], [], []]);
    assert.equal(p.todos.counts, undefined);
    assert.equal(p.talk.active, false);
    assert.equal(p.talk.readyToAnswer, false);
  }
  assert.equal(project(OFFLINE_LIVE_HUD).source, 'offline');
});
test('live projection preserves structured fields and unknown context, demo is explicit and unchanged', () => {
  const s = snapshot(1, { agents: [{ id: 4, label: 'worker', task: 'Review', status: 'thinking', contextTokens: null }],
    todos: [{ id: 8, text: 'Task', completed: false }],
    usage: { status: 'ready', weekly: { usedPercent: null, remainingPercent: null } } });
  const p = project(live(s), 100);
  assert.equal(p.source, 'live');
  assert.equal(p.session.model, s.session.model);
  assert.equal(p.context.contextWindow, null);
  assert.equal(p.subagents[0].contextTokens, null);
  assert.equal(p.subagents[0].cwd, undefined);
  assert.deepEqual(p.todos.items, s.todos);
  assert.equal(p.todos.counts, undefined, 'legacy received rows do not invent full totals');
  assert.deepEqual(p.events, []);
  assert.equal(p.usage.snapshot.secondary.usedPercent, undefined);
  assert.deepEqual(project(demo, 17), mockHudSnapshot(17));
});
test('authoritative todo summaries clone, replace and clear; demo counts reflect the actual demo array', () => {
  const s = snapshot(1, { todos: [{ id: 9, text: 'Pending', completed: false }, { id: 2, text: 'Done', completed: true }],
    todoCounts: { total: 60, pending: 12, completed: 48 } });
  const p = project(live(s));
  assert.deepEqual(p.todos.items.map(item => item.id), [9, 2]);
  assert.deepEqual(p.todos.counts, s.todoCounts);
  assert.notEqual(p.todos.counts, s.todoCounts);
  s.todoCounts.pending = 999;
  assert.equal(p.todos.counts.pending, 12);
  const empty = project(live(snapshot(2, { branchId: 'new-branch', todos: [], todoCounts: { total: 0, pending: 0, completed: 0 } })));
  assert.deepEqual(empty.todos.items, []);
  assert.deepEqual(empty.todos.counts, { total: 0, pending: 0, completed: 0 });
  const d = project(demo, 17);
  assert.deepEqual(d.todos.counts, { total: d.todos.items.length,
    pending: d.todos.items.filter(item => !item.completed).length, completed: d.todos.items.filter(item => item.completed).length });
});

test('live Activity copies only safe transcript fields, never fabricates event text, and clears with replacement/offline', () => {
  const event = { id: 'opaque-e', timestamp: 1000, role: 'toolResult', kind: 'tool', status: 'failed', toolName: 'read' };
  const block = { id: 'opaque-text', role: 'tool', text: 'Actual compact preview\n    code', rawResult: 'not a DTO field' };
  const s = snapshot(1, { events: [event], transcript: [block] });
  const projected = project(live(s));
  assert.deepEqual(projected.events, []);
  assert.deepEqual(projected.transcript, [{ id: block.id, role: block.role, text: block.text }]);
  assert.notEqual(projected.transcript[0], block);
  block.text = 'changed';
  assert.equal(projected.transcript[0].text, 'Actual compact preview\n    code');
  assert.deepEqual(project(live(snapshot(1, { events: [event] }))).transcript, []);
  assert.deepEqual(project({ ...live(s), connection: 'stale' }).transcript, []);
  assert.deepEqual(project(live({ ...s, branchId: 'new-branch', transcript: [] })).transcript, []);
});

// Source only: not executed for display/call decoupling.
test('webcam projection accepts fresh display scope during idle/standby, not stale/foreign/demo; captions stay call scoped', () => {
  const at = Date.now();
  const s = snapshot(1, { timestamp: at, displayScopeId: 'display',
    presentation: { version: 2, scopeId: 'display', id: 'revision', text: 'Standalone' } });
  assert.equal(project(live(s), 0, at).presentation?.id, 'revision');
  const standby = { ...s, talk: { phase: 'standby', mode: 'facetime', voiceReady: false, audioEnabled: false } };
  assert.equal(project(live(standby), 0, at).presentation?.id, 'revision');
  assert.deepEqual(project(live(standby), 0, at).captions, []);
  assert.equal(project(live(s), 0, at + 5000).presentation, undefined);
  assert.equal(project(live({ ...s, displayScopeId: 'foreign' }), 0, at).presentation, undefined);
  assert.equal(project(live({ ...s, displayScopeId: undefined }), 0, at).presentation, undefined);
  assert.equal(project({ ...live(s), connection: 'offline' }, 0, at).presentation, undefined);
  assert.equal(project({ ...demo, snapshot: s }, 0, at).presentation, undefined);
  assert.equal(project(live({ ...s, presentation: { ...s.presentation, version: 1, runId: 'run' } }), 0, at).presentation, undefined);
});

test('robot readiness follows phase AND voiceReady; stops, new calls, reconnects and generations reset eye opening', () => {
  const readiness = createTalkReadiness();
  const s = snapshot();
  const set = (phase, voiceReady, audioEnabled = false, mode = 'facetime') => {
    s.talk = { phase, voiceReady, audioEnabled, mode };
    return project(live(s)).talk;
  };
  for (const phase of ['idle', 'standby', 'preparing', 'summarizing', 'starting-native', 'creating-offer', 'connecting-voice', 'connecting-audio', 'stopping', 'error']) {
    assert.equal(readiness(set(phase, true, true), 0), null);
  }
  assert.equal(readiness(set('ready', false), 1), null);
  assert.equal(readiness(set('ready', true), 2), 2);
  assert.equal(readiness(set('connected', true, true), 4), 2);
  assert.equal(project(live(s)).talk.audioEnabled, true);
  assert.equal(readiness(set('stopping', true), 5), null);
  assert.equal(readiness(set('ready', true), 6), 6);
  assert.equal(readiness(project(OFFLINE_LIVE_HUD).talk, 7), null);
  assert.equal(readiness(set('ready', true), 8), 8);
  s.sessionId = 'new-session';
  assert.equal(readiness(project(live(s)).talk, 9), 9);
  s.streamId = 'new-stream';
  assert.equal(readiness(project(live(s)).talk, 10), 10);
  assert.equal(readiness(set('preparing', false), 11), null);
  assert.equal(readiness(set('ready', true), 12), 12);
  assert.equal(readiness(set('ready', true), 1), 1);
  assert.equal(readiness(set('ready', true, true, 'inactive'), 2), null);
});

test('renderer feed subscribes first; late initial result cannot overwrite event (including offline/demo), dispose fences promises', async () => {
  let callback, resolveInitial, removed = 0;
  const feed = createLiveHudFeed({
    onLiveHudState(cb) { callback = cb; return () => { removed++; }; },
    getLiveHudState() { assert.ok(callback); return new Promise(resolve => { resolveInitial = resolve; }); },
  });
  assert.deepEqual(feed.read(), OFFLINE_LIVE_HUD);
  const seen = [];
  const unsubscribe = feed.subscribe(s => seen.push(s));
  callback(live(snapshot(20)));
  callback(OFFLINE_LIVE_HUD);
  callback(demo);
  resolveInitial(live(snapshot(1)));
  await Promise.resolve();
  assert.equal(feed.read(), demo);
  assert.equal(feed.snapshot(20).source, 'mock');
  unsubscribe();
  feed.dispose();
  callback(live(snapshot(30)));
  assert.deepEqual(feed.read(), OFFLINE_LIVE_HUD);
  assert.equal(removed, 1);
  assert.equal(seen.length, 3);
});
test('missing/rejected getter stays offline, never demo; event after initial fetch updates normally', async () => {
  const missing = createLiveHudFeed();
  assert.equal(missing.snapshot(100).source, 'offline'); missing.dispose();
  const rejected = createLiveHudFeed({ onLiveHudState() { return () => {}; }, getLiveHudState: () => Promise.reject(new Error('private path')) });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(rejected.read(), OFFLINE_LIVE_HUD); rejected.dispose();
  let callback;
  const f = createLiveHudFeed({ onLiveHudState(cb) { callback = cb; return () => {}; }, getLiveHudState: async () => live(snapshot(1)) });
  await Promise.resolve();
  assert.equal(f.read().snapshot.sequence, 1);
  callback(live(snapshot(2)));
  assert.equal(f.read().snapshot.sequence, 2); f.dispose();
});
test('sub-frame reconnect/stop edges reset readiness even if the next rendered phase is already ready', async () => {
  let callback;
  const s = snapshot(1, { talk: { phase: 'ready', mode: 'facetime', voiceReady: true, audioEnabled: false } });
  const feed = createLiveHudFeed({ onLiveHudState(cb) { callback = cb; return () => {}; }, getLiveHudState: async () => live(s) });
  await Promise.resolve();
  const ready = createTalkReadiness();
  assert.equal(ready(feed.snapshot(1).talk, 1), 1);
  callback(OFFLINE_LIVE_HUD); callback(live(s));
  assert.equal(ready(feed.snapshot(2).talk, 2), 2);
  callback(live({ ...s, talk: { ...s.talk, phase: 'preparing' } })); callback(live(s));
  assert.equal(ready(feed.snapshot(3).talk, 3), 3);
  feed.dispose();
});
test('renderer consumers share one subscription/getter; last dispose cleans it up', async () => {
  let subscribed = 0, fetched = 0, removed = 0;
  globalThis.window = { webcam: {
    onLiveHudState() { subscribed++; return () => { removed++; }; },
    async getLiveHudState() { fetched++; return demo; },
  } };
  try {
    const a = acquireLiveHudFeed(), b = acquireLiveHudFeed();
    await Promise.resolve();
    assert.equal(subscribed, 1); assert.equal(fetched, 1);
    assert.equal(a.read(), b.read()); assert.equal(a.read(), demo);
    a.dispose(); a.dispose(); assert.equal(removed, 0);
    b.dispose(); assert.equal(removed, 1);
    const c = acquireLiveHudFeed(); c.dispose(); assert.equal(removed, 2);
  } finally { delete globalThis.window; }
});
test('disposing pending initial read prevents resurrection', async () => {
  let resolve;
  const f = createLiveHudFeed({ onLiveHudState: () => () => {}, getLiveHudState: () => new Promise(r => { resolve = r; }) });
  f.dispose(); resolve(demo); await Promise.resolve();
  assert.deepEqual(f.read(), OFFLINE_LIVE_HUD);
});
