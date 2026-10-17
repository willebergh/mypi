import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getTalkConfigPath, loadTalkConfig, resetTalkAudioProfiles, updateTalkConfig, type TalkConfig } from "../extensions/talk/config.ts";
import { saveTalkAudioProfile } from "../extensions/talk/audio-devices.ts";

const run = promisify(execFile);
const backupSuffix = ".pre-talk-json.bak";
const physical = { microphone: { id: "mic", name: "USB Mic" }, speaker: { id: "headphones", name: "Headphones" } };
const virtual = { microphone: { id: "caller", name: "Caller Audio" }, speaker: { id: "agent", name: "Agent Audio" } };
const facetime = {
  allowedCallers: ["Caller", "+46 70-123 45 67"], allowedRecipients: ["target@example.com"],
  recipientAliases: { "target@example.com": ["Target", "Target Contact"], "not-a-dial-target": ["Other"] },
  callStartTimeoutSeconds: 22.5, ringingTimeoutSeconds: 91,
};
function defaults(): TalkConfig {
  return { version: 1, audio: { physical: {}, virtual: {} }, facetime: { allowedCallers: [], allowedRecipients: [], recipientAliases: {}, callStartTimeoutSeconds: 15, ringingTimeoutSeconds: 60 } };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "talk-config-"));
  return { dir, path: join(dir, "talk.json"), audio: join(dir, "talk-devices.json"), facetime: join(dir, "swift.json") };
}
async function put(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("missing explicit config creates private exact defaults and never probes nearby legacy files", async () => {
  const f = await fixture();
  try {
    await put(f.audio, { version: 1, ...physical });
    await put(f.facetime, { autoAnswer: true });
    assert.deepEqual(await loadTalkConfig(f.path), defaults());
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), defaults());
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    await absent(f.audio + backupSuffix);
    await absent(f.facetime + backupSuffix);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("default canonical path migrates only the default agent-dir audio and home Swift paths", async () => {
  const f = await fixture();
  const oldHome = process.env.HOME;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.HOME = f.dir;
    process.env.PI_CODING_AGENT_DIR = join(f.dir, "agent");
    const audio = join(process.env.PI_CODING_AGENT_DIR, "talk-devices.json");
    const swift = join(f.dir, ".config", "pi-facetime", "config.json");
    await put(audio, { version: 1, ...physical });
    await put(swift, facetime);
    assert.equal(getTalkConfigPath(), join(f.dir, "agent", "talk.json"));
    assert.deepEqual(await loadTalkConfig(), { version: 1, audio: { physical, virtual: {} }, facetime });
    assert.equal((await stat(audio + backupSuffix)).mode & 0o777, 0o600);
    assert.equal((await stat(swift + backupSuffix)).mode & 0o777, 0o600);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const version of [undefined, 1, 2]) {
  test(`legacy audio ${version ?? "flat"} preserves picks and policy without broadening; backups are exact and migration is idempotent`, async () => {
    const f = await fixture();
    try {
      await put(f.audio, version === 2 ? { version, physical, virtual } : { version, ...physical });
      await put(f.facetime, { ...facetime, autoAnswer: false, ...(version === 2 ? { inputDevice: virtual.speaker.name, outputDevice: virtual.microphone.name } : { inputDevice: "Unidentified Output", outputDevice: "Unidentified Input" }) });
      const audioBefore = await readFile(f.audio);
      const swiftBefore = await readFile(f.facetime);
      const expected = { version: 1, audio: { physical, virtual: version === 2 ? virtual : {} }, facetime };
      assert.deepEqual(await loadTalkConfig(f.path, f), expected);
      for (const [path, before] of [[f.audio, audioBefore], [f.facetime, swiftBefore]] as const) {
        assert.deepEqual(await readFile(path), before); // Old running service/rollback is untouched.
        assert.deepEqual(await readFile(path + backupSuffix), before);
        assert.equal((await stat(path + backupSuffix)).mode & 0o777, 0o600);
      }
      const canonicalBefore = await readFile(f.path);
      // New readers must ignore even broken, unsafe legacy policy after canonical exists.
      await writeFile(f.facetime, "{broken");
      await chmod(f.facetime, 0o644);
      await writeFile(f.audio, "{broken");
      assert.deepEqual(await loadTalkConfig(f.path, f), expected);
      assert.deepEqual(await readFile(f.path), canonicalBefore);
      assert.deepEqual(await readFile(f.audio + backupSuffix), audioBefore);
      assert.deepEqual(await readFile(f.facetime + backupSuffix), swiftBefore);
      assert.deepEqual((await loadTalkConfig(f.path)).facetime.allowedRecipients, ["target@example.com"]);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test("sparse legacy Swift config defaults safely, without synthesizing virtual device IDs", async () => {
  const f = await fixture();
  try {
    await put(f.facetime, { inputDevice: "Agent Output", outputDevice: "Caller Input", autoAnswer: false });
    assert.deepEqual(await loadTalkConfig(f.path, f), defaults());
    assert.deepEqual(await readFile(f.facetime + backupSuffix), await readFile(f.facetime));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("migration refuses auto-answer until explicitly disabled, without writing anything", async () => {
  const f = await fixture();
  try {
    await put(f.audio, { version: 2, physical, virtual });
    await put(f.facetime, { ...facetime, autoAnswer: true });
    const before = await readFile(f.facetime);
    await assert.rejects(loadTalkConfig(f.path, f), /Disable autoAnswer first.*false/);
    await absent(f.path); await absent(f.audio + backupSuffix); await absent(f.facetime + backupSuffix);
    assert.deepEqual(await readFile(f.facetime), before);
    await put(f.facetime, { ...facetime, autoAnswer: false });
    assert.deepEqual((await loadTalkConfig(f.path, f)).facetime, facetime);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("legacy routing must match inverse virtual names; direct-direction matches are conflicts", async () => {
  for (const routing of [
    { inputDevice: virtual.microphone.name }, { outputDevice: virtual.speaker.name },
    { inputDevice: "Other" }, { outputDevice: "Other" },
  ]) {
    const f = await fixture();
    try {
      await put(f.audio, { version: 2, physical, virtual });
      await put(f.facetime, { ...facetime, ...routing });
      await assert.rejects(loadTalkConfig(f.path, f), /conflicts with the inverse Talk virtual/);
      await absent(f.path); await absent(f.audio + backupSuffix); await absent(f.facetime + backupSuffix);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});

test("invalid legacy policies and audio never default away authorization or overwrite originals", async () => {
  const invalidPolicies = [
    null, [], { allowedCallers: "Caller" }, { allowedRecipients: [null] }, { allowedCallers: [""] },
    { allowedCallers: ["Caller\n"] }, { allowedCallers: ["x".repeat(513)] },
    { allowedCallers: Array(129).fill("Caller") }, { allowedRecipients: Array(129).fill("Target") },
    { recipientAliases: [] }, { recipientAliases: { Target: "Alias" } },
    { recipientAliases: { Target: Array(129).fill("Alias") } },
    { recipientAliases: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`Target${i}`, []])) },
    { recipientAliases: { "": ["Alias"] } }, { callStartTimeoutSeconds: 0 }, { ringingTimeoutSeconds: -1 },
    { ringingTimeoutSeconds: "60" }, { autoAnswer: "false" }, { inputDevice: 42 },
    { allowedCaller: ["Typo"] }, { allowedRecipients: null },
  ];
  const f = await fixture();
  try {
    await put(f.audio, { version: 1, ...physical });
    for (const value of invalidPolicies) {
      await put(f.facetime, value);
      const before = await readFile(f.facetime);
      await assert.rejects(loadTalkConfig(f.path, f), /Repair the config/);
      assert.deepEqual(await readFile(f.facetime), before);
      await absent(f.path); await absent(f.audio + backupSuffix); await absent(f.facetime + backupSuffix);
    }
    await put(f.facetime, {});
    for (const value of [null, { version: 9 }, { version: 2, physical, virtual: null }, { version: 1, microphone: { id: "bad\n", name: "Mic" } }]) {
      await put(f.audio, value);
      await assert.rejects(loadTalkConfig(f.path, f));
      await absent(f.path); await absent(f.audio + backupSuffix);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("canonical schema is exact: legacy fields, missing policy, malformed audio and versions fail safely even on reset", async () => {
  const f = await fixture();
  try {
    for (const value of [
      null, [], { version: 2, physical, virtual }, { ...defaults(), version: 2 },
      { version: 1, audio: defaults().audio }, { ...defaults(), audio: null },
      { ...defaults(), facetime: { ...facetime, allowedCallers: null } },
      { ...defaults(), facetime: { ...facetime, autoAnswer: false } },
      { ...defaults(), facetime: { ...facetime, inputDevice: "Loop" } },
      { ...defaults(), autoAnswer: false }, { ...defaults(), inputDevice: "Loop" },
      { ...defaults(), outputDevice: "Loop" }, { ...defaults(), facetime: {} },
      { ...defaults(), audio: { physical: { microphone: { id: "", name: "Mic" } }, virtual: {} } },
    ]) {
      await put(f.path, value);
      const before = await readFile(f.path);
      await assert.rejects(loadTalkConfig(f.path, f), /Repair the config/);
      await assert.rejects(resetTalkAudioProfiles(f.path), /Repair the config/);
      await assert.rejects(updateTalkConfig(() => {}, f.path));
      assert.deepEqual(await readFile(f.path), before);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("non-private, symlinked, non-regular, oversized and invalid-encoding files are rejected", async () => {
  const f = await fixture();
  try {
    for (const path of [f.path, f.audio, f.facetime]) {
      const value = path === f.path ? defaults() : path === f.audio ? { version: 1 } : {};
      await put(path, value);
      await chmod(path, 0o644);
      if (process.platform !== "win32") await assert.rejects(loadTalkConfig(f.path, f), /owner-only/);
      await rm(path);
      const target = join(f.dir, "target");
      await put(target, value);
      await symlink(target, path);
      await assert.rejects(loadTalkConfig(f.path, f), /regular file/);
      await rm(path); await rm(target);
      await symlink(target, path); // Dangling symlinks aren't absence.
      await assert.rejects(loadTalkConfig(f.path, f), /regular file/);
      await rm(path);
      await mkdir(path);
      await assert.rejects(loadTalkConfig(f.path, f), /regular file/);
      await rm(path, { recursive: true });
      await writeFile(path, " ".repeat(65537), { mode: 0o600 });
      await assert.rejects(loadTalkConfig(f.path, f), /exceeds 65536/);
      await writeFile(path, Buffer.from([0xff]));
      await assert.rejects(loadTalkConfig(f.path, f), /UTF-8/);
      await writeFile(path, "{");
      await assert.rejects(loadTalkConfig(f.path, f), /Invalid JSON/);
      await rm(path);
      await absent(f.audio + backupSuffix); await absent(f.facetime + backupSuffix);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("foreign ownership is rejected on POSIX when chown is available", { skip: process.platform === "win32" || process.getuid?.() !== 0 }, async () => {
  const f = await fixture();
  try {
    await put(f.path, defaults());
    await chown(f.path, 1, 1);
    await assert.rejects(loadTalkConfig(f.path), /owned by the current user/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("deleting shared config never resurrects legacy calling permissions after migration", async () => {
  const f = await fixture();
  try {
    await put(f.facetime, facetime);
    await loadTalkConfig(f.path, f);
    await updateTalkConfig((config) => { config.facetime.allowedCallers = []; config.facetime.allowedRecipients = []; }, f.path);
    await rm(f.path);
    await assert.rejects(loadTalkConfig(f.path, f), /Old calling policy is not re-imported/);
    await absent(f.path);
    assert.deepEqual(JSON.parse(await readFile(f.facetime + backupSuffix, "utf8")), facetime);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("existing backups stop implicit re-import, stay private/unchanged, and cannot be symlinks", async () => {
  const f = await fixture();
  try {
    await put(f.facetime, facetime);
    const backup = f.facetime + backupSuffix;
    await writeFile(backup, "original backup", { mode: 0o600 });
    await assert.rejects(loadTalkConfig(f.path, f), /migration backups already exist/);
    await absent(f.path);
    assert.equal(await readFile(backup, "utf8"), "original backup");
    await rm(backup);
    await symlink(f.facetime, backup);
    await assert.rejects(loadTalkConfig(f.path, f), /regular file/);
    await absent(f.path);
    await rm(backup);
    await writeFile(backup, "nonprivate backup", { mode: 0o644 });
    if (process.platform !== "win32") {
      await assert.rejects(loadTalkConfig(f.path, f), /owner-only/);
      await absent(f.path);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("overlapping audio/policy updates serialize read-modify-write; reset preserves all policy", async () => {
  const f = await fixture();
  try {
    await Promise.all([
      updateTalkConfig(async (config) => { await new Promise((r) => setTimeout(r, 10)); config.facetime = structuredClone(facetime); }, f.path),
      saveTalkAudioProfile("physical", physical, f.path),
      saveTalkAudioProfile("virtual", virtual, join(f.dir, ".", "talk.json")),
      ...Array.from({ length: 20 }, (_, i) => updateTalkConfig((config) => { config.facetime.allowedCallers.push(`Caller ${i}`); }, f.path)),
    ]);
    const config = await loadTalkConfig(f.path);
    assert.deepEqual(config.audio, { physical, virtual });
    assert.deepEqual(config.facetime, { ...facetime, allowedCallers: [...facetime.allowedCallers, ...Array.from({ length: 20 }, (_, i) => `Caller ${i}`)] });
    await resetTalkAudioProfiles(f.path);
    assert.deepEqual(await loadTalkConfig(f.path), { ...config, audio: { physical: {}, virtual: {} } });
    assert.deepEqual(await readdir(f.dir), ["talk.json"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("an external policy edit during an asynchronous audio update is never silently overwritten", async () => {
  const f = await fixture();
  try {
    const original = { version: 1 as const, audio: { physical: {}, virtual: {} }, facetime };
    await put(f.path, original);
    const revoked = { ...original, facetime: { ...facetime, allowedCallers: [], allowedRecipients: [] } };
    await assert.rejects(updateTalkConfig(async (config) => {
      config.audio.physical = physical;
      await put(f.path, revoked);
    }, f.path), /changed during update/);
    assert.deepEqual(await loadTalkConfig(f.path), revoked);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("failed mutators, nonfinite timeouts and oversized writes leave canonical policy intact and do not poison the queue", async () => {
  const f = await fixture();
  try {
    await put(f.path, { version: 1, audio: { physical, virtual }, facetime });
    const before = await readFile(f.path);
    await assert.rejects(updateTalkConfig((config) => { config.facetime.allowedCallers = []; throw new Error("abort"); }, f.path), /abort/);
    for (const value of [Infinity, NaN, -1, 0, 0.5, 3601]) {
      await assert.rejects(updateTalkConfig((config) => { config.facetime.ringingTimeoutSeconds = value; }, f.path), /finite number from 1 to 3600/);
    }
    await assert.rejects(updateTalkConfig((config) => { config.facetime.allowedCallers = Array(128).fill("x".repeat(512)); }, f.path), /exceeds 65536/);
    await assert.rejects(updateTalkConfig((config) => { config.facetime.allowedCallers = Array(2); }, f.path), /list of at most 128/);
    assert.deepEqual(await readFile(f.path), before);
    await saveTalkAudioProfile("physical", {}, f.path);
    assert.deepEqual((await loadTalkConfig(f.path)).facetime, facetime);
    assert.deepEqual(await readdir(f.dir), ["talk.json"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("boundary-sized lists and UTF-8 device IDs roundtrip without normalization or alias expansion", async () => {
  const f = await fixture();
  try {
    const config = defaults();
    config.audio.physical.microphone = { id: "é".repeat(256), name: "é".repeat(128) };
    config.facetime.allowedCallers = Array.from({ length: 128 }, (_, i) => ` Caller ${i} `);
    config.facetime.recipientAliases = JSON.parse('{"__proto__":["Alias"],"constructor":["Other"]}');
    await put(f.path, config);
    assert.deepEqual(await loadTalkConfig(f.path), config);
    await updateTalkConfig(() => {}, f.path);
    assert.deepEqual(await loadTalkConfig(f.path), config);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("independent concurrent creators never clobber the first canonical policy", async () => {
  const f = await fixture();
  try {
    const sources = await Promise.all(Array.from({ length: 4 }, async (_, i) => {
      const path = join(f.dir, `swift-${i}.json`);
      await put(path, { ...facetime, allowedCallers: [`Creator ${i}`] });
      return path;
    }));
    const module = new URL("../extensions/talk/config.ts", import.meta.url).href;
    const script = `import { loadTalkConfig } from ${JSON.stringify(module)}; console.log(JSON.stringify(await loadTalkConfig(process.argv[1], { facetime: process.argv[2] })));`;
    const results = await Promise.all(sources.map((source) => run(process.execPath, ["--input-type=module", "-e", script, f.path, source])));
    const canonical = await loadTalkConfig(f.path);
    assert.match(canonical.facetime.allowedCallers[0], /^Creator [0-3]$/);
    for (const result of results) assert.deepEqual(JSON.parse(result.stdout), canonical);
    const entries = await readdir(f.dir);
    assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
