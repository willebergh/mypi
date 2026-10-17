import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, realpath, rm, stat, lstat, mkdir, symlink, writeFile, chmod, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTalkTrace } from "../extensions/talk/trace.ts";

async function fixture(t: TestContext) {
  // Resolve OS aliases (/var on macOS) before testing the no-symlink policy.
  const dir = await mkdtemp(join(await realpath(tmpdir()), "talk-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "private", "live.jsonl") };
}
async function rows(path: string) {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("constructor and disabled sinks are I/O-free; dynamic sessions flush and append privately", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  const sink = trace.session("call-1");
  assert.deepEqual(trace.status(), { path, enabled: false, dropped: 0 });
  sink.record("in", { type: "off" });
  await trace.disable();
  await assert.rejects(lstat(path), { code: "ENOENT" });
  const opening = trace.enable();
  assert.equal(trace.status().enabled, false);
  await opening;
  sink.record("out", { type: "session.update", instructions: "Be helpful" });
  sink.record("in", { type: "response.done", summary: "Keep this" });
  await trace.disable();
  sink.record("local", { type: "off" });
  await trace.enable();
  sink.record("local", { type: "again" });
  await trace.disable();
  const records = await rows(path);
  assert.deepEqual(records.map(r => r.type), ["session.update", "response.done", "again"]);
  assert.deepEqual(records.map(r => r.seq), [1, 2, 3]);
  assert.deepEqual(records.map(r => r.direction), ["out", "in", "local"]);
  assert.ok(records.every(r => r.callId === "call-1" && new Date(r.time).toISOString() === r.time));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
});

test("new-call reset drains old writes, removes the rotation backup, and retires old sinks", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path, maxBytes: 1500 });
  const old = trace.session("old-call");
  await trace.enable();
  for (let i = 0; i < 30; i++) old.record("in", { type: "old", i, text: "x".repeat(180) });
  await trace.disable();
  assert.ok((await stat(path + ".1")).size > 0);
  await trace.enable();
  old.record("in", { type: "old-queued" });
  const resetting = trace.reset();
  const fresh = trace.session("new-call");
  old.record("in", { type: "old-during-reset" });
  await resetting;
  assert.equal(trace.status().enabled, true);
  assert.equal((await stat(path)).size, 0);
  await assert.rejects(lstat(path + ".1"), { code: "ENOENT" });
  old.record("in", { type: "late-old" });
  fresh.record("out", { type: "new-start" });
  await trace.disable();
  const records = await rows(path);
  assert.deepEqual(records.map(r => [r.callId, r.type, r.seq]), [["new-call", "new-start", 1]]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("disabled reset immediately clears existing files without creating files or enabling logging", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  await trace.reset();
  await assert.rejects(lstat(join(path, "..")), { code: "ENOENT" });
  assert.equal(trace.status().enabled, false);

  await mkdir(join(path, ".."));
  await writeFile(path, '{"previous":true}\n');
  await writeFile(path + ".1", '{"backup":true}\n');
  await trace.reset();
  assert.equal((await stat(path)).size, 0, "an existing active log is cleared immediately");
  await assert.rejects(lstat(path + ".1"), { code: "ENOENT" });
  assert.equal(trace.status().enabled, false, "reset does not opt into recording");
  const sink = trace.session("current");
  sink.record("local", { type: "off" });
  assert.equal((await stat(path)).size, 0, "disabled sinks remain inactive after reset");

  await writeFile(path + ".1", '{"backup-only":true}\n');
  await unlink(path);
  await trace.reset();
  await assert.rejects(lstat(path), { code: "ENOENT" }, "backup-only reset does not create an active file");
  await assert.rejects(lstat(path + ".1"), { code: "ENOENT" }, "backup-only reset removes the existing backup");
  assert.equal(trace.status().enabled, false);

  const current = trace.session("current");
  await trace.enable();
  current.record("local", { type: "current-only" });
  await trace.disable();
  assert.deepEqual((await rows(path)).map(r => r.type), ["current-only"]);
});

test("reset restarts sequence and drop counters without leaking old drop markers", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path, maxQueuedBytes: 1024, maxBytes: 100000 });
  await trace.enable();
  const old = trace.session("old");
  for (let i = 0; i < 1000; i++) old.record("in", { type: "old", text: "x".repeat(200) });
  assert.ok(trace.status().dropped > 0);
  await trace.reset();
  assert.equal(trace.status().dropped, 0);
  trace.session("new").record("local", { type: "new" });
  await trace.disable();
  assert.deepEqual((await rows(path)).map(r => [r.type, r.seq]), [["new", 1]]);
});

