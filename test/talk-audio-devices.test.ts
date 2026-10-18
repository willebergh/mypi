import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as audio from "../extensions/talk/audio-devices.ts";
import { chooseTalkPhysicalDevices, loadTalkAudioProfiles, loadTalkDeviceSettings, resetTalkAudioProfiles, restoreTalkVirtualAudio, saveTalkDeviceSettings, validateManagedVirtualAudio } from "../extensions/talk/audio-devices.ts";
import { updateTalkConfig } from "../extensions/talk/config.ts";
import { MANAGED_VIRTUAL_AUDIO, VIRTUAL_AUDIO_VISIBLE_UID, VIRTUAL_AUDIO_INTERNAL_UID, VIRTUAL_AUDIO_VISIBLE_NAME, VIRTUAL_AUDIO_INTERNAL_NAME } from "../extensions/talk/virtual-audio.ts";

function config(audio: unknown = { physical: {}, virtual: MANAGED_VIRTUAL_AUDIO }) {
  return { version: 2, audio, facetime: { allowedCallers: ["Caller"], allowedRecipients: ["recipient@example.com"], recipientAliases: { "recipient@example.com": ["Recipient"] }, callStartTimeoutSeconds: 15, ringingTimeoutSeconds: 60 } };
}
const devices = {
  inputs: [{ id: "mic1", name: "USB Mic", is_default: true }, { id: "mic2", name: "USB Mic", is_default: false }],
  outputs: [{ id: "out1", name: "Headphones", is_default: true }],
};
function context(answers: (string | undefined)[], titles: string[] = [], lists: string[][] = []) {
  return { hasUI: true, ui: { select: async (title: string, options: string[]) => { titles.push(title); lists.push(options); return answers.shift(); } } } as any;
}

const invalidVirtual = [
  undefined, null, [], {}, "Pi Talk", { visibleUid: VIRTUAL_AUDIO_VISIBLE_UID },
  { internalUid: VIRTUAL_AUDIO_INTERNAL_UID },
  { visibleUid: VIRTUAL_AUDIO_INTERNAL_UID, internalUid: VIRTUAL_AUDIO_VISIBLE_UID },
  { ...MANAGED_VIRTUAL_AUDIO, visibleUid: "other" },
  { ...MANAGED_VIRTUAL_AUDIO, internalUid: "other" },
  { ...MANAGED_VIRTUAL_AUDIO, visibleUid: VIRTUAL_AUDIO_VISIBLE_UID + " " },
  { ...MANAGED_VIRTUAL_AUDIO, internalUid: null },
  { ...MANAGED_VIRTUAL_AUDIO, name: VIRTUAL_AUDIO_VISIBLE_NAME },
  { ...MANAGED_VIRTUAL_AUDIO, visibleName: VIRTUAL_AUDIO_VISIBLE_NAME },
  { ...MANAGED_VIRTUAL_AUDIO, internalName: VIRTUAL_AUDIO_INTERNAL_NAME },
  { microphone: { id: "loop", name: "Loop" }, speaker: { id: "loop", name: "Loop" } },
  { ...MANAGED_VIRTUAL_AUDIO, microphone: { id: "loop", name: "Loop" } },
];

test("managed virtual identity is exact, immutable and names are presentation-only constants", () => {
  assert.equal(VIRTUAL_AUDIO_VISIBLE_UID, "io.github.willebergh.pitalk.audio.visible");
  assert.equal(VIRTUAL_AUDIO_INTERNAL_UID, "io.github.willebergh.pitalk.audio.internal");
  assert.equal(VIRTUAL_AUDIO_VISIBLE_NAME, "Pi Talk");
  assert.equal(VIRTUAL_AUDIO_INTERNAL_NAME, "Pi Talk Internal");
  assert.deepEqual(Object.keys(MANAGED_VIRTUAL_AUDIO), ["visibleUid", "internalUid"]);
  assert.equal(Object.isFrozen(MANAGED_VIRTUAL_AUDIO), true);
  const normalized = validateManagedVirtualAudio(MANAGED_VIRTUAL_AUDIO);
  assert.deepEqual(normalized, MANAGED_VIRTUAL_AUDIO);
  assert.notEqual(normalized, MANAGED_VIRTUAL_AUDIO);
  for (const value of invalidVirtual) assert.throws(() => validateManagedVirtualAudio(value), /exactly the managed Pi Talk/);
  assert.throws(() => validateManagedVirtualAudio(Object.create(MANAGED_VIRTUAL_AUDIO)));
  // No generic profile writer or virtual-capable picker remains available.
  assert.equal("saveTalkAudioProfile" in audio, false);
  assert.equal("chooseTalkDevices" in audio, false);
  assert.equal("requireVirtualAudio" in audio, false);
});

