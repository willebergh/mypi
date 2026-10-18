import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MANAGED_VIRTUAL_AUDIO, validateManagedVirtualAudio, type ManagedVirtualAudio } from "./virtual-audio.ts";

export interface TalkDeviceSettings {
  microphone?: { id: string; name: string };
  speaker?: { id: string; name: string };
}
export interface TalkAudioProfiles {
  physical: TalkDeviceSettings;
  virtual: ManagedVirtualAudio;
}
type LegacyAudioProfiles = { physical: TalkDeviceSettings; virtual: TalkDeviceSettings };
export interface TalkConfig {
  version: 2;
  audio: TalkAudioProfiles;
  facetime: {
    allowedCallers: string[];
    allowedRecipients: string[];
    recipientAliases: Record<string, string[]>;
    callStartTimeoutSeconds: number;
    ringingTimeoutSeconds: number;
  };
}

type LegacyPaths = { audio?: string; facetime?: string };
const MAX_FILE_BYTES = 64 * 1024;
const MAX_LIST = 128;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const pending = new Map<string, Promise<unknown>>();
const policyKeys = ["allowedCallers", "allowedRecipients", "recipientAliases", "callStartTimeoutSeconds", "ringingTimeoutSeconds"];

export function getTalkConfigPath(): string {
  return join(getAgentDir(), "talk.json");
}

function defaults(): TalkConfig {
  return {
    version: 2, audio: { physical: {}, virtual: { ...MANAGED_VIRTUAL_AUDIO } },
    facetime: { allowedCallers: [], allowedRecipients: [], recipientAliases: {}, callStartTimeoutSeconds: 15, ringingTimeoutSeconds: 60 },
  };
}

function object(value: unknown, label: string, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (keys) for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  return result;
}

function validString(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && Buffer.byteLength(value) <= max
    && Buffer.from(value).toString("utf8") === value && !CONTROL.test(value);
}

function device(value: unknown, label: string): { id: string; name: string } {
  const item = object(value, label, ["id", "name"]);
  if (!validString(item.id, 512)) throw new Error(`${label} has an invalid id (at most 512 UTF-8 bytes, no control characters)`);
  if (!validString(item.name, 256)) throw new Error(`${label} has an invalid display name`);
  const name = item.name.trim();
  return { id: item.id, name };
}

export function validateTalkDeviceSettings(value: unknown): TalkDeviceSettings {
  const settings = object(value, "talk device settings", ["microphone", "speaker"]);
  const result: TalkDeviceSettings = {};
  if (Object.hasOwn(settings, "microphone")) result.microphone = device(settings.microphone, "microphone");
  if (Object.hasOwn(settings, "speaker")) result.speaker = device(settings.speaker, "speaker");
  return result;
}

function profiles(value: unknown): TalkAudioProfiles {
  const audio = object(value, "talk audio profiles", ["physical", "virtual"]);
  return { physical: validateTalkDeviceSettings(audio.physical), virtual: validateManagedVirtualAudio(audio.virtual) };
}

function legacyProfiles(value: unknown): LegacyAudioProfiles {
  const audio = object(value, "legacy talk audio profiles", ["physical", "virtual"]);
  return { physical: validateTalkDeviceSettings(audio.physical), virtual: validateTalkDeviceSettings(audio.virtual) };
}

function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST || !Array.from(value).every((entry) => validString(entry, 512))) {
    throw new Error(`${label} must be a list of at most 128 nonempty identities (512 UTF-8 bytes each, no control characters)`);
  }
  // Never trim, normalize, expand aliases, or merge authorization lists during migration.
  return [...value];
}

function policy(value: unknown): TalkConfig["facetime"] {
  const settings = object(value, "FaceTime policy", policyKeys);
  const aliases = object(settings.recipientAliases, "recipientAliases");
  if (Object.keys(aliases).length > MAX_LIST) throw new Error("recipientAliases exceeds 128 entries");
  const entries = Object.entries(aliases).map(([key, value]) => {
    if (!validString(key, 512)) throw new Error("Invalid recipientAliases identity");
    return [key, list(value, `recipientAliases[${key}]`)] as const;
  });
  for (const key of ["callStartTimeoutSeconds", "ringingTimeoutSeconds"]) {
    const value = settings[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 3600) throw new Error(`${key} must be a finite number from 1 to 3600 seconds`);
  }
  return {
    allowedCallers: list(settings.allowedCallers, "allowedCallers"),
    allowedRecipients: list(settings.allowedRecipients, "allowedRecipients"),
    recipientAliases: Object.fromEntries(entries),
    callStartTimeoutSeconds: settings.callStartTimeoutSeconds as number,
    ringingTimeoutSeconds: settings.ringingTimeoutSeconds as number,
  };
}

