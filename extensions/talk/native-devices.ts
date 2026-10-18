import { VIRTUAL_AUDIO_INTERNAL_UID, VIRTUAL_AUDIO_VISIBLE_UID } from "./virtual-audio.ts";

export interface NativeAudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export interface NativeAudioDevices {
  inputs: NativeAudioDevice[];
  outputs: NativeAudioDevice[];
}

export interface NativeVirtualAudioRoute {
  visibleUid: string;
  internalUid: string;
}

/** Omit a physical direction to use its system default. Virtual audio is a distinct fail-closed route. */
export interface NativeAudioSelection {
  microphone?: string;
  speaker?: string;
  virtual?: NativeVirtualAudioRoute;
}

export interface NativeCoreAudioEndpointDiagnostic {
  uid: string;
  resolved: boolean;
  audio_device_id?: number;
  name?: string;
  nominal_sample_rate?: number;
  input_channels?: number;
  output_channels?: number;
}

export interface NativeVirtualAudioDiagnostics {
  visible: NativeCoreAudioEndpointDiagnostic;
  internal: NativeCoreAudioEndpointDiagnostic;
  simultaneous_streams: boolean;
  issues: string[];
}

const DEVICE_BYTES = 512;
const DEVICE_COUNT = 128;
const DIAGNOSTIC_ISSUES = 16;
const UNSAFE_ID = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_NAME = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value) <= DEVICE_BYTES && !UNSAFE_ID.test(value);
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value) > DEVICE_BYTES) return undefined;
  return value.replace(UNSAFE_NAME, " ").trim();
}

export function validateNativeVirtualAudioRoute(value: unknown): NativeVirtualAudioRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native virtual audio route");
  const route = value as Record<string, unknown>;
  if (Object.keys(route).some((key) => key !== "visibleUid" && key !== "internalUid")
    || route.visibleUid !== VIRTUAL_AUDIO_VISIBLE_UID || route.internalUid !== VIRTUAL_AUDIO_INTERNAL_UID
    || !validId(route.visibleUid) || !validId(route.internalUid)) {
    throw new Error("Invalid native virtual audio UIDs");
  }
  return { visibleUid: route.visibleUid, internalUid: route.internalUid };
}

/** Snapshot and validate before spawning; never coerce a bad selection to default. */
export function validateNativeAudioSelection(selection: NativeAudioSelection): NativeAudioSelection {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Invalid native audio selection");
  const result: NativeAudioSelection = {};
  for (const key of ["microphone", "speaker"] as const) {
    const value = selection[key];
    if (value === undefined) continue;
    if (!validId(value)) throw new Error(`Invalid native audio ${key} device ID`);
    result[key] = value;
  }
  if (selection.virtual !== undefined) {
    if (result.microphone !== undefined || result.speaker !== undefined) throw new Error("Virtual audio cannot be mixed with physical device IDs");
    result.virtual = validateNativeVirtualAudioRoute(selection.virtual);
  }
  return result;
}

export function parseNativeAudioDevices(message: Record<string, unknown>): NativeAudioDevices {
  function devices(value: unknown): NativeAudioDevice[] {
    if (!Array.isArray(value) || value.length > DEVICE_COUNT) throw new Error("Invalid native audio devices");
    return value.map((device: unknown) => {
      if (!device || typeof device !== "object" || Array.isArray(device)) throw new Error("Invalid native audio device");
      const { id, name, is_default } = device as Record<string, unknown>;
      const cleanName = safeName(name);
      if (!validId(id) || cleanName === undefined || typeof is_default !== "boolean") throw new Error("Invalid native audio device");
      return { id, name: cleanName, is_default };
    });
  }
  return { inputs: devices(message.inputs), outputs: devices(message.outputs) };
}

export function parseNativeVirtualAudioDiagnostics(message: Record<string, unknown>): NativeVirtualAudioDiagnostics {
  function endpoint(value: unknown): NativeCoreAudioEndpointDiagnostic {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid virtual audio diagnostic endpoint");
    const item = value as Record<string, unknown>;
    const allowed = ["uid", "resolved", "audio_device_id", "name", "nominal_sample_rate", "input_channels", "output_channels"];
    if (Object.keys(item).some((key) => !allowed.includes(key)) || !validId(item.uid) || typeof item.resolved !== "boolean") {
      throw new Error("Invalid virtual audio diagnostic endpoint");
    }
    const result: NativeCoreAudioEndpointDiagnostic = { uid: item.uid, resolved: item.resolved };
    for (const key of ["audio_device_id", "input_channels", "output_channels"] as const) {
      const number = item[key];
      if (number !== undefined) {
        if (!Number.isSafeInteger(number) || (number as number) < 0) throw new Error("Invalid virtual audio diagnostic number");
        result[key] = number as number;
      }
    }
    if (item.nominal_sample_rate !== undefined) {
      if (typeof item.nominal_sample_rate !== "number" || !Number.isFinite(item.nominal_sample_rate) || item.nominal_sample_rate <= 0) throw new Error("Invalid virtual audio sample rate");
      result.nominal_sample_rate = item.nominal_sample_rate;
    }
    if (item.name !== undefined) {
      const name = safeName(item.name);
      if (name === undefined) throw new Error("Invalid virtual audio diagnostic name");
      result.name = name;
    }
    return result;
  }
  if (!Array.isArray(message.issues) || message.issues.length > DIAGNOSTIC_ISSUES
    || message.issues.some((issue) => !validId(issue)) || typeof message.simultaneous_streams !== "boolean") {
    throw new Error("Invalid virtual audio diagnostics");
  }
  return {
    visible: endpoint(message.visible),
    internal: endpoint(message.internal),
    simultaneous_streams: message.simultaneous_streams,
    issues: [...message.issues] as string[],
  };
}
