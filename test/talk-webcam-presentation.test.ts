import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCallPresentationController, registerCallPresentationTool, registerWebcamPresentationTool, type PresentationAuthority } from '../extensions/talk/webcam-presentation.ts';
import { createPresentationAssetCache, inspectPresentationImage, presentationAssetPath, readPresentationAsset } from '../extensions/talk/webcam/src/shared/presentation-assets.ts';
import { parseCallPresentation, presentationText, type Presentation, type PreparedPresentation } from '../extensions/talk/webcam/src/shared/presentation-protocol.ts';
import { parseLiveHudSnapshot } from '../extensions/talk/webcam/src/shared/live-validation.ts';
import { LIVE_HUD_MAX_BYTES } from '../extensions/talk/webcam/src/shared/live-protocol.ts';
import { createPresentationFeed } from '../extensions/talk/webcam/src/shared/presentation-feed.ts';

// Source only: deliberately NOT executed as part of this preparation task.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function temporary() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'mypi-presentation-'));
  const webcam = join(directory, 'webcam'); mkdirSync(webcam, { mode: 0o700 }); chmodSync(webcam, 0o700);
  return { directory, socket: join(webcam, 'hud.sock'), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
function harness(socket: string) {
  let call: PresentationAuthority | undefined = { sessionKey: 'private-session', callKey: 'private-call', runId: 'voice-one', owned: true, verified: true, connected: true };
  let sharing = true, ready = true;
  let published: Presentation | null = null;
  const controller = createCallPresentationController({ currentCall: () => call, sharingActive: () => sharing,
    publisherReady: () => ready, socketPath: () => socket, publish: value => { published = value; } });
  return { controller, read: () => published,
    setCall(value: PresentationAuthority | undefined) { call = value; controller.sync(); },
    setSharing(value: boolean) { sharing = value; controller.sync(); },
    setReady(value: boolean) { ready = value; controller.sync(); },
  };
}
test('plain bounded text and metadata reject controls, auth, hidden reasoning and foreign runs', () => {
  assert.equal(presentationText('## Summary\n\n- First\n- Second'), '## Summary\n\n- First\n- Second');
  for (const text of ['x'.repeat(1201), 'Hello\x1b[2J', 'x\u202eprivate', '<think>private</think>', 'Bearer abcdef'])
    assert.throws(() => presentationText(text));
  assert.throws(() => presentationText('x\n'.repeat(17)));
  assert.equal(parseCallPresentation({ version: 1, scopeId: 'scope', runId: 'old', id: 'id', text: 'hello' }, 'new'), undefined);
  assert.equal(parseCallPresentation({ version: 1, scopeId: 'scope', runId: 'run', id: 'id', image: { assetId: '../private', mime: 'image/png', bytes: 100, width: 1, height: 1 } }, 'run'), undefined);
});
test('strict HUD contract carries metadata only and requires current connected FaceTime run', () => {
  const frame = () => ({ version: 1, streamId: 'stream', sessionId: 'session', branchId: 'branch', sequence: 1, timestamp: 1000,
    session: { provider: 'fixture', model: 'fixture', status: 'idle', startedAt: 1000, elapsedMs: 0 },
    context: { tokens: null, contextWindow: null, percent: null }, agents: [], todos: [], events: [], usage: { status: 'inactive' },
    talk: { phase: 'connected', mode: 'facetime', runId: 'run', voiceReady: true, audioEnabled: true },
    presentation: { version: 1, scopeId: 'scope', runId: 'run', id: 'revision', text: 'Public explanation',
      image: { assetId: 'a'.repeat(32), mime: 'image/png', bytes: 100, width: 1, height: 1 } },
  });
  const s = frame(), parsed = parseLiveHudSnapshot(s);
  assert.ok(parsed?.presentation);
  assert.notEqual(parsed.presentation, s.presentation);
  assert.ok(Buffer.byteLength(JSON.stringify(parsed)) <= LIVE_HUD_MAX_BYTES);
  for (const mutate of [
    (s: ReturnType<typeof frame>) => { s.talk.audioEnabled = false; },
    (s: ReturnType<typeof frame>) => { s.talk.voiceReady = false; },
    (s: ReturnType<typeof frame>) => { s.talk.phase = 'ready'; },
    (s: ReturnType<typeof frame>) => { s.talk.mode = 'virtual'; },
    (s: ReturnType<typeof frame>) => { s.presentation.runId = 'retired'; },
    (s: ReturnType<typeof frame>) => { Object.assign(s.presentation, { imagePath: '/private/source.png' }); },
    (s: ReturnType<typeof frame>) => { Object.assign(s.presentation.image, { dataUrl: 'data:image/png;base64,AA==' }); },
    (s: ReturnType<typeof frame>) => { s.presentation.image.assetId = '../private'; },
    (s: ReturnType<typeof frame>) => { s.presentation.text = 'x'.repeat(1201); },
  ]) { const invalid = frame(); mutate(invalid); assert.equal(parseLiveHudSnapshot(invalid), null); }
});

test('v2 HUD metadata requires matching display scope, not a call; v1 remains strict', () => {
  const frame = (): any => ({ version: 1, streamId: 'stream', sessionId: 'session', branchId: 'branch', sequence: 1, timestamp: 1000,
    session: { provider: 'fixture', model: 'fixture', status: 'idle', startedAt: 1000, elapsedMs: 0 },
    context: { tokens: null, contextWindow: null, percent: null }, agents: [], todos: [], events: [], usage: { status: 'inactive' },
    talk: { phase: 'idle', mode: 'inactive', voiceReady: false, audioEnabled: false }, displayScopeId: 'display',
    presentation: { version: 2, scopeId: 'display', id: 'revision', text: 'Public standalone explanation' },
  });
  assert.ok(parseLiveHudSnapshot(frame())?.presentation);
  const standby = frame(); standby.talk = { ...standby.talk, phase: 'standby', mode: 'facetime' };
  assert.ok(parseLiveHudSnapshot(standby)?.presentation);
  for (const mutate of [
    (s: any) => { delete s.displayScopeId; }, (s: any) => { delete s.branchId; },
    (s: any) => { s.displayScopeId = 'foreign'; }, (s: any) => { s.presentation.runId = 'must-not-be-used'; },
    (s: any) => { s.presentation.imagePath = '/private/source.png'; },
    (s: any) => { s.presentation.image = { assetId: '../private', mime: 'image/png', bytes: 100, width: 1, height: 1 }; },
    (s: any) => { s.presentation.text = 'x'.repeat(1201); },
    (s: any) => { s.presentation = { ...s.presentation, version: 1, runId: 'run' }; },
  ]) { const s = frame(); mutate(s); assert.equal(parseLiveHudSnapshot(s), null); }
});

test('real bytes, private opaque asset path, bounded ownership and source preservation', () => {
  const t = temporary();
  try {
    const source = join(t.directory, 'slide.png'); writeFileSync(source, png);
    const cache = createPresentationAssetCache(t.socket), image = cache.put(source);
    assert.equal(inspectPresentationImage(png).width, 1);
    assert.equal(lstatSync(join(t.directory, 'webcam', 'presentations')).mode & 0o777, 0o700);
    const path = presentationAssetPath(t.socket, image);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readPresentationAsset(t.socket, image), png);
    assert.doesNotMatch(JSON.stringify(image), /slide|socket|path|base64/);
    const other = cache.put(source); assert.throws(() => cache.put(source), /full/);
    cache.remove(image.assetId); cache.remove(other.assetId); cache.clear();
    assert.deepEqual(readFileSync(source), png);
    assert.deepEqual(readdirSync(join(t.directory, 'webcam', 'presentations')), []);
  } finally { t.dispose(); }
});
test('nonimage, credentials, symlink sources and replaced owned filenames fail closed', () => {
  const t = temporary();
  try {
    const cache = createPresentationAssetCache(t.socket), source = join(t.directory, 'slide.png');
    writeFileSync(source, Buffer.alloc(40, 65)); assert.throws(() => cache.put(source), /PNG|JPEG/);
    writeFileSync(source, png);
    const alias = join(t.directory, 'alias.png'); symlinkSync(source, alias); assert.throws(() => cache.put(alias));
    assert.throws(() => cache.put(join(t.directory, 'credentials.png')), /Credential/);
    const image = cache.put(source), ownedPath = presentationAssetPath(t.socket, image);
    rmSync(ownedPath); symlinkSync(source, ownedPath); cache.clear();
    assert.ok(lstatSync(ownedPath).isSymbolicLink()); assert.deepEqual(readFileSync(source), png);
    assert.throws(() => readPresentationAsset(t.socket, image));
    assert.throws(() => inspectPresentationImage(Buffer.from('not an image at all'.repeat(4))));
    const badCrc = Buffer.from(png); badCrc[20] ^= 1; assert.throws(() => inspectPresentationImage(badCrc));
  } finally { t.dispose(); }
});
test('presentations require current session/owned verified call + opted-in ready publisher', () => {
  const t = temporary(), h = harness(t.socket);
  try {
    assert.throws(() => h.controller.execute({ action: 'show', text: 'hello' }, 'another-session'), /different Pi session/);
    h.controller.execute({ action: 'show', text: 'hello' }, 'private-session');
    assert.equal(h.read()?.text, 'hello');
    assert.doesNotMatch(JSON.stringify(h.read()), /private-session|private-call/);
    h.setSharing(false); assert.equal(h.read(), null); assert.throws(() => h.controller.execute({ action: 'show', text: 'no' }));
    h.setSharing(true); assert.equal(h.controller.read(), null);
    h.controller.execute({ action: 'show', text: 'next' }); h.setReady(false); assert.equal(h.read(), null);
    h.setReady(true); h.setCall({ sessionKey: 'private-session', callKey: 'private-call', runId: 'voice-one', owned: true, verified: false, connected: true });
    assert.throws(() => h.controller.execute({ action: 'show', text: 'no' }));
    h.controller.dispose(); h.controller.dispose();
  } finally { t.dispose(); }
});
test('replacement, clear and call end remove only controller-owned cache assets', () => {
  const t = temporary(), h = harness(t.socket);
  try {
    const source = join(t.directory, 'slide.png'); writeFileSync(source, png);
    h.controller.execute({ action: 'show', imagePath: source });
    const before = h.read()!, path = presentationAssetPath(t.socket, before.image!);
    assert.ok(existsSync(path));
    assert.throws(() => h.controller.execute({ action: 'show', imagePath: source, text: source }), /original image path/);
    h.controller.execute({ action: 'show', text: 'text only' }); assert.equal(existsSync(path), false);
    h.controller.execute({ action: 'clear' }); assert.equal(h.read(), null);
    h.controller.execute({ action: 'show', imagePath: source });
    const nextPath = presentationAssetPath(t.socket, h.read()!.image!);
    h.setCall(undefined); assert.equal(h.read(), null); assert.equal(existsSync(nextPath), false);
    assert.deepEqual(readFileSync(source), png);
  } finally { h.controller.dispose(); t.dispose(); }
});
test('inactive sync does not flood publisher; an active clear publishes exactly once', () => {
  let sharing = false;
  const publications: (Presentation | null)[] = [];
  const controller = createCallPresentationController({
    currentCall: () => ({ sessionKey: 'session', callKey: 'call', runId: 'run', owned: true, verified: true, connected: true }),
    sharingActive: () => sharing, publisherReady: () => true, socketPath: () => '/canonical/webcam/hud.sock',
    publish: value => publications.push(value),
  });
  for (let n = 0; n < 100; n++) controller.sync();
  assert.equal(publications.length, 0);
  sharing = true;
  controller.execute({ action: 'show', text: 'Public explanation' }, 'session');
  sharing = false;
  for (let n = 0; n < 100; n++) controller.sync();
  assert.equal(publications.length, 2);
  assert.equal(publications.at(-1), null);
  controller.dispose();
});

