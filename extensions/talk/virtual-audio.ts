/** Stable Core Audio UIDs, not process-local device IDs or user selections. */
export const VIRTUAL_AUDIO_VISIBLE_UID = "io.github.willebergh.pitalk.audio.visible";
export const VIRTUAL_AUDIO_INTERNAL_UID = "io.github.willebergh.pitalk.audio.internal";
export const VIRTUAL_AUDIO_VISIBLE_NAME = "Pi Talk";
export const VIRTUAL_AUDIO_INTERNAL_NAME = "Pi Talk Internal";

export const MANAGED_VIRTUAL_AUDIO = Object.freeze({
  visibleUid: VIRTUAL_AUDIO_VISIBLE_UID,
  internalUid: VIRTUAL_AUDIO_INTERNAL_UID,
});
export type ManagedVirtualAudio = typeof MANAGED_VIRTUAL_AUDIO;

/** Names are fixed presentation metadata and must never be persisted here. */
export function validateManagedVirtualAudio(value: unknown): ManagedVirtualAudio {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "visibleUid") || !Object.hasOwn(value, "internalUid")
    || (value as Record<string, unknown>).visibleUid !== VIRTUAL_AUDIO_VISIBLE_UID
    || (value as Record<string, unknown>).internalUid !== VIRTUAL_AUDIO_INTERNAL_UID) {
    throw new Error("Virtual audio must contain exactly the managed Pi Talk visibleUid and internalUid; arbitrary devices and system defaults are not supported");
  }
  return { ...MANAGED_VIRTUAL_AUDIO };
}
