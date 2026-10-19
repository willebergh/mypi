import { createScene, type AvatarScene } from '../avatar/scene';
import type { OutputViewState } from '../shared/output-view';
import { acquireLiveHudFeed } from '../shared/live-feed';
import { createSpeechAudioFeed } from '../shared/speech-audio-feed';
import type { SceneState } from '../shared/scene-config';

const container = document.querySelector<HTMLElement>('#scene');
if (!container) throw new Error('Missing #scene mount point');
const audio = createSpeechAudioFeed();
const liveHud = acquireLiveHudFeed();
let avatar: AvatarScene | null = null;
let latest: SceneState | null = null;
let latestView: OutputViewState | null = null;
let alive = true;
const applyView = (state: OutputViewState) => {
  if (!alive || (latestView && state.revision < latestView.revision)) return;
  latestView = state;
  avatar?.setCameraPose(state.mode === 'hero' ? null : state.pose);
  if (avatar) container.dataset.cameraPosition = avatar.getCameraPose().position.join(',');
};
const unsubscribeView = typeof window.webcam.onOutputView === 'function' ? window.webcam.onOutputView(applyView) : () => {};
const initialView = typeof window.webcam.getOutputView === 'function' ? window.webcam.getOutputView().then(applyView) : Promise.resolve();
const unsubscribe = window.webcam.onSceneState(state => {
  if (latest && state.revision < latest.revision) return;
  const changed = !latest || state.revision > latest.revision;
  latest = state;
  if (changed) avatar?.setConfig(state.config, state.revision);
});
// Subscribe before both getters, and await saved framing before creating the
// scene: a slow view getter must not emit a first frame with default hero pose.
Promise.all([window.webcam.getSceneState(), initialView]).then(([state]) => {
  if (!alive) return;
  const initial = latest && latest.revision > state.revision ? latest : state;
  latest = initial;
  avatar = createScene(container, {
    mode: 'output', config: initial.config, getSpeechAudioFrame: audio.read, getHudSnapshot: liveHud.snapshot,
    onConfigApplied: revision => { void window.webcam.sceneApplied(revision).catch(console.error); },
    onStats: stats => { container.dataset.cameraPosition = stats.cameraPosition.join(','); },
  });
  avatar.setConfig(initial.config, initial.revision);
  if (latestView) avatar.setCameraPose(latestView.mode === 'hero' ? null : latestView.pose);
  container.dataset.cameraPosition = avatar.getCameraPose().position.join(',');
}).catch(error => { console.error('Output scene initialization failed:', error); });
window.addEventListener('pagehide', () => { alive = false; unsubscribeView(); liveHud.dispose(); audio.dispose(); unsubscribe(); avatar?.dispose(); }, { once: true });
