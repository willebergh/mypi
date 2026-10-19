import { silentSpeechFrame, type SpeechAudioFrame, type SpeechAudioStatus } from './audio';

/** Shared renderer-side read-only feed. Never requests permission or starts audio. */
export function createSpeechAudioFeed() {
  let latest: SpeechAudioFrame = silentSpeechFrame();
  let live = true;
  let version = 0;
  let unsubscribe = () => {};
  const api = window.webcam;
  const accept = (state: SpeechAudioStatus) => { if (live) { latest = state; version++; } };
  if (typeof api?.onSpeechAudio === 'function' && typeof api.getSpeechAudioStatus === 'function') {
    unsubscribe = api.onSpeechAudio(accept);
    const initialVersion = version;
    void api.getSpeechAudioStatus().then(state => {
      if (live && version === initialVersion) accept(state);
    }).catch(() => { /* Old backend: silent until the next explicit app restart. */ });
  }
  return {
    read: () => latest,
    dispose() { live = false; unsubscribe(); latest = silentSpeechFrame(); },
  };
}
