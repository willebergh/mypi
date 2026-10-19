import * as THREE from 'three';
import type { CameraPose } from '../shared/output-view';
import type { SpeechAudioFrame } from '../shared/audio';
import type { HudSnapshot } from '../shared/hud-data';
import { OFFLINE_LIVE_HUD, projectLiveHud } from '../shared/live-projection';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createWorld } from './world';
import { createHud } from './hud';
import { createClosedCaptions } from './captions';
import { createCallPresentationOverlay } from './presentation';
import { withPresentationHudMask } from './presentation-visibility';
import { createPresentationFeed, type PresentationRendererAPI } from '../shared/presentation-feed';
import { presentationRevision } from '../shared/presentation-protocol';
import { DEFAULT_SCENE_CONFIG, outputSize, type SceneConfig } from '../shared/scene-config';

export interface SceneStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  width: number;
  height: number;
  cameraPosition: [number, number, number];
}
export interface AvatarScene {
  renderer: THREE.WebGLRenderer;
  setConfig(config: SceneConfig, revision?: number): void;
  getCameraPose(): CameraPose;
  setCameraPose(pose: CameraPose | null): void;
  resize(width: number, height: number): void;
  resetCamera(): void;
  capturePNG(): string;
  dispose(): void;
}
export interface SceneOptions {
  mode?: 'editor' | 'output';
  config?: SceneConfig;
  width?: number;
  height?: number;
  getSpeechAudioFrame?: () => SpeechAudioFrame | undefined;
  getHudSnapshot?: (timeSeconds: number) => HudSnapshot;
  presentationAPI?: PresentationRendererAPI;
  /** Editor bootstrap only; does not pin future orbit/aspect changes. */
  initialCameraPose?: CameraPose;
  onCameraPose?: (pose: CameraPose) => void;
  onStats?: (stats: SceneStats) => void;
  onConfigApplied?: (revision: number) => void;
  onError?: (message: string) => void;
}

