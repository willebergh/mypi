import type * as THREE from 'three';
import type { DesktopSlot } from '../shared/desktop-screens';
import type { SceneId } from '../shared/scene-config';
import type { WorldResources } from './materials';
import type { Room } from './room';
import { createWorkshopEnvironment } from './workshop-environment';
import { createDeskRoom } from './desk-room';

/** A coded room plus optional world defaults; robot/HUD/render loops live elsewhere. */
export interface Environment extends Room {
  /** Borrowed renderer-owned maps; never dispose these in the room. */
  setDesktopScreens?(textures: Partial<Record<DesktopSlot, THREE.Texture>>): void;
  /** Called once on installation, before aspect framing and any output camera override. */
  configureWorld?(scene: THREE.Scene, camera: THREE.PerspectiveCamera, target: THREE.Vector3): void;
  /** Optional non-GPU cleanup only. GPU assets belong to the supplied WorldResources. */
  dispose?(): void;
}

export function createEnvironment(resources: WorldResources, id: SceneId): Environment {
  switch (id) {
    case 'workshop': return createWorkshopEnvironment(resources);
    case 'desk': return createDeskRoom(resources);
    default: throw new Error(`Unknown scene id: ${id satisfies never}`);
  }
}