test("reset serializes with enable/disable requests without changing opt-in intent", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  const old = trace.session("old");
  await Promise.all([trace.enable(), trace.reset(), trace.disable(), trace.enable(), trace.reset()]);
  assert.equal(trace.status().enabled, true);
  old.record("in", { type: "stale" });
  trace.session("new").record("local", { type: "new" });
  await trace.disable();
  assert.deepEqual((await rows(path)).map(r => [r.callId, r.type, r.seq]), [["new", "new", 1]]);
  await Promise.all([trace.reset(), trace.enable(), trace.disable()]);
  assert.equal(trace.status().enabled, false);
});

test("reset refuses replaced active paths or unsafe backups without truncating victims", async t => {
  for (const replacement of ["active", "backup"]) {
    const { path, dir } = await fixture(t);
    const victim = join(dir, "victim");
    await writeFile(victim, "untouched");
    let errors = 0;
    const trace = createTalkTrace({ path, onError() { errors++; } });
    await trace.enable();
    trace.session("old").record("local", { type: "old" });
    await trace.disable();
    await trace.enable();
    if (replacement === "active") {
      await rename(path, join(dir, "saved"));
      await symlink(victim, path);
    } else await symlink(victim, path + ".1");
    await trace.reset();
    assert.equal(trace.status().enabled, false);
    assert.equal(errors, 1);
    assert.equal(await readFile(victim, "utf8"), "untouched");
    await trace.disable();
  }
});

test("preserves actual protocol text while redacting secrets, headers, audio and SDP", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  const sink = trace.session("call");
  sink.addSecrets(["Bearer actual-auth-value", "actual-account-value"]);
  const event = {
    type: "conversation.item.create",
    instructions: "Follow the instructions", summary: "summary text", delegation: "delegate text",
    content: [{ type: "input_text", text: "actual instruction", data: "not audio" },
      { type: "input_audio", data: "BASE64-RAW-AUDIO", transcript: "spoken words" }],
    context: "actual-auth-value and actual-account-value",
    headers: { Authorization: "other-auth", "chatgpt-account-id": "other-account", Cookie: "session=private" },
    auth: "auth-field-value", token: "token-value", apiKey: "key-value", password: "password-value",
    audio: "RAWPCM", sdp: "PRIVATE-SDP", candidate: "PRIVATE-ICE",
    text: 'message {"authorization":"json-auth","accountId":"json-account","token":"json-token"} end',
    patterns: "Bearer pattern-auth sk-proj-1234567890 eyJhbGciOiJub25l.eyJzdWIiOiJ4In0.signature123 ?access_token=query-secret&ok=1",
  };
  const original = structuredClone(event);
  await trace.enable();
  sink.record("out", event);
  sink.record("in", { type: "response.output_audio.delta", delta: "RAW-DELTA", transcript: "words" });
  sink.record("in", { type: "audio", data: "RAW-TYPED-AUDIO" });
  sink.record("local", { text: 'escaped {\\"authorization\\":\\"escaped-secret\\"}' });
  await trace.disable();
  assert.deepEqual(event, original);
  const output = await readFile(path, "utf8");
  for (const secret of ["actual-auth-value", "actual-account-value", "other-auth", "other-account", "session=private",
    "auth-field-value", "token-value", "key-value", "password-value", "RAWPCM", "PRIVATE-SDP", "PRIVATE-ICE", "BASE64-RAW-AUDIO",
    "json-auth", "json-account", "json-token", "pattern-auth", "sk-proj", "eyJhbGci", "query-secret", "RAW-DELTA", "RAW-TYPED-AUDIO", "escaped-secret"]) {
    assert.ok(!output.includes(secret), `leaked ${secret}`);
  }
  const first = (await rows(path))[0].event;
  assert.equal(first.instructions, event.instructions);
  assert.equal(first.summary, event.summary);
  assert.equal(first.delegation, event.delegation);
  assert.equal(first.content[0].text, "actual instruction");
  assert.equal(first.content[0].data, "not audio");
  assert.equal(first.content[1].transcript, "spoken words");
});