function validate(value: unknown): TalkConfig {
  const config = object(value, "Talk config", ["version", "audio", "facetime"]);
  if (config.version !== 2) throw new Error(`Unsupported Talk config version: ${String(config.version)}`);
  return { version: 2, audio: profiles(config.audio), facetime: policy(config.facetime) };
}

function parse(bytes: Buffer, path: string): unknown {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error(`Invalid UTF-8 in ${path}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON in ${path}`); }
}

/** Inspect before opening (including dangling symlinks), then validate the opened inode. */
async function readPrivateOnce(path: string): Promise<Buffer | undefined> {
  try {
    const before = await lstat(path);
    if (!before.isFile()) throw new Error(`Config must be a regular file, not a symlink: ${path}`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) throw new Error(`Config changed while opening: ${path}`);
      if (process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o7777) !== 0o600)) {
        throw new Error(`Config must be owned by the current user and owner-only (chmod 600): ${path}`);
      }
      if (info.size > MAX_FILE_BYTES) throw new Error(`Config exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_FILE_BYTES) throw new Error(`Config exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      return buffer.subarray(0, length);
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readPrivate(path: string): Promise<Buffer | undefined> {
  for (let attempt = 0; ; attempt++) {
    try { return await readPrivateOnce(path); }
    catch (error) {
      // Atomic writers replace the path between lstat and open. Retry the full
      // no-follow/inode validation; never continue using either raced handle.
      if (attempt < 3 && error instanceof Error && error.message.startsWith("Config changed while opening:")) continue;
      throw error;
    }
  }
}

function payload(config: TalkConfig): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(validate(config), null, 2)}\n`);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Talk config exceeds ${MAX_FILE_BYTES} bytes`);
  return bytes;
}

/** Link-based publication is atomic and cannot replace another process's first config/backup. */
async function publish(path: string, bytes: Buffer, replace = false): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      if (process.platform !== "win32") await file.chmod(0o600);
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    if (replace) await rename(temporary, path);
    else {
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    }
    return true;
  } finally { await rm(temporary, { force: true }); }
}

function legacyAudio(value: unknown): LegacyAudioProfiles {
  const audio = object(value, "legacy audio config");
  if (audio.version === 2) {
    object(audio, "legacy audio config", ["version", "physical", "virtual"]);
    return legacyProfiles({ physical: audio.physical, virtual: audio.virtual });
  }
  if (audio.version !== undefined && audio.version !== 1) throw new Error("Unsupported legacy audio config version");
  object(audio, "legacy audio config", ["version", "microphone", "speaker"]);
  const { version: _version, ...settings } = audio;
  return { physical: validateTalkDeviceSettings(settings), virtual: {} };
}

function legacyPolicy(value: unknown, config: TalkConfig, virtual: TalkDeviceSettings): void {
  const settings = object(value, "legacy FaceTime config", [...policyKeys, "autoAnswer", "inputDevice", "outputDevice"]);
  if (settings.autoAnswer === true) throw new Error("Disable autoAnswer first: set autoAnswer to false in the legacy FaceTime config and restart/stop the old service before migrating to talk.json");
  if (settings.autoAnswer !== undefined && typeof settings.autoAnswer !== "boolean") throw new Error("Legacy autoAnswer must be a boolean");
  for (const [key, selection] of [["inputDevice", virtual.speaker], ["outputDevice", virtual.microphone]] as const) {
    const name = settings[key];
    if (name === undefined || name === null) continue; // Swift's optional device names may be encoded as null.
    if (!validString(name, 256)) throw new Error(`Invalid legacy ${key}`);
    if (selection && selection.name !== name) throw new Error(`Legacy ${key} conflicts with the inverse Talk virtual ${key === "inputDevice" ? "speaker" : "microphone"}. Repair the device selections before migrating.`);
  }
  const provided = Object.fromEntries(policyKeys.filter((key) => Object.hasOwn(settings, key)).map((key) => [key, settings[key]]));
  config.facetime = policy({ ...defaults().facetime, ...provided });
}

/** Validate all of v1 (including the discarded virtual pair) before writing anything. */
async function canonical(path: string, bytes: Buffer): Promise<TalkConfig> {
  const value = object(parse(bytes, path), "Talk config", ["version", "audio", "facetime"]);
  if (value.version !== 1) return validate(value);
  const audio = legacyProfiles(value.audio);
  const config: TalkConfig = {
    version: 2,
    audio: { physical: audio.physical, virtual: { ...MANAGED_VIRTUAL_AUDIO } },
    facetime: policy(value.facetime),
  };
  const migrated = payload(config);
  const backup = `${path}.pre-v2.bak`;
  if (!await publish(backup, bytes)) {
    const saved = await readPrivate(backup);
    if (!saved?.equals(bytes)) throw new Error(`Migration backup differs from the v1 config: ${backup}; it will not be overwritten`);
  }
  const latest = await readPrivate(path);
  if (latest === undefined) throw new Error("Talk config disappeared during migration; restore the backup before retrying");
  if (!latest.equals(bytes)) return canonical(path, latest); // A concurrent canonical edit wins.
  await publish(path, migrated, true);
  return config;
}

