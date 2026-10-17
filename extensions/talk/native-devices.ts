export interface NativeAudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export interface NativeAudioDevices {
  inputs: NativeAudioDevice[];
  outputs: NativeAudioDevice[];
}

/** Omit a direction to use its system default; IDs are opaque, not names. */
export interface NativeAudioSelection {
  microphone?: string;
  speaker?: string;
}

const DEVICE_BYTES = 512;
const DEVICE_COUNT = 128;
// Include format/bidi controls and line separators, not just ASCII escapes.
const UNSAFE_ID = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_NAME = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value) <= DEVICE_BYTES && !UNSAFE_ID.test(value);
}

/** Snapshot and validate before spawning; never coerce a bad selection to default. */
export function validateNativeAudioSelection(selection: NativeAudioSelection): NativeAudioSelection {
  const result: NativeAudioSelection = {};
  for (const key of ["microphone", "speaker"] as const) {
    const value = selection[key];
    if (value === undefined) continue;
    if (!validId(value)) throw new Error(`Invalid native audio ${key} device ID`);
    result[key] = value;
  }
  return result;
}

export function parseNativeAudioDevices(message: Record<string, unknown>): NativeAudioDevices {
  function devices(value: unknown): NativeAudioDevice[] {
    if (!Array.isArray(value) || value.length > DEVICE_COUNT) throw new Error("Invalid native audio devices");
    return value.map((device: unknown) => {
      if (!device || typeof device !== "object" || Array.isArray(device)) throw new Error("Invalid native audio device");
      const { id, name, is_default } = device as Record<string, unknown>;
      if (!validId(id) || typeof name !== "string" || Buffer.byteLength(name) > DEVICE_BYTES
        || typeof is_default !== "boolean") throw new Error("Invalid native audio device");
      // Device labels are untrusted local metadata; never return terminal controls.
      return { id, name: name.replace(UNSAFE_NAME, " ").trim(), is_default };
    });
  }
  return { inputs: devices(message.inputs), outputs: devices(message.outputs) };
}
