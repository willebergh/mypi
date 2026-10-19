import { createScene } from '../../src/avatar/scene';
import { DEFAULT_SCENE_CONFIG } from '../../src/shared/scene-config';
import { createHud } from '../../src/avatar/hud';
import { mockHudSnapshot } from '../../src/shared/hud-data';
import { silentSpeechFrame, type SpeechAudioFrame } from '../../src/shared/audio';

// Explicit test fixtures only: no device, permissions, or native audio module.
let speech: SpeechAudioFrame = silentSpeechFrame();
let refreshSpeech = false;

let clockOffset = 0;
const requestFrame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = callback => requestFrame(time => callback(time + clockOffset));

Object.assign(window, {
  hudFactory: () => createHud(mockHudSnapshot),
  setCaptureSpeechFixture: (mode: 'off' | 'voice' | 'stale') => {
    refreshSpeech = mode === 'voice';
    speech = mode === 'off' ? silentSpeechFrame() : {
      state: 'active', rms: .12, peak: .35, timestamp: Date.now() - (mode === 'stale' ? 1000 : 0),
      bands: [.18, .35, .55, .82, .68, .91, .73, .49, .64, .38, .27, .14],
    };
  },
  setCaptureClockOffset: (seconds: number) => { clockOffset = seconds * 1000; },
  sceneForCapture: createScene(document.getElementById('scene')!, {
    mode: 'output', config: { ...DEFAULT_SCENE_CONFIG }, onError: console.error,
    getHudSnapshot: mockHudSnapshot,
    getSpeechAudioFrame: () => { if (refreshSpeech) speech.timestamp = Date.now(); return speech; },
  }),
});
