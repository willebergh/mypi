// Verification fixture only: reuse the project's original cube, not the editor
// or the concurrently developed avatar scene. Nothing in src/ is changed.
import * as THREE from 'three';
import { createCube } from '../../../src/avatar/cube';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
const width = window.innerWidth, height = window.innerHeight;
renderer.setSize(width, height);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101827');
const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera.position.set(0, 1, 7);
camera.lookAt(0, 0, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x303050, 2));
const light = new THREE.DirectionalLight(0xffffff, 3);
light.position.set(3, 4, 5);
scene.add(light);
const cube = createCube();
scene.add(cube);
let last = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - last < 1000 / 30 - 0.5) return;
  last = now;
  cube.rotation.set(now * 0.00031, now * 0.00057, now * 0.00013);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
