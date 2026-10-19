/** Agent speech only: Internal output is cross-routed to this virtual input.
 * Never substitute a default/physical input or Pi Talk Internal input (caller audio).
 */
export const SPEECH_DEVICE_UID = 'io.github.willebergh.pitalk.audio.visible';
export const SPEECH_DEVICE_NAME = 'Pi Talk';
export const SPEECH_BAND_COUNT = 12;
export interface SpeechAudioFrame {
  state: 'off' | 'starting' | 'retrying' | 'active' | 'unavailable' | 'error';
  rms: number;
  peak: number;
  bands: number[];
  /** Unix milliseconds; stale frames must not keep the mouth speaking. */
  timestamp: number;
}
export interface SpeechAudioStatus extends SpeechAudioFrame {
  deviceName: string;
  deviceUid: string;
  backendAvailable: boolean;
  devicePresent: boolean;
  permission: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  error: string | null;
}
export function silentSpeechFrame(state: SpeechAudioFrame['state'] = 'off'): SpeechAudioFrame {
  return { state, rms: 0, peak: 0, bands: Array(SPEECH_BAND_COUNT).fill(0), timestamp: 0 };
}