test("redaction precedes truncation, with bounded records and hostile inputs", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  const sink = trace.session("call");
  sink.addSecrets(["boundary-secret-never-leak"]);
  let called = 0;
  const hostile: Record<string, unknown> = { type: "hostile", toJSON() { called++; throw Error("no"); } };
  Object.defineProperty(hostile, "getter", { enumerable: true, get() { called++; throw Error("no"); } });
  hostile.self = hostile;
  hostile.buffer = Buffer.from("PRIVATE-BINARY");
  hostile.typed = new Uint16Array([42]);
  hostile.proxy = new Proxy({}, { ownKeys() { throw Error("private-error"); } });
  const sparse: unknown[] = [];
  sparse[4294967294] = "sparse";
  hostile.sparse = sparse;
  let deep: object = {};
  for (let i = 0; i < 100; i++) deep = { deep };
  await trace.enable();
  sink.record("in", hostile);
  sink.record("in", { text: "a".repeat(16380) + "boundary-secret-never-leak", deep });
  sink.record("in", { text: "a".repeat(16380) + "Bearer bearer-boundary-secret", deep });
  sink.record("in", Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ["key" + i, "x".repeat(100)])));
  sink.record("in", { text: "😀".repeat(30000) });
  await trace.disable();
  const output = await readFile(path, "utf8");
  assert.equal(called, 0);
  assert.doesNotMatch(output, /boundary-sec|bearer-bound|PRIVATE-BINARY|private-error/);
  assert.match(output, /truncated/);
  assert.match(output, /circular/);
  assert.match(output, /uninspectable/);
  for (const line of output.trim().split("\n")) {
    JSON.parse(line);
    assert.ok(Buffer.byteLength(line + "\n") <= 64 * 1024);
  }
});

test("embedded JSON uses the same secret/payload keys without hiding useful protocol text", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  const sink = trace.session("synthetic-call");
  const sensitive = {
    auth: "synthetic-auth-value",
    credentials: { username: "synthetic-credential-user", password: "synthetic-credential-password" },
    secrets: ["synthetic-secret-one", "synthetic-secret-two"],
    apiKeys: ["synthetic-key-one"],
    access_tokens: ["synthetic-access-token"],
    audio: "synthetic-audio-bytes",
    pcm: [117, 118, 119],
    base64: "synthetic-base64-bytes",
    sdp: "v=0\r\na=ice-pwd:synthetic-sdp-password\r\na=candidate:synthetic-sdp-address\r\n",
    binary: { type: "Buffer", data: [193, 194, 195] },
    content: [{ type: "input_audio", data: "synthetic-input-audio", transcript: "retain transcript" },
      { type: "input_text", text: "retain actual input_text.text", data: "retain ordinary data" }],
    delegation: { text: "retain delegation text" },
    instructions: "retain startup instructions",
    summary: "retain summary",
    usage: { input_tokens: 12 },
  };
  const json = JSON.stringify(sensitive);
  const escaped = JSON.stringify(json).slice(1, -1);
  const twiceEscaped = JSON.stringify(escaped).slice(1, -1);
  await trace.enable();
  sink.record("local", sensitive);
  for (const text of [json, escaped, twiceEscaped]) sink.record("local", { text: `before ${text} after` });
  // SDP as text inside JSON, not just under an explicitly sensitive key.
  for (const text of ["v=0\r\na=ice-pwd:synthetic-free-sdp\r\na=candidate:synthetic-free-address\r\n",
    String.raw`v=0\r\na=ice-pwd:synthetic-escaped-sdp\r\na=candidate:synthetic-escaped-address\r\n`]) {
    const sdpJSON = JSON.stringify({ text });
    sink.record("in", { text: sdpJSON });
    sink.record("in", { text: JSON.stringify(sdpJSON).slice(1, -1) });
  }
  sink.record("local", { text: 'prose [not JSON {"auth":"synthetic-auth-value","summary":"retain nested summary"}' });
  sink.record("out", { text: 'benign {"task":"write tests","count":2} prose',
    instructions: "Use auth when needed; credentials should stay private",
    summary: "Bearer synthetic-summary-secret; useful summary",
    delegation: { text: "password=synthetic-delegation-secret keep the task" } });
  await trace.disable();
  const output = await readFile(path, "utf8");
  assert.doesNotMatch(output, /synthetic-(?:auth-value|credential|secret|key-one|access-token|audio-bytes|base64|sdp|input-audio|free|escaped|summary-secret|delegation-secret)/);
  assert.doesNotMatch(output, /117,118,119|193,194,195/);
  const records = await rows(path);
  for (let i = 0; i < 4; i++) {
    let event = records[i].event;
    if (i > 0) {
      let embedded = event.text.slice("before ".length, -" after".length);
      for (let layer = 1; layer < i; layer++) embedded = JSON.parse(`"${embedded}"`);
      event = JSON.parse(embedded);
    }
    assert.equal(event.auth, "[redacted]");
    assert.equal(event.credentials, "[redacted]");
    assert.equal(event.secrets, "[redacted]");
    assert.equal(event.apiKeys, "[redacted]");
    assert.equal(event.access_tokens, "[redacted]");
    for (const key of ["audio", "pcm", "base64", "sdp"]) assert.equal(event[key], "[redacted]");
    assert.equal(event.binary, "[binary redacted]");
    assert.equal(event.content[0].data, "[redacted]");
    assert.equal(event.content[0].transcript, "retain transcript");
    assert.deepEqual(event.content[1], sensitive.content[1]);
    assert.deepEqual(event.delegation, sensitive.delegation);
    assert.equal(event.instructions, sensitive.instructions);
    assert.equal(event.summary, sensitive.summary);
  }
  assert.equal(records.at(-2).event.text, 'prose [not JSON {"auth":"[redacted]","summary":"retain nested summary"}');
  const last = records.at(-1).event;
  assert.equal(last.text, 'benign {"task":"write tests","count":2} prose');
  assert.equal(last.instructions, "Use auth when needed; credentials should stay private");
  assert.equal(last.summary, "Bearer [redacted]; useful summary");
  assert.equal(last.delegation.text, "password=[redacted] keep the task");
});

