import * as THREE from 'three';
import type { SpeechAudioFrame } from '../shared/audio';
import type { CharacterId, SceneConfig, SceneId } from '../shared/scene-config';
import type { HudSnapshot } from '../shared/hud-data';
import { OFFLINE_LIVE_HUD, projectLiveHud } from '../shared/live-projection';
import { WorldResources } from './materials';
import { createRobot, type Robot } from './robot';
import { createHoodieCharacter } from './hoodie-character';
import { createEnvironment, type Environment } from './environment';
import { createDesktopTextures } from './desktop-screens';
import type { DesktopSlot } from '../shared/desktop-screens';

export interface AvatarWorld {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  /** Swaps only environment assets; resets world camera defaults for aspect framing. */
  setScene(id: SceneId): void;
  /** Swaps only foreground assets; room, camera and overlays remain intact. */
  setCharacter(config: SceneConfig): void;
  /** Absolute time and delta are seconds. No rendering or scheduling occurs here. */
  update(config: SceneConfig, time: number, delta: number, audio?: SpeechAudioFrame): void;
  dispose(): void;
}

/** One deterministic asset set per renderer context, shared by preview and output wrappers. */
export function createWorld(config: SceneConfig, getSnapshot: (time: number) => HudSnapshot = () => projectLiveHud(OFFLINE_LIVE_HUD)): AvatarWorld {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(37.5, 16 / 9, .08, 45);
  const target = new THREE.Vector3();
  let character: Robot | undefined;
  let characterResources: WorldResources | undefined;
  let characterId: CharacterId | undefined;
  let environment: Environment | undefined;
  let environmentResources: WorldResources | undefined;
  let sceneId: SceneId | undefined;
  let disposed = false;
  let desktopTextures: Partial<Record<DesktopSlot, THREE.Texture>> = {};
  const desktop = createDesktopTextures(textures => { desktopTextures = textures; environment?.setDesktopScreens?.(textures); });

  function setCharacter(next: SceneConfig) {
    const id = next.characterId ?? 'robot';
    if (disposed || id === characterId) return;
    const resources = new WorldResources();
    let replacement: Robot;
    try {
      replacement = id === 'hoodie'
        ? createHoodieCharacter(resources, next, time => getSnapshot(time).talk)
        : createRobot(resources, next, time => getSnapshot(time).talk);
      // The standalone garment is origin-based; preserve the original hero placement.
      if (id === 'hoodie') replacement.group.position.set(-.62, 0, .62);
    } catch (error) { resources.dispose(); throw error; }
    if (character) scene.remove(character.group);
    characterResources?.dispose();
    character = replacement;
    characterResources = resources;
    characterId = id;
    scene.add(replacement.group);
  }

  function setScene(id: SceneId) {
    if (disposed || id === sceneId) return;
    desktop.setScene(id);
    const nextResources = new WorldResources();
    let next: Environment;
    try { next = createEnvironment(nextResources, id); }
    catch (error) { nextResources.dispose(); throw error; }
    if (environment) {
      scene.remove(environment.group);
      environment.dispose?.();
      environmentResources?.dispose();
    }
    environment = next;
    environmentResources = nextResources;
    sceneId = id;
    next.setDesktopScreens?.(desktopTextures);
    scene.add(next.group);
    // Reset inherited atmosphere/camera so one environment never leaks defaults to another.
    scene.name = id;
    scene.background = new THREE.Color('#10191c');
    scene.fog = null;
    camera.fov = 37.5;
    camera.position.set(.15, 3.1, 7.85);
    target.set(.15, 2.63, .1);
    next.configureWorld?.(scene, camera, target);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }
  const update = (next: SceneConfig, time: number, _delta: number, audio?: SpeechAudioFrame): void => {
    if (disposed) return;
    setCharacter(next);
    setScene(next.sceneId);
    const t = Number.isFinite(time) ? time : 0;
    character?.update(next, t, audio);
    environment?.update(next, t);
  };
  try { update(config, 0, 0); }
  catch (error) { desktop.dispose(); environment?.dispose?.(); environmentResources?.dispose(); characterResources?.dispose(); throw error; }

  return {
    scene, camera, target, setScene, setCharacter, update,
    dispose() {
      if (disposed) return;
      disposed = true;
      desktop.dispose();
      environment?.dispose?.();
      environmentResources?.dispose();
      characterResources?.dispose();
      scene.clear();
    },
  };
}