test('webcam scope survives call loss/idle; strict legacy tool remains gated on the shared controller', () => {
  const t = temporary();
  let call: PresentationAuthority | undefined;
  let scopeId = 'publisher-generation', ready = true, sharing = true;
  let published: Presentation | null = null;
  const controller = createCallPresentationController({ currentCall: () => call,
    currentPublisher: () => ready ? { sessionKey: 'private-session', scopeId } : undefined,
    sharingActive: () => sharing, publisherReady: () => ready, socketPath: () => t.socket,
    publish: value => { published = value; } });
  try {
    assert.throws(() => controller.execute({ action: 'show', text: 'strict' }, 'private-session'), /verified connected call/);
    assert.throws(() => controller.executeWebcam({ action: 'show', text: 'foreign' }, 'foreign'), /different Pi session/);
    controller.executeWebcam({ action: 'show', text: 'standalone' }, 'private-session');
    const shown = controller.read()!;
    assert.equal(shown.version, 2);
    assert.ok(!('runId' in shown));
    assert.doesNotMatch(JSON.stringify(shown), /private-session/);
    controller.clearCall();
    for (let n = 0; n < 100; n++) controller.sync();
    assert.deepEqual(controller.read(), shown, 'call stop/standby/idle does not revoke webcam authority');
    call = { sessionKey: 'private-session', callKey: 'private-call', runId: 'run', owned: true, verified: true, connected: true };
    controller.execute({ action: 'show', text: 'strict replacement' }, 'private-session');
    assert.equal(controller.read()?.version, 1);
    call = undefined; controller.sync(); assert.equal(controller.read(), null);
    controller.executeWebcam({ action: 'show', text: 'new standalone' }, 'private-session');
    scopeId = 'next-generation'; controller.sync(); assert.equal(published, null);
    controller.executeWebcam({ action: 'show', text: 'next' }, 'private-session');
    ready = false; controller.sync(); assert.equal(controller.read(), null);
    assert.throws(() => controller.executeWebcam({ action: 'show', text: 'no' }, 'private-session'), /publisher unavailable/);
    sharing = false;
    assert.throws(() => controller.executeWebcam({ action: 'show', text: 'no' }, 'private-session'), /Webcam sharing is off/);
  } finally { controller.dispose(); t.dispose(); }
});

