import * as THREE from 'three';
import type { WorldResources } from './materials';
import type { Environment } from './environment';
import { createRoom } from './room';

/** Original workshop geometry, lighting and camera defaults, unchanged. */
export function createWorkshopEnvironment(resources: WorldResources): Environment {
  const room = createRoom(resources);
  // Screens supply the room spill; the camera-side spotlight keeps the robot lit.
  // All four lights are unshadowed, with no ambient or directional room wash.
  const cool = new THREE.PointLight('#d8bf89', 24, 6, 2);
  cool.position.set(3.00, 2.02, -2.38); room.group.add(cool);
  const rightScreen = new THREE.PointLight('#9ac2e8', 11, 5, 2);
  rightScreen.position.set(4.30, 2.02, -2.25); room.group.add(rightScreen);
  const leftScreen = new THREE.PointLight('#93cfb0', 4, 3.5, 2);
  leftScreen.position.set(1.70, 2.02, -2.25); room.group.add(leftScreen);
  // Broad, feathered screen-motivated light behind the default camera. A limited
  // cone lifts the hood/housing without a global directional wash or extra shadows.
  // The robot's custom CRT shader intentionally remains self-lit.
  const fill = new THREE.SpotLight('#d1e6f2', 120, 16, .36, 1, 2);
  fill.position.set(.6, 3.8, 8.8);
  fill.target.position.set(-.6, 2.65, .6); room.group.add(fill, fill.target);

  return {
    group: room.group,
    configureWorld(scene, camera, target) {
      scene.name = 'Night shift / procedural CRT workshop';
      scene.background = new THREE.Color('#10191c');
      scene.fog = new THREE.FogExp2('#152126', .047);
      camera.fov = 37.5;
      camera.position.set(.15, 3.1, 7.85);
      target.set(.15, 2.63, .1);
      camera.lookAt(target);
    },
    update(next, time) {
      room.update(next, time);
      const warm = next.warmCoolBalance;
      const roomLevel = next.roomIntensity;
      fill.intensity = (150 - warm * 35) * (.8 + roomLevel * .2);
      const screenLevel = roomLevel * (1.17 - warm * .34);
      cool.intensity = 24 * screenLevel;
      rightScreen.intensity = 11 * screenLevel;
      leftScreen.intensity = 4 * screenLevel;
    },
  };
}