async function load(path: string, legacyPaths?: LegacyPaths): Promise<TalkConfig> {
  const current = await readPrivate(path);
  if (current !== undefined) return canonical(path, current);
  if (await readPrivate(`${path}.pre-v2.bak`) !== undefined) {
    throw new Error("Shared talk.json is missing but a pre-v2 migration backup already exists; restore a known shared config before retrying. Old calling policy is not re-imported automatically");
  }
  const paths = legacyPaths ?? (path === resolve(getTalkConfigPath()) ? {
    audio: join(getAgentDir(), "talk-devices.json"),
    facetime: join(homedir(), ".config", "pi-facetime", "config.json"),
  } : {});
  const config = defaults();
  const originals: { path: string; bytes: Buffer }[] = [];
  let oldVirtual: TalkDeviceSettings = {};
  for (const kind of ["audio", "facetime"] as const) {
    const source = paths[kind];
    if (!source) continue;
    if (resolve(source) === path) throw new Error("Legacy and canonical config paths must differ");
    const bytes = await readPrivate(source);
    if (bytes === undefined) continue;
    try {
      const value = parse(bytes, source);
      if (kind === "audio") {
        const audio = legacyAudio(value);
        config.audio.physical = audio.physical;
        oldVirtual = audio.virtual;
      } else legacyPolicy(value, config, oldVirtual);
    } catch (error) {
      throw new Error(`Invalid legacy ${kind} config ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    originals.push({ path: source, bytes });
  }
  const bytes = payload(config); // Validate everything before making even a backup.
  for (const original of originals) {
    if (await readPrivate(`${original.path}.pre-talk-json.bak`) !== undefined) {
      const winner = await readPrivate(path);
      if (winner !== undefined) return canonical(path, winner);
      throw new Error("Shared talk.json is missing but migration backups already exist; restore a known shared config or explicitly archive the legacy files before starting fresh. Old calling policy is not re-imported automatically");
    }
  }
  for (const original of originals) {
    const backup = `${original.path}.pre-talk-json.bak`;
    if (!await publish(backup, original.bytes)) await readPrivate(backup);
  }
  if (await publish(path, bytes)) return config;
  // A concurrent creator won. Its canonical policy is authoritative, never the legacy files.
  const winner = await readPrivate(path);
  if (winner === undefined) throw new Error("Talk config disappeared during creation; retry");
  return canonical(path, winner);
}

async function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  pending.set(path, next);
  try { return await next; }
  finally { if (pending.get(path) === next) pending.delete(path); }
}

async function withRepairError<T>(path: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    throw new Error(`Cannot use Talk config ${path}: ${error instanceof Error ? error.message : String(error)}. Repair the config before retrying; audio reset cannot erase FaceTime policy.`, { cause: error });
  }
}

export async function loadTalkConfig(path = getTalkConfigPath(), legacyPaths?: LegacyPaths): Promise<TalkConfig> {
  const key = resolve(path);
  return serialized(key, () => withRepairError(key, () => load(key, legacyPaths)));
}

export async function loadTalkFaceTimeRecipient(path = getTalkConfigPath()): Promise<string> {
  const recipients = (await loadTalkConfig(path)).facetime.allowedRecipients;
  if (recipients.length !== 1) throw new Error("FaceTime calling requires exactly one configured owner in facetime.allowedRecipients");
  return recipients[0];
}

export async function updateTalkConfig(mutator: (config: TalkConfig) => void | Promise<void>, path = getTalkConfigPath()): Promise<void> {
  const key = resolve(path);
  await serialized(key, () => withRepairError(key, async () => {
    await load(key); // Create/migrate if necessary, then take the authoritative bytes for this update.
    const before = await readPrivate(key);
    if (before === undefined) throw new Error("Talk config disappeared during update; retry");
    const config = validate(parse(before, key));
    await mutator(config);
    const bytes = payload(config);
    // Do not overwrite a manual policy edit while an asynchronous writer was
    // working. This is not a cross-process lock; publication itself is atomic.
    const latest = await readPrivate(key);
    if (!latest?.equals(before)) throw new Error("Talk config changed during update; retry without overwriting newer policy");
    await publish(key, bytes, true);
  }));
}

/** Only audio is reset. An invalid canonical policy must be repaired explicitly. */
export async function resetTalkAudioProfiles(path = getTalkConfigPath()): Promise<void> {
  await updateTalkConfig((config) => { config.audio = defaults().audio; }, path);
}
