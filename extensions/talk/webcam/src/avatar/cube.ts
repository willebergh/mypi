import * as THREE from 'three';

/** Create the softly bevelled-looking (but still crisp) hero cube. */
export function createCube(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(2.15, 2.15, 2.15, 1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0x8b9cff,
    metalness: 0.28,
    roughness: 0.3,
    flatShading: true,
  });
  const cube = new THREE.Mesh(geometry, material);
  cube.castShadow = true;
  cube.receiveShadow = true;
  return cube;
}
