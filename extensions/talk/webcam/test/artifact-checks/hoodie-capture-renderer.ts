import * as THREE from 'three';
import { createHoodieCharacter } from '../../src/avatar/hoodie-character';
import { WorldResources } from '../../src/avatar/materials';
import { DEFAULT_SCENE_CONFIG } from '../../src/shared/scene-config';
import type { HudTalkPreflight } from '../../src/shared/hud-data';

// Asset-only fixture: deliberately does not import world, scene, feeds, preload or devices.
const resources = new WorldResources();
const scene = new THREE.Scene(); scene.background = new THREE.Color('#272d34');
const camera = new THREE.PerspectiveCamera(36, 1000 / 900, .1, 30);
camera.position.set(0, 2.2, 7.5); camera.lookAt(0, 1.85, 0);
scene.add(new THREE.HemisphereLight('#d3e4ff', '#30302b', 2));
const key = new THREE.DirectionalLight('#ffdfb5', 3); key.position.set(-3, 5, 5); scene.add(key);
const fill = new THREE.DirectionalLight('#a6ceff', 2); fill.position.set(3, 4, -2); scene.add(fill);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1000, 900); renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.style.margin = '0'; document.body.appendChild(renderer.domElement);
let talk: HudTalkPreflight = { source: 'mock', status: 'preparing', active: true, generation: 'fixture',
  steps: [{ id: 'voice', label: 'Preparing voice' }], currentStep: 0,
  readyToAnswer: false, audioEnabled: false, answerSubmitted: false };
const character = createHoodieCharacter(resources, DEFAULT_SCENE_CONFIG, () => talk);
scene.add(character.group);
const capture = {
  render(state: 'boot' | 'ready' | 'blink' | 'mouth', yaw = 0) {
    // Rewind then advance the same deterministic animation as a real consumer.
    talk = { ...talk, readyToAnswer: false }; character.update(DEFAULT_SCENE_CONFIG, 0);
    if (state !== 'boot') {
      talk = { ...talk, readyToAnswer: true }; character.update(DEFAULT_SCENE_CONFIG, 1);
      character.update(DEFAULT_SCENE_CONFIG, state === 'blink' ? 6.385 : 2,
        state === 'mouth' ? { state: 'active', timestamp: Date.now(), rms: .2, peak: .4,
          bands: [.1, .3, .65, .9, .45, .7, 1, .5, .25, .7, .4, .15] } : undefined);
    }
    character.group.rotation.y = yaw;
    renderer.render(scene, camera);
    return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  },
  dispose() { resources.dispose(); renderer.dispose(); renderer.forceContextLoss(); },
};
Object.assign(window, { hoodieCapture: capture });
capture.render('boot');