/** Exactly the same world and lighting in both contexts; only camera interaction differs. */
export function createScene(container: HTMLElement, options: SceneOptions = {}): AvatarScene {
  const editor = options.mode === 'editor';
  let config = { ...DEFAULT_SCENE_CONFIG, ...options.config };
  const getHudSnapshot = options.getHudSnapshot ?? (() => projectLiveHud(OFFLINE_LIVE_HUD));
  const world = createWorld(config, getHudSnapshot);
  const hud = createHud(getHudSnapshot);
  const captions = createClosedCaptions();
  const presentation = createCallPresentationOverlay();
  const api = options.presentationAPI ?? (typeof window !== 'undefined' ? window.webcam : undefined);
  const presentationFeed = createPresentationFeed(typeof api?.getCallPresentation === 'function'
    && typeof api.onCallPresentation === 'function' ? api : undefined);
  let confirmedPresentation = '', blockedPresentation = '';
  const presentationKey = (value: ReturnType<typeof presentationFeed.read>) => value
    ? presentationRevision(value.presentation) : '';
  // Deliver EVERY edge (especially null) immediately, not just the next animation frame.
  const unsubscribePresentation = presentationFeed.subscribe(value => {
    if (!value && confirmedPresentation) { blockedPresentation = confirmedPresentation; confirmedPresentation = ''; }
    presentation.update(presentationKey(value) === blockedPresentation ? null : value);
  });
  presentation.update(presentationFeed.read());
  function gatePresentation(snapshot: HudSnapshot) {
    const value = presentationFeed.read(), key = presentationKey(value), metadata = snapshot.presentation;
    const liveKey = metadata ? presentationRevision(metadata) : '';
    if (key && key !== blockedPresentation && snapshot.source === 'live' && key === liveKey) {
      confirmedPresentation = key;
      presentation.update(value);
    } else {
      // Projection checks absolute heartbeat freshness locally too. Once a
      // verified revision loses that gate, no delayed image event may revive it.
      // An initial/new event arriving before its HUD metadata simply waits.
      if (key && confirmedPresentation === key) { blockedPresentation = key; confirmedPresentation = ''; }
      presentation.update(null);
    }
  }
  const { scene, camera } = world;
  const landscapePosition = camera.position.clone();
  const landscapeTarget = world.target.clone();
  let landscapeFov = camera.fov;
  const heroPosition = landscapePosition.clone();
  const heroTarget = landscapeTarget.clone();
  const cameraTarget = heroTarget.clone();
  let cameraOverride: CameraPose | null = null;
  let cameraDirty = true;
  let lastPoseSent = -Infinity;
  const markCameraDirty = () => { cameraDirty = true; };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); // Fixed physical pixels: no Retina-sized duplicate output workload.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.info.autoReset = false; // Count world + HUD together, not just the final overlay pass.
  renderer.domElement.className = 'scene-canvas';
  renderer.domElement.setAttribute('aria-label', editor ? 'Interactive 3D character scene' : 'Offscreen character output');
  container.appendChild(renderer.domElement);
  const controls = editor ? new OrbitControls(camera, renderer.domElement) : null;
  if (controls) {
    controls.target.copy(heroTarget);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 1.3;
    controls.maxDistance = 12;
    controls.maxPolarAngle = Math.PI * 0.91;
    controls.update();
    controls.saveState();
    controls.addEventListener('change', markCameraDirty);
  }
  function getCameraPose(): CameraPose {
    return { position: camera.position.toArray() as [number, number, number],
      target: (controls?.target ?? cameraTarget).toArray() as [number, number, number], fov: camera.fov };
  }
  function applyCameraPose(pose: CameraPose) {
    camera.position.fromArray(pose.position);
    cameraTarget.fromArray(pose.target);
    camera.fov = pose.fov;
    camera.lookAt(cameraTarget);
    if (controls) { controls.target.copy(cameraTarget); controls.update(); }
    camera.updateProjectionMatrix();
    cameraDirty = true;
  }
  function frameAspect() {
    heroPosition.copy(landscapePosition);
    heroTarget.copy(landscapeTarget);
    if (config.aspectRatio === '9:16') {
      // Recenter on the robot and leave breathing room around the hood in a narrow frame.
      const offset = new THREE.Vector3(-.77, -.38, 0);
      heroPosition.add(offset); heroTarget.add(offset);
    }
    camera.fov = config.aspectRatio === '9:16' ? 45 : landscapeFov;
    camera.position.copy(heroPosition);
    cameraTarget.copy(heroTarget);
    camera.lookAt(heroTarget);
    if (controls) { controls.target.copy(heroTarget); controls.update(); controls.saveState(); }
    camera.updateProjectionMatrix();
    if (cameraOverride) applyCameraPose(cameraOverride);
    cameraDirty = true;
  }
  frameAspect();
  if (editor && options.initialCameraPose) applyCameraPose(options.initialCameraPose);
  let width = 1280, height = 720;
  function resize(w: number, h: number) {
    width = Math.max(1, Math.round(w)); height = Math.max(1, Math.round(h));
    renderer.setSize(width, height, false);
    hud.resize(width, height);
    captions.resize(width, height);
    presentation.resize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const initialSize = outputSize(config.aspectRatio);
  resize(editor ? options.width ?? initialSize.width : initialSize.width,
    editor ? options.height ?? initialSize.height : initialSize.height);
  let disposed = false;
  let raf = 0;
  let lastFrame: number | null = null;
  let previous = performance.now();
  const started = previous;
  let sampleStarted = previous;
  let sampleFrames = 0;
  let pendingRevision: number | null = 0;
  const framePeriod = 1000 / (editor ? 60 : 30);

  function drawFrame(snapshot?: HudSnapshot) {
    if (!snapshot) {
      gatePresentation(getHudSnapshot((performance.now() - started) / 1000));
      presentation.animate();
    }
    renderer.info.reset();
    renderer.autoClear = true;
    renderer.render(scene, camera);
    if (hud.scene.visible) {
      renderer.autoClear = false;
      renderer.clearDepth();
      const active = presentation.read();
      withPresentationHudMask(active.rect, hud.renderLayers(), () => renderer.render(hud.scene, hud.camera),
        { x: 0, y: hud.camera.bottom - active.captionSafeBottom, width: hud.camera.right, height: active.captionSafeBottom });
      renderer.autoClear = true;
    }
    // Explicit presentations are independent of the saved Off HUD/opacity settings.
    if (presentation.scene.visible) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(presentation.scene, presentation.camera);
      renderer.autoClear = true;
    }
    if (captions.scene.visible) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(captions.scene, captions.camera);
      renderer.autoClear = true;
    }
  }

  function render(now: number) {
    if (disposed) return;
    raf = requestAnimationFrame(render);
    if (lastFrame !== null && now - lastFrame < framePeriod - 0.4) return;
    // Keep phase instead of resetting to now: a 144Hz display should not quantize a 60Hz preview to 48Hz.
    lastFrame = lastFrame === null || now - lastFrame > framePeriod * 4 ? now : lastFrame + framePeriod;
    const delta = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    try {
      world.update(config, (now - started) / 1000, delta, options.getSpeechAudioFrame?.());
      hud.update(config, (now - started) / 1000, delta);
      const speech = getHudSnapshot((now - started) / 1000);
      gatePresentation(speech);
      presentation.animate();
      const presenting = presentation.read();
      captions.update(speech.source === 'live' ? speech.captions ?? [] : [],
        presenting.active ? presenting.captionSafeBottom : hud.bottomClearance());
      controls?.update();
      if (editor && cameraDirty && now - lastPoseSent >= 50 && options.onCameraPose) {
        cameraDirty = false;
        lastPoseSent = now;
        options.onCameraPose(getCameraPose());
      }
      drawFrame(speech);
      if (pendingRevision !== null) {
        options.onConfigApplied?.(pendingRevision);
        pendingRevision = null;
      }
      sampleFrames++;
      if (now - sampleStarted >= 1000) {
        options.onStats?.({ fps: sampleFrames * 1000 / (now - sampleStarted),
          drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, width, height,
          cameraPosition: camera.position.toArray() as [number, number, number] });
        sampleStarted = now; sampleFrames = 0;
      }
    } catch (error) {
      cancelAnimationFrame(raf);
      options.onError?.(String(error));
      console.error('[scene]', error);
    }
  }
  raf = requestAnimationFrame(render);
  const contextLost = (event: Event) => {
    event.preventDefault();
    options.onError?.('WebGL context lost. Restart this renderer to recover.');
  };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);

  return {
    renderer,
    setConfig(next, revision) {
      const normalized = { ...DEFAULT_SCENE_CONFIG, ...next };
      const changedAspect = normalized.aspectRatio !== config.aspectRatio;
      const changedScene = normalized.sceneId !== config.sceneId;
      const changedCharacter = normalized.characterId !== config.characterId;
      config = normalized;
      if (changedCharacter) world.setCharacter(config);
      if (changedScene) {
        world.setScene(config.sceneId);
        landscapePosition.copy(camera.position);
        landscapeTarget.copy(world.target);
        landscapeFov = camera.fov;
      }
      if (changedAspect || changedScene) frameAspect();
      if (changedAspect && !editor) { const size = outputSize(config.aspectRatio); resize(size.width, size.height); }
      if (revision !== undefined) pendingRevision = revision;
    },
    getCameraPose,
    setCameraPose(pose) {
      cameraOverride = pose ? { position: [...pose.position], target: [...pose.target], fov: pose.fov } : null;
      if (cameraOverride) applyCameraPose(cameraOverride);
      else frameAspect();
    },
    resize,
    resetCamera() {
      camera.position.copy(heroPosition);
      cameraTarget.copy(heroTarget);
      camera.lookAt(heroTarget);
      if (controls) controls.reset();
      cameraDirty = true;
    },
    capturePNG() {
      // Explicit capture re-renders once; no preserveDrawingBuffer or continuous pixel copies.
      drawFrame();
      return renderer.domElement.toDataURL('image/png');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      controls?.removeEventListener('change', markCameraDirty);
      controls?.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      world.dispose();
      hud.dispose();
      captions.dispose();
      unsubscribePresentation();
      presentationFeed.dispose();
      presentation.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
