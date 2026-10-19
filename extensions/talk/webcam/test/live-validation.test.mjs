import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot } from './live-test-support.mjs';
const { parseLiveHudSnapshot: parse } = await import('../src/shared/live-validation.ts');
const { LIVE_HUD_MAX_BYTES, LIVE_HUD_MAX_TRANSCRIPT_BLOCKS, LIVE_HUD_MAX_TRANSCRIPT_TEXT,
  LIVE_HUD_MAX_TRANSCRIPT_BYTES } = await import('../src/shared/live-protocol.ts');

const rich = () => snapshot(7, {
  context: { tokens: 120, contextWindow: 1000, percent: 12, tokensPerSecond: 33.4 },
  agents: [{ id: 1, label: 'hé🙂', task: 'Review', status: 'running', model: 'test', startedAt: 10, endedAt: 20,
    contextTokens: null, contextWindow: 1000, tokensPerSecond: 12 }],
  todos: [{ id: 1, text: 'Test', completed: false, completedAt: 100 }],
  usage: { status: 'ready', weekly: { remainingPercent: null, usedPercent: 12.5, resetAt: 200 }, updatedAt: 10 },
  talk: { phase: 'connected', mode: 'facetime', runId: 'voice-attempt', voiceReady: true, audioEnabled: true, elapsedMs: 10.5 },
});
test('accepts full bounded contract, preserves nulls, returns detached data-only copies', () => {
  const input = rich(), output = parse(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.agents[0], input.agents[0]);
  input.agents[0].task = 'changed';
  assert.equal(output.agents[0].task, 'Review');
  const minimal = snapshot();
  assert.deepEqual(parse(minimal), minimal);
});

for (const [name, mutate] of [
  ['version', s => s.version = 2], ['unknown root', s => s.command = 'answer'],
  ['unknown nested', s => s.talk.detail = 'private message'], ['raw events', s => s.events = [{ content: 'private' }]],
  ['missing', s => delete s.session.model], ['negative', s => s.sequence = -1],
  ['unsafe', s => s.sequence = Number.MAX_SAFE_INTEGER + 1], ['fractional', s => s.sequence = 1.1],
  ['NaN', s => s.context.percent = NaN], ['infinity', s => s.timestamp = Infinity],
  ['percent', s => s.context.percent = 100.1], ['enum', s => s.talk.phase = 'answer'],
  ['boolean', s => s.talk.voiceReady = 'true'], ['empty ID', s => s.streamId = ''],
  ['run ID bound', s => s.talk.runId = 'x'.repeat(129)], ['empty run ID', s => s.talk.runId = ''],
  ['string bound', s => s.todos[0].text = 'x'.repeat(1025)], ['control', s => s.agents[0].label = 'bad\nlabel'],
  ['bidi', s => s.session.model = '\u202eevil'], ['array bound', s => s.agents = Array(65).fill(s.agents[0])],
  ['sparse array', s => s.agents = Array(1)],
  ['todo bound', s => s.todos = Array(257).fill(s.todos[0])], ['duplicate IDs', s => s.todos.push({ ...s.todos[0] })],
  ['prototype', s => Object.setPrototypeOf(s.session, { cwd: '/private' })],
  ['accessor', s => Object.defineProperty(s.talk, 'phase', { get() { throw new Error('never execute'); }, enumerable: true })],
  ['symbol', s => s[Symbol('private')] = true], ['toJSON', s => s.toJSON = () => snapshot()],
]) test(`rejects ${name}`, () => { const s = rich(); mutate(s); assert.equal(parse(s), null); });

test('optional todo counts are detached, bounded full-state metadata with consistent row/category math', () => {
  const s = rich();
  s.todos.push({ id: 2, text: 'Done', completed: true });
  s.todoCounts = { total: 1000, pending: 600, completed: 400 };
  const parsed = parse(s);
  assert.deepEqual(parsed.todoCounts, s.todoCounts);
  assert.notEqual(parsed.todoCounts, s.todoCounts);
  assert.equal(parse(rich()).todoCounts, undefined, 'legacy totals remain unknown');
  assert.ok(parse({ ...s, todoCounts: { total: 2, pending: 1, completed: 1 } }));
  assert.ok(parse({ ...s, todos: [], todoCounts: { total: 0, pending: 0, completed: 0 } }));
  assert.ok(parse({ ...s, todos: [], todoCounts: { total: Number.MAX_SAFE_INTEGER, pending: Number.MAX_SAFE_INTEGER, completed: 0 } }));
  for (const counts of [null, [], {}, { total: 2, pending: 1 },
    { total: 3, pending: 1, completed: 1 }, { total: 1, pending: 1, completed: 0 },
    { total: 10, pending: 0, completed: 10 }, { total: 10, pending: 10, completed: 0 },
    { total: 2, pending: 1, completed: 1, secret: 'not allowed' },
    { total: 2, pending: 1, get completed() { throw new Error('Never invoke accessors'); } }]) {
    assert.equal(parse({ ...s, todoCounts: counts }), null);
  }
  for (const key of ['total', 'pending', 'completed']) {
    for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) {
      assert.equal(parse({ ...s, todoCounts: { ...s.todoCounts, [key]: value } }), null);
    }
  }
});