test("physical settings roundtrip and absent file includes managed virtual defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  try {
    assert.deepEqual(await loadTalkDeviceSettings(path), {});
    assert.deepEqual(await loadTalkAudioProfiles(path), { physical: {}, virtual: MANAGED_VIRTUAL_AUDIO });
    await saveTalkDeviceSettings({ microphone: { id: "mic1", name: "  USB Mic " } }, path);
    const physical = { microphone: { id: "mic1", name: "USB Mic" } };
    assert.deepEqual(await loadTalkDeviceSettings(path), physical);
    const written = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(written.audio, { physical, virtual: MANAGED_VIRTUAL_AUDIO });
    assert.equal(written.version, 2);
    assert.deepEqual(written.facetime.allowedCallers, []);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ["settings.json"]);
    await saveTalkDeviceSettings({}, path);
    assert.deepEqual(await loadTalkDeviceSettings(path), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("physical saves, managed restore and audio reset preserve FaceTime policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  const physical = { microphone: { id: "mic1", name: "Mic" } };
  try {
    await writeFile(path, JSON.stringify(config({ physical, virtual: MANAGED_VIRTUAL_AUDIO })), { mode: 0o600 });
    await restoreTalkVirtualAudio(path);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config({ physical, virtual: MANAGED_VIRTUAL_AUDIO }));
    await Promise.all([saveTalkDeviceSettings({}, path), restoreTalkVirtualAudio(join(dir, ".", "settings.json"))]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config());
    await saveTalkDeviceSettings(physical, path);
    await resetTalkAudioProfiles(path);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config());
    await rm(path);
    await restoreTalkVirtualAudio(path);
    assert.deepEqual(await loadTalkAudioProfiles(path), config().audio);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid canonical config cannot be defaulted away by physical saves, restore or reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  try {
    for (const text of [
      "not valid JSON", '{"version":2}', JSON.stringify({ ...config(), version: 3 }), " ".repeat(65537),
      ...invalidVirtual.map((virtual) => JSON.stringify(config({ physical: {}, virtual }))),
      ...[[], { version: 1 }, { microphone: { id: "bad\n", name: "Mic" } }].map((physical) => JSON.stringify(config({ physical, virtual: MANAGED_VIRTUAL_AUDIO }))),
      JSON.stringify({ ...config(), facetime: { ...config().facetime, autoAnswer: true } }),
    ]) {
      await writeFile(path, text, { mode: 0o600 });
      await assert.rejects(loadTalkAudioProfiles(path));
      await assert.rejects(loadTalkDeviceSettings(path));
      await assert.rejects(saveTalkDeviceSettings({}, path));
      await assert.rejects(restoreTalkVirtualAudio(path), /Repair the config/);
      await assert.rejects(resetTalkAudioProfiles(path), /Repair the config/);
      assert.equal(await readFile(path, "utf8"), text);
      assert.deepEqual(await readdir(dir), ["settings.json"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid physical saves and managed mutations leave the canonical bytes untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "talk-devices-")); const path = join(dir, "settings.json");
  try {
    await writeFile(path, JSON.stringify(config()), { mode: 0o600 });
    const before = await readFile(path);
    for (const value of [null, [], { extra: true },
      { speaker: { id: "x".repeat(513), name: "Output" } },
      { microphone: { id: "mic", name: " " } },
      { speaker: { id: "loop", name: "Loop\n" } },
      { speaker: { id: "ok", name: "Loop", extra: true } },
    ]) await assert.rejects(saveTalkDeviceSettings(value as any, path));
    for (const virtual of invalidVirtual) {
      await assert.rejects(updateTalkConfig((config) => { config.audio.virtual = virtual as any; }, path));
    }
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readdir(dir), ["settings.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("physical picker is transactional, maps defaults and selection, marks duplicate names and missing selection", async () => {
  const titles: string[] = [], lists: string[][] = [];
  const result = await chooseTalkPhysicalDevices(context(["2. USB Mic [current]", "System default"], titles, lists), { microphone: { id: "mic2", name: "Old Mic" } }, devices);
  assert.deepEqual(result, { microphone: { id: "mic2", name: "USB Mic" } });
  assert.match(lists[0][1], /1\. USB Mic \[default\]/);
  assert.match(lists[0][2], /2\. USB Mic \[current\]/);
  assert.equal(titles.length, 2);
  const unavailableTitles: string[] = [];
  await chooseTalkPhysicalDevices(context(["System default", "System default"], unavailableTitles), { microphone: { id: "gone", name: "Old Mic" } }, devices);
  assert.match(unavailableTitles[0], /saved device unavailable: Old Mic/);
});

test("hardware named System default remains separately selectable", async () => {
  const unusual = { inputs: [{ id: "named-default", name: "System default", is_default: false }], outputs: [] };
  const result = await chooseTalkPhysicalDevices(context(["1. System default", "System default"]), {}, unusual);
  assert.deepEqual(result, { microphone: { id: "named-default", name: "System default" } });
});

test("physical picker abort signal dismisses dialogs and prevents a second prompt", async () => {
  const controller = new AbortController();
  let prompts = 0;
  const ctx = { hasUI: true, ui: { select: async (_title: string, _options: string[], opts: { signal?: AbortSignal }) => {
    prompts++;
    assert.equal(opts.signal, controller.signal);
    controller.abort();
    return "System default";
  } } } as any;
  assert.equal(await chooseTalkPhysicalDevices(ctx, {}, devices, controller.signal), undefined);
  assert.equal(prompts, 1);
  assert.equal(await chooseTalkPhysicalDevices(ctx, {}, devices, controller.signal), undefined);
  assert.equal(prompts, 1);
});

test("cancel from either physical picker leaves selection unchanged", async () => {
  assert.equal(await chooseTalkPhysicalDevices(context([undefined]), {}, devices), undefined);
  assert.equal(await chooseTalkPhysicalDevices(context(["System default", undefined]), {}, devices), undefined);
  assert.equal(await chooseTalkPhysicalDevices({ hasUI: false, ui: {} } as any, {}, devices), undefined);
});