test("long embedded secret values are removed in full before any prefix is kept", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  const sink = trace.session("boundary");
  const credential = "synthetic-private-prefix-" + "q".repeat(20000) + "-synthetic-private-suffix";
  const json = JSON.stringify({ auth: credential, credentials: [credential], audio: credential,
    binary: { type: "Buffer", data: Array(10000).fill(239) }, summary: "retain boundary summary" });
  await trace.enable();
  for (const text of [json, JSON.stringify(json).slice(1, -1)]) sink.record("in", { text: "p".repeat(16360) + text });
  sink.record("in", { text: "synthetic-oversized-secret" + "q".repeat(200000) });
  await trace.disable();
  const output = await readFile(path, "utf8");
  assert.doesNotMatch(output, /synthetic-private|synthetic-oversized|q{20}|239,239/);
  const records = await rows(path);
  assert.equal(records.length, 3);
  assert.ok(records[0].event.text.endsWith("[truncated]"));
  assert.equal(records[2].event.text, "[redacted]");
});

test("unknown objects fail closed without getters, coercion, toJSON, or proxy traps", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  let called = 0;
  const trap = () => { called++; throw Error("synthetic-private-trap"); };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  class Unknown {
    toJSON = trap;
    toString = trap;
    [Symbol.toPrimitive] = trap;
    get secret() { return trap(); }
  }
  const accessor = Object.defineProperty({}, "text", { enumerable: true, get: trap });
  await trace.enable();
  const sink = trace.session("hostile");
  for (const value of [proxy, revoked.proxy, new Unknown(), accessor]) {
    assert.doesNotThrow(() => sink.record("in", { type: "hostile", value }));
  }
  sink.record("in", { type: "after-hostile", summary: "still useful" });
  await trace.disable();
  assert.equal(called, 0);
  const records = await rows(path);
  assert.deepEqual(records.slice(0, 3).map(r => r.event.value), Array(3).fill("[uninspectable]"));
  assert.deepEqual(records[3].event.value, { text: "[accessor omitted]" });
  assert.equal(records[4].event.summary, "still useful");
  assert.doesNotMatch(await readFile(path, "utf8"), /synthetic-private-trap/);
});

test("known secrets are session-local, bounded to 64, and Bearer variants are trimmed", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path });
  const a = trace.session("a"), b = trace.session("b");
  a.addSecrets(Array.from({ length: 65 }, (_, i) => `  Bearer known-${i}-secret  `));
  await trace.enable();
  a.record("local", { text: "known-0-secret known-63-secret known-64-secret" });
  b.record("local", { text: "known-0-secret" });
  await trace.disable();
  const records = await rows(path);
  assert.equal(records[0].event.text, "[redacted] [redacted] known-64-secret");
  assert.equal(records[1].event.text, "known-0-secret");
});