test('legacy activity events remain metadata only with branch scope and bounded combinations', () => {
  const event = { id: 'opaque-event', timestamp: 1000, role: 'toolResult', kind: 'tool', status: 'completed', toolName: 'functions.read' };
  const valid = snapshot(1, { events: [event] });
  assert.deepEqual(parse(valid).events, [event]);
  assert.notEqual(parse(valid).events[0], event);
  for (const change of [
    { id: '/private/path' }, { id: 'x'.repeat(65) }, { timestamp: 1.2 }, { timestamp: -1 }, { timestamp: NaN },
    { timestamp: valid.timestamp + 1 }, { toolName: '/private/read' }, { toolName: 'x'.repeat(49) },
    { summary: 'private conversation' }, { result: 'private output' }, { args: {} },
    { role: 'user' }, { kind: 'run' }, { status: 'settled' },
  ]) assert.equal(parse({ ...valid, events: [{ ...event, ...change }] }), null);
  assert.equal(parse({ ...valid, branchId: undefined }), null);
  assert.equal(parse({ ...valid, events: [event, event] }), null);
  assert.equal(parse({ ...valid, events: [{ ...event, id: 'first', timestamp: 1001 }, event] }), null);
  assert.equal(parse({ ...valid, events: Array.from({ length: 11 }, (_, i) => ({ ...event, id: `e-${i}` })) }), null);
  const legacy = snapshot(); delete legacy.events; delete legacy.branchId;
  assert.deepEqual(parse(legacy).events, []);
  assert.equal(parse(legacy).branchId, 'legacy');
});

test('transcript is an optional exact detached UTF-8-bounded public display DTO', () => {
  const block = { id: 'opaque_block-1', role: 'assistant', text: 'Paragraph\n\n    code\n\ttab 🙂' };
  const s = snapshot(1, { transcript: [block] });
  const parsed = parse(s);
  assert.deepEqual(parsed.transcript, [block]);
  assert.notEqual(parsed.transcript[0], block);
  assert.equal(parse(snapshot()).transcript, undefined);
  assert.deepEqual(parse({ ...s, transcript: [] }).transcript, []);
  for (const role of ['user', 'assistant', 'tool', 'custom']) assert.ok(parse({ ...s, transcript: [{ ...block, role }] }));
  assert.ok(parse({ ...s, transcript: [{ ...block, id: 'x'.repeat(128), text: '🙂'.repeat(512) }] }));
  assert.equal(Buffer.byteLength('🙂'.repeat(512)), LIVE_HUD_MAX_TRANSCRIPT_TEXT);
  assert.ok(parse({ ...s, transcript: Array.from({ length: LIVE_HUD_MAX_TRANSCRIPT_BLOCKS }, (_, i) =>
    ({ ...block, id: `b_${i}`, text: 'x'.repeat(LIVE_HUD_MAX_TRANSCRIPT_TEXT) })) }));
  assert.ok(LIVE_HUD_MAX_TRANSCRIPT_BLOCKS * LIVE_HUD_MAX_TRANSCRIPT_TEXT <= LIVE_HUD_MAX_TRANSCRIPT_BYTES);
  for (const change of [{ id: '' }, { id: '/private/path' }, { id: 'x'.repeat(129) }, { role: 'toolResult' },
    { text: '' }, { text: ' \n\t' }, { text: '🙂'.repeat(513) }, { text: 'x'.repeat(2049) },
    { timestamp: 1000 }, { summary: 'not allowed' }, { result: {} }, { args: {} }]) {
    assert.equal(parse({ ...s, transcript: [{ ...block, ...change }] }), null);
  }
  for (const control of ['\r', '\0', '\x1b[31m', '\x1b]0;title\x07', '\u0085', '\u061c', '\u200e', '\u200f',
    '\u2028', '\u2029', '\u202e', '\u2066', '\u00ad', '\u200b', '\u200d', '\u2060', '\u206a', '\ufeff', '\u{E0001}']) {
    assert.equal(parse({ ...s, transcript: [{ ...block, text: `bad${control}text` }] }), null);
  }
  assert.equal(parse({ ...s, transcript: [block, block] }), null);
  assert.equal(parse({ ...s, transcript: Array(11).fill(block) }), null);
  assert.equal(parse({ ...s, transcript: Array(1) }), null);
  assert.equal(parse({ ...s, transcript: [{ id: 'a', role: 'user', get text() { throw Error('must not run'); } }] }), null);
  const legacy = { ...s }; delete legacy.branchId;
  assert.equal(parse(legacy), null);
});

test('transcript accepts astral code points but rejects JSON-escaped unpaired UTF-16 surrogates', () => {
  const withText = text => snapshot(1, { transcript: [{ id: 'unicode', role: 'assistant', text }] });
  const astral = 'Astral \uD83D\uDE42 \uD834\uDD1E \uD840\uDC00\n\ttext';
  assert.equal(parse(JSON.parse(JSON.stringify(withText(astral)))).transcript[0].text, astral);
  for (const text of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF', 'high\uD800text', 'low\uDC00text', '\uD800\uD800', '\uDC00\uD800']) {
    assert.equal(parse(JSON.parse(JSON.stringify(withText(text)))), null, `accepted ${JSON.stringify(text)}`);
  }
});

test('rejects non-objects and aggregate byte overflow even with individually bounded strings', () => {
  for (const value of [null, undefined, [], 'snapshot', 1]) assert.equal(parse(value), null);
  const s = snapshot();
  s.todos = Array.from({ length: 200 }, (_, id) => ({ id, text: '🙂'.repeat(500), completed: false }));
  assert.ok(Buffer.byteLength(JSON.stringify(s)) > LIVE_HUD_MAX_BYTES);
  assert.equal(parse(s), null);
});
