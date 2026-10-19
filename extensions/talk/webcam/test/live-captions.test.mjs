import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot, live, demo } from './live-test-support.mjs';
const { parseLiveHudSnapshot: parse } = await import('../src/shared/live-validation.ts');
const { projectLiveHud } = await import('../src/shared/live-projection.ts');
const { createLiveHudFeed } = await import('../src/shared/live-feed.ts');

function speaking(at = Date.now()) {
  return snapshot(1, { timestamp: at,
    talk: { phase: 'connected', mode: 'facetime', runId: 'run-a', voiceReady: true, audioEnabled: true },
    captions: { runId: 'run-a', lines: [
      { id: 'cc-1', speaker: 'user', text: 'Hello 🙂', final: true, updatedAt: at, expiresAt: at + 4000 },
      { id: 'cc-2', speaker: 'assistant', text: 'Hi there', final: false, updatedAt: at, expiresAt: at + 8000 },
    ] },
  });
}

test('caption wire is exact, detached, bounded, speaker/run scoped and connected-call-only', () => {
  const s = speaking();
  const p = parse(s);
  assert.deepEqual(p, s);
  assert.notEqual(p.captions.lines[0], s.captions.lines[0]);
  assert.equal(parse(snapshot()).captions, undefined);
  for (const mutation of [
    s => s.captions.extra = 'private', s => s.captions.runId = 'other-run',
    s => s.captions.lines[0].caller = 'private', s => s.captions.lines[0].turnId = 'provider-id',
    s => s.captions.lines[0].speaker = 'tool', s => s.captions.lines[0].text = ' ',
    s => s.captions.lines[0].text = '🙂'.repeat(257), s => s.captions.lines[0].text = 'bad\x1b[31m',
    s => s.captions.lines[0].text = 'bad\ud800', s => s.captions.lines[0].text = 'bad\u202e',
    s => s.captions.lines[0].id = '/private/path', s => s.captions.lines[0].final = 'true',
    s => s.captions.lines[0].updatedAt += 1, s => s.captions.lines[0].expiresAt += 1,
    s => s.captions.lines[1].expiresAt += 1,
    s => s.captions.lines[0].expiresAt = s.captions.lines[0].updatedAt,
    s => s.captions.lines[1].speaker = 'user', s => s.captions.lines[1].id = 'cc-1',
    s => s.captions.lines.push({ ...s.captions.lines[0], id: 'third' }),
    s => s.talk.audioEnabled = false, s => s.talk.voiceReady = false,
    s => s.talk.phase = 'ready', s => s.talk.phase = 'standby', s => s.talk.mode = 'physical',
    s => s.talk.mode = 'virtual', s => delete s.talk.runId,
  ]) {
    const invalid = speaking(); mutation(invalid); assert.equal(parse(invalid), null);
  }
});

test('live projection expires each speaker independently; stale, disconnected, wrong-run and demo never show speech', () => {
  const at = Date.now(), s = speaking(at);
  assert.equal(projectLiveHud(live(s), 0, at).captions.length, 2);
  assert.deepEqual(projectLiveHud(live(s), 0, at + 4000).captions.map(line => line.speaker), ['assistant']);
  assert.deepEqual(projectLiveHud(live(s), 0, at + 5000).captions, [], 'locally stale even without main notification');
  assert.deepEqual(projectLiveHud(live({ ...s, timestamp: at + 7000 }), 0, at + 8000).captions, []);
  for (const connection of ['stale', 'offline', 'connecting', 'error']) {
    assert.deepEqual(projectLiveHud({ ...live(s), connection }, 0, at).captions, []);
  }
  assert.deepEqual(projectLiveHud(live({ ...s, captions: { ...s.captions, runId: 'old' } }), 0, at).captions, []);
  assert.deepEqual(projectLiveHud(live({ ...s, talk: { ...s.talk, audioEnabled: false } }), 0, at).captions, []);
  assert.deepEqual(projectLiveHud({ ...demo, snapshot: s }, 0, at).captions ?? [], []);
  assert.deepEqual(projectLiveHud(live(snapshot()), 0, at).captions, []);
});

test('subscription-before-getter race never resurrects caption text after a clear/disconnect', async () => {
  let callback, resolveInitial;
  const feed = createLiveHudFeed({
    onLiveHudState(cb) { callback = cb; return () => {}; },
    getLiveHudState: () => new Promise(resolve => { resolveInitial = resolve; }),
  });
  callback(live(speaking()));
  callback({ mode: 'live', connection: 'offline', snapshot: null });
  resolveInitial(live(speaking()));
  await Promise.resolve();
  assert.deepEqual(feed.snapshot(0).captions, []);
  callback(live(speaking()));
  assert.equal(feed.snapshot(0).captions.length, 2);
  callback(live({ ...speaking(), captions: { runId: 'run-a', lines: [] } }));
  assert.deepEqual(feed.snapshot(0).captions, []);
  feed.dispose();
});