test('webcam image survives call-only clear, but publisher generation loss removes owned bytes', () => {
  const t = temporary(); let scopeId = 'first';
  const controller = createCallPresentationController({ currentCall: () => undefined,
    currentPublisher: () => ({ sessionKey: 'session', scopeId }), sharingActive: () => true, publisherReady: () => true,
    socketPath: () => t.socket, publish() {} });
  try {
    const source = join(t.directory, 'slide.png'); writeFileSync(source, png);
    controller.executeWebcam({ action: 'show', imagePath: source }, 'session');
    const path = presentationAssetPath(t.socket, controller.read()!.image!);
    controller.clearCall(); assert.ok(existsSync(path));
    scopeId = 'second'; controller.sync(); assert.equal(existsSync(path), false);
    assert.deepEqual(readFileSync(source), png);
  } finally { controller.dispose(); t.dispose(); }
});

test('webcam tool fails closed on legacy bridges; both registrations hide paths and use invocation session', async () => {
  const t = temporary(), h = harness(t.socket), tools: any[] = [];
  try {
    registerCallPresentationTool({ registerTool: (tool: unknown) => { tools.push(tool); } } as any, h.controller);
    registerWebcamPresentationTool({ registerTool: (tool: unknown) => { tools.push(tool); } } as any, h.controller);
    assert.deepEqual(tools.map(tool => tool.name), ['present_to_call', 'present_to_webcam']);
    const ctx = { sessionManager: { getSessionId: () => 'private-session' } };
    await assert.rejects(() => tools[1].execute('id', { action: 'show', text: 'no' }, undefined, undefined, ctx), /publisher unavailable/);
    assert.match(tools[0].description, /verified connected call/);
    assert.match(tools[1].description, /No Talk voice or FaceTime call is required/);
  } finally { h.controller.dispose(); t.dispose(); }
});

test('initial renderer getter cannot resurrect content after a clear event', async () => {
  let listener: (value: PreparedPresentation | null) => void = () => {};
  let resolveInitial!: (value: PreparedPresentation | null) => void;
  const feed = createPresentationFeed({ onCallPresentation(callback) { listener = callback; return () => {}; },
    getCallPresentation: () => new Promise(resolve => { resolveInitial = resolve; }) });
  listener(null);
  resolveInitial({ presentation: { version: 1, scopeId: 'scope', runId: 'old-run', id: 'old-id', text: 'stale' } });
  await Promise.resolve();
  assert.equal(feed.read(), null); feed.dispose();
});
