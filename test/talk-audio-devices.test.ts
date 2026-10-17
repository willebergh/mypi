import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chooseTalkDevices, loadTalkAudioProfiles, loadTalkDeviceSettings, resetTalkAudioProfiles, requireVirtualAudio, saveTalkAudioProfile, saveTalkDeviceSettings } from "../extensions/talk/audio-devices.ts";

function config(audio: unknown = { physical: {}, virtual: {} }) {
  return { version: 1, audio, facetime: { allowedCallers: ["Caller"], allowedRecipients: ["recipient@example.com"], recipientAliases: { "recipient@example.com": ["Recipient"] }, callStartTimeoutSeconds: 15, ringingTimeoutSeconds: 60 } };
}
const devices = {
  inputs: [{ id: "mic1", name: "USB Mic", is_default: true }, { id: "mic2", name: "USB Mic", is_default: false }],
  outputs: [{ id: "out1", name: "Headphones", is_default: true }],
};
function context(answers: (string | undefined)[], titles: string[] = [], lists: string[][] = []) {
  return { hasUI: true, ui: { select: async (title: string, options: string[]) => { titles.push(title); lists.push(options); return answers.shift(); } } } as any;
}

test("audio reset refuses malformed canonical settings without erasing policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-profile-reset-")); const path = join(dir, "settings.json");
  try {
    await writeFile(path, "not valid JSON", { mode: 0o600 });
    await assert.rejects(loadTalkAudioProfiles(path));
    await assert.rejects(resetTalkAudioProfiles(path), /Repair the config/);
    assert.equal(await readFile(path, "utf8"), "not valid JSON");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("settings roundtrip, reset and absent file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  try {
    assert.deepEqual(await loadTalkDeviceSettings(path), {});
    assert.deepEqual(await loadTalkAudioProfiles(path), { physical: {}, virtual: {} });
    await saveTalkDeviceSettings({ microphone: { id: "mic1", name: "USB Mic" } }, path);
    assert.deepEqual(await loadTalkDeviceSettings(path), { microphone: { id: "mic1", name: "USB Mic" } });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1, audio: { physical: { microphone: { id: "mic1", name: "USB Mic" } }, virtual: {} },
      facetime: { allowedCallers: [], allowedRecipients: [], recipientAliases: {}, callStartTimeoutSeconds: 15, ringingTimeoutSeconds: 60 },
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ["settings.json"]);
    await saveTalkDeviceSettings({}, path);
    assert.deepEqual(await loadTalkDeviceSettings(path), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid JSON, version, schema, oversized file and IDs fail clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  try {
    for (const text of ["{", '{"version":2}', '{"other":true}', JSON.stringify(config({ physical: { microphone: { id: "x".repeat(513), name: "Mic" } }, virtual: {} })), " ".repeat(65537)]) {
      await writeFile(path, text, { mode: 0o600 });
      await assert.rejects(loadTalkDeviceSettings(path));
      await assert.rejects(loadTalkAudioProfiles(path));
      await assert.rejects(saveTalkAudioProfile("virtual", {}, path));
      assert.equal(await readFile(path, "utf8"), text);
    }
    await assert.rejects(saveTalkDeviceSettings({ speaker: { id: "bad\n", name: "Speaker" } }, path), /invalid id/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("profile saves and reset preserve the other profile and FaceTime policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  const physical = { microphone: { id: "mic1", name: "Mic" } };
  const virtual = { microphone: { id: "loop", name: "Loop" }, speaker: { id: "loop", name: "Loop" } };
  try {
    await writeFile(path, JSON.stringify(config({ physical, virtual: {} })), { mode: 0o600 });
    assert.deepEqual(await loadTalkAudioProfiles(path), { physical, virtual: {} });
    await saveTalkAudioProfile("virtual", virtual, path);
    assert.deepEqual(await loadTalkAudioProfiles(path), { physical, virtual });
    assert.deepEqual(await loadTalkDeviceSettings(path), physical);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config({ physical, virtual }));
    await saveTalkDeviceSettings({}, path);
    assert.deepEqual(await loadTalkAudioProfiles(path), { physical: {}, virtual });
    await saveTalkDeviceSettings(physical, path);
    await saveTalkAudioProfile("virtual", {}, path);
    assert.deepEqual(await loadTalkAudioProfiles(path), { physical, virtual: {} });
    await resetTalkAudioProfiles(path);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("overlapping profile saves preserve both profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  const physical = { microphone: { id: "mic", name: "Mic" } };
  const virtual = { speaker: { id: "loop", name: "Loop" } };
  try {
    await Promise.all([saveTalkAudioProfile("physical", physical, path), saveTalkAudioProfile("virtual", virtual, path)]);
    assert.deepEqual(await loadTalkAudioProfiles(path), { physical, virtual });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid profile schemas and device values never fall back or overwrite config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  try {
    for (const value of [
      null, [], { version: 3 }, { version: "1" },
      config({ physical: {}, virtual: null }),
      config({ physical: [], virtual: {} }),
      config({ physical: {}, virtual: {}, extra: true }),
      config({ physical: { version: 1 }, virtual: {} }),
      config({ physical: {}, virtual: { speaker: { id: "ok", name: "x".repeat(257) } } }),
      config({ physical: {}, virtual: { microphone: { id: "bad\n", name: "Mic" } } }),
      config({ physical: {}, virtual: { output: {} } }),
      config({ physical: {}, virtual: { speaker: { id: "ok", name: "Loop", extra: true } } }),
    ]) {
      const text = JSON.stringify(value);
      await writeFile(path, text, { mode: 0o600 });
      await assert.rejects(loadTalkAudioProfiles(path));
      await assert.rejects(loadTalkDeviceSettings(path));
      await assert.rejects(saveTalkDeviceSettings({}, path));
      assert.equal(await readFile(path, "utf8"), text);
    }
    await rm(path);
    await assert.rejects(saveTalkAudioProfile("invalid" as any, {}, path), /Unknown talk audio profile/);
    await assert.rejects(saveTalkAudioProfile("virtual", { speaker: { id: "x".repeat(513), name: "Output" } }, path), /invalid id/);
    await assert.rejects(saveTalkAudioProfile("physical", { microphone: { id: "mic", name: " " } }, path), /invalid display name/);
    await assert.rejects(saveTalkAudioProfile("virtual", { speaker: { id: "loop", name: "Loop\n" } }, path), /invalid display name/);
    await saveTalkAudioProfile("virtual", { speaker: { id: "loop", name: "  Loop " } }, path);
    assert.deepEqual((await loadTalkAudioProfiles(path)).virtual, { speaker: { id: "loop", name: "Loop" } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("virtual audio requires explicit microphone and output but allows matching aggregate IDs", () => {
  const device = { id: "aggregate", name: "Aggregate" };
  for (const settings of [{}, { microphone: device }, { speaker: device }]) {
    assert.throws(() => requireVirtualAudio(settings), /explicit microphone and output/);
  }
  assert.doesNotThrow(() => requireVirtualAudio({ microphone: device, speaker: device }));
  assert.throws(() => requireVirtualAudio({ microphone: device, speaker: { id: "", name: "Output" } }), /invalid id/);
});

test("picker is transactional, maps defaults and selection, marks duplicate names and missing saved selection", async () => {
  const titles: string[] = [], lists: string[][] = [];
  const result = await chooseTalkDevices(context(["2. USB Mic [current]", "System default"], titles, lists), { microphone: { id: "mic2", name: "Old Mic" } }, devices);
  assert.deepEqual(result, { microphone: { id: "mic2", name: "USB Mic" } });
  assert.match(lists[0][1], /1\. USB Mic \[default\]/);
  assert.match(lists[0][2], /2\. USB Mic \[current\]/);
  assert.equal(titles.length, 2);
  const unavailableTitles: string[] = [];
  await chooseTalkDevices(context(["System default", "System default"], unavailableTitles), { microphone: { id: "gone", name: "Old Mic" } }, devices);
  assert.match(unavailableTitles[0], /saved device unavailable: Old Mic/);
});

test("hardware named System default remains separately selectable", async () => {
  const unusual = { inputs: [{ id: "named-default", name: "System default", is_default: false }], outputs: [] };
  const result = await chooseTalkDevices(context(["1. System default", "System default"]), {}, unusual);
  assert.deepEqual(result, { microphone: { id: "named-default", name: "System default" } });
});

test("picker abort signal dismisses dialogs and prevents a second prompt", async () => {
  const controller = new AbortController();
  let prompts = 0;
  const ctx = { hasUI: true, ui: { select: async (_title: string, _options: string[], opts: { signal?: AbortSignal }) => {
    prompts++;
    assert.equal(opts.signal, controller.signal);
    controller.abort();
    return "System default";
  } } } as any;
  assert.equal(await chooseTalkDevices(ctx, {}, devices, controller.signal), undefined);
  assert.equal(prompts, 1);
  assert.equal(await chooseTalkDevices(ctx, {}, devices, controller.signal), undefined);
  assert.equal(prompts, 1);
});

test("cancel from either picker leaves selection unchanged", async () => {
  assert.equal(await chooseTalkDevices(context([undefined]), {}, devices), undefined);
  assert.equal(await chooseTalkDevices(context(["System default", undefined]), {}, devices), undefined);
  assert.equal(await chooseTalkDevices({ hasUI: false, ui: {} } as any, {}, devices), undefined);
});