test("rejects symlink parents, files, backups and nonregular targets without chmodding victims", async t => {
  const { dir } = await fixture(t);
  const victim = join(dir, "victim");
  await mkdir(victim, { mode: 0o755 });
  await chmod(victim, 0o755);
  const victimFile = join(victim, "file");
  await writeFile(victimFile, "untouched", { mode: 0o644 });
  await chmod(victimFile, 0o644);
  const parentLink = join(dir, "parent-link");
  await symlink(victim, parentLink);
  const fileLink = join(dir, "file-link");
  await symlink(victimFile, fileLink);
  const backupPath = join(dir, "backup-target");
  await symlink(victimFile, backupPath + ".1");
  const directoryPath = join(dir, "directory-target");
  await mkdir(directoryPath);
  for (const path of [join(parentLink, "new"), fileLink, backupPath, directoryPath]) {
    let errors = 0;
    const trace = createTalkTrace({ path, onError() { errors++; throw Error("callback failure"); } });
    await trace.enable();
    assert.equal(trace.status().enabled, false);
    assert.doesNotThrow(() => trace.session("x").record("in", { text: "secret" }));
    await trace.enable();
    await trace.disable();
    assert.equal(errors, 1);
  }
  assert.equal((await stat(victim)).mode & 0o777, 0o755);
  assert.equal((await stat(victimFile)).mode & 0o777, 0o644);
  assert.equal(await readFile(victimFile, "utf8"), "untouched");
});

test("rotates one private backup with complete JSON records and a stable active path", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path, maxBytes: 1500 });
  const sink = trace.session("rotation");
  await trace.enable();
  for (let i = 0; i < 30; i++) sink.record("out", { type: "number", i, text: "x".repeat(180) });
  await trace.disable();
  const backup = await rows(path + ".1"), active = await rows(path);
  assert.equal(active.at(-1).event.i, 29);
  assert.ok(backup.at(-1).seq < active[0].seq);
  for (const file of [path, path + ".1"]) {
    assert.ok((await stat(file)).size <= 1500);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test("bounded queue drops synchronously, flushes a marker, and preserves concurrent order", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path, maxQueuedBytes: 1024, maxBytes: 100000 });
  const sink = trace.session("queue");
  await trace.enable();
  for (let i = 0; i < 10000; i++) sink.record("in", { type: "number", i, text: "x".repeat(200) });
  assert.ok(trace.status().dropped > 9900);
  await trace.disable();
  const records = await rows(path);
  assert.ok(records.length < 10);
  const markers = records.filter(r => r.type === "trace.dropped");
  assert.equal(markers.reduce((n, r) => n + r.event.count, 0), trace.status().dropped);
  assert.deepEqual(records.map(r => r.seq), records.map(r => r.seq).sort((a, b) => a - b));
  await trace.enable();
  await Promise.all(Array.from({ length: 4 }, (_, i) => Promise.resolve().then(() => sink.record("in", { i }))));
  await trace.disable();
  assert.deepEqual((await rows(path)).slice(-4).map(r => r.event.i), [0, 1, 2, 3]);
});

test("small record budgets remain valid with escaped and multibyte metadata", async t => {
  const { path } = await fixture(t);
  const trace = createTalkTrace({ path, maxBytes: 512, maxQueuedBytes: 512 });
  await trace.enable();
  trace.session("😀".repeat(100)).record("in", { type: "😀".repeat(100), text: "\\\"".repeat(20000) });
  await trace.disable();
  assert.ok((await stat(path)).size <= 512);
  assert.equal((await rows(path))[0].event.truncated, true);
});

test("existing regular files and backups are made private without losing appended records", async t => {
  const { path } = await fixture(t);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, '{"existing":true}\n', { mode: 0o644 });
  await writeFile(path + ".1", '{"backup":true}\n', { mode: 0o644 });
  const trace = createTalkTrace({ path });
  await trace.enable();
  trace.session("x").record("local", { type: "appended" });
  await trace.disable();
  assert.equal((await rows(path))[0].existing, true);
  assert.equal((await rows(path))[1].type, "appended");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(path + ".1")).mode & 0o777, 0o600);
});

test("concurrent lifecycle requests serialize, and rotation failures only disable tracing", async t => {
  const { path, dir } = await fixture(t);
  let errors = 0;
  const trace = createTalkTrace({ path, maxBytes: 512, onError() { errors++; } });
  const sink = trace.session("x");
  await Promise.all([trace.enable(), trace.disable(), trace.enable(), trace.disable()]);
  assert.equal(trace.status().enabled, false);
  await trace.enable();
  sink.record("in", { text: "one" });
  // Wait until the first record has reached disk, then replace the active pathname.
  for (let i = 0; i < 100 && !(await stat(path)).size; i++) await new Promise(r => setTimeout(r, 2));
  await rename(path, join(dir, "saved"));
  await symlink(join(dir, "saved"), path);
  for (let i = 0; i < 5; i++) sink.record("out", { text: "x".repeat(200) });
  await trace.disable();
  assert.equal(errors, 1);
  assert.equal(trace.status().enabled, false);
  sink.record("out", { text: "off" });
});
