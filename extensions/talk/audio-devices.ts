import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTalkConfig, updateTalkConfig, validateTalkDeviceSettings, type AudioProfile, type TalkAudioProfiles, type TalkDeviceSettings } from "./config.ts";

export type { AudioProfile, TalkAudioProfiles, TalkDeviceSettings } from "./config.ts";
export { resetTalkAudioProfiles } from "./config.ts";

type Device = { id: string; name: string; is_default: boolean };
type Devices = { inputs: Device[]; outputs: Device[] };

export function requireVirtualAudio(settings: TalkDeviceSettings): void {
  const normalized = validateTalkDeviceSettings(settings);
  if (!normalized.microphone || !normalized.speaker) {
    throw new Error("Virtual audio for FaceTime requires an explicit microphone and output; system defaults are not supported.");
  }
}

export async function loadTalkAudioProfiles(path?: string): Promise<TalkAudioProfiles> {
  return (await loadTalkConfig(path)).audio;
}

export async function loadTalkDeviceSettings(path?: string): Promise<TalkDeviceSettings> {
  return (await loadTalkAudioProfiles(path)).physical;
}

export async function saveTalkDeviceSettings(settings: TalkDeviceSettings, path?: string): Promise<void> {
  await saveTalkAudioProfile("physical", settings, path);
}

export async function saveTalkAudioProfile(profile: AudioProfile, settings: TalkDeviceSettings, path?: string): Promise<void> {
  if (profile !== "physical" && profile !== "virtual") throw new Error(`Unknown talk audio profile: ${String(profile)}`);
  const normalized = validateTalkDeviceSettings(settings);
  await updateTalkConfig((config) => { config.audio[profile] = normalized; }, path);
}

function pickerOptions(devices: Device[], current: TalkDeviceSettings["microphone"]): string[] {
  return ["System default", ...devices.map((device, index) => {
    const name = `${index + 1}. ${device.name}`;
    const markers = [device.is_default ? "default" : "", current?.id === device.id ? "current" : ""].filter(Boolean);
    return `${name}${markers.length ? ` [${markers.join(", ")}]` : ""}`;
  })];
}

async function pick(ctx: Pick<ExtensionContext, "hasUI" | "ui">, title: string, devices: Device[], current: { id: string; name: string } | undefined, signal?: AbortSignal): Promise<Device | null | undefined> {
  const unavailable = current && !devices.some((device) => device.id === current.id) ? ` — saved device unavailable: ${current.name}` : "";
  const options = pickerOptions(devices, current);
  const selected = await ctx.ui.select(`${title}${unavailable}`, options, { signal });
  if (selected === undefined || signal?.aborted) return undefined;
  if (selected === "System default") return null;
  const index = options.indexOf(selected) - 1;
  return index >= 0 ? devices[index] : undefined;
}

export async function chooseTalkDevices(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  current: TalkDeviceSettings,
  devices: Devices,
  signal?: AbortSignal,
): Promise<TalkDeviceSettings | undefined> {
  if (!ctx.hasUI || signal?.aborted) return undefined;
  const microphone = await pick(ctx, "Select microphone", devices.inputs, current.microphone, signal);
  if (microphone === undefined) return undefined;
  const speaker = await pick(ctx, "Select output", devices.outputs, current.speaker, signal);
  if (speaker === undefined) return undefined;
  return {
    ...(microphone ? { microphone: { id: microphone.id, name: microphone.name } } : {}),
    ...(speaker ? { speaker: { id: speaker.id, name: speaker.name } } : {}),
  };
}
