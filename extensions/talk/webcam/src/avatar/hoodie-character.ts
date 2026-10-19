import * as THREE from 'three';
import type { Robot } from './robot';
import type { SceneConfig } from '../shared/scene-config';
import type { HudTalkPreflight } from '../shared/hud-data';
import { createAnimatedFace, surface } from './animated-face';
import { WorldResources, surfaceTexture, standard, mesh, cable } from './materials';

/** Standalone garment + recessed face, optionally installed by the world.
 * Caller owns placement and WorldResources disposal; time is seconds, audio is optional.
 */
export function createHoodieCharacter(resources: WorldResources, config: SceneConfig,
  getTalk: (time: number) => HudTalkPreflight): Robot {
  const group = new THREE.Group(); group.name = 'hoodie character / standalone';
  const body = new THREE.Group(); body.name = 'closed hoodie garment'; group.add(body);
  const head = new THREE.Group(); head.name = 'fabric hood and recessed face';
  head.position.set(0, 2.62, .04); group.add(head);
  const clothMap = surfaceTexture(resources, 'cloth'); clothMap.repeat.set(1.5, 1.5);
  const cloth = resources.material(new THREE.MeshPhysicalMaterial({
    color: config.hoodieColor, map: clothMap, bumpMap: clothMap, bumpScale: .032,
    roughness: .99, metalness: 0, sheen: .34, sheenColor: new THREE.Color('#384650'),
    sheenRoughness: .92, side: THREE.DoubleSide,
  }));
  cloth.name = 'hoodie fabric';
  const seam = standard(resources, { color: config.hoodieColor, map: clothMap, roughness: 1 });
  seam.name = 'fabric seams and drawstrings';
  // Unlit black lining cannot catch the frontal spotlight and reveal a head shape.
  const lining = resources.material(new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide }));
  lining.name = 'shadowed hood lining';
  const addCloth = (parent: THREE.Group, name: string, geometry: THREE.BufferGeometry) => {
    const object = mesh(resources, parent, geometry, cloth); object.name = name; return object;
  };

  // A continuous pullover, not the robot's split-front shell. All openings are fabric-capped.
  const torsoPoint = (u: number, v: number) => {
    const a = u * Math.PI * 2;
    const shoulder = THREE.MathUtils.smoothstep(v, .76, 1);
    const width = (1.22 + .18 * Math.sin(v * Math.PI)) * (1 - shoulder) + .71 * shoulder;
    const fold = (.025 * Math.sin(a * 13 + v * 7) + .012 * Math.sin(a * 27 - v * 9)) * Math.sin(v * Math.PI);
    return new THREE.Vector3(Math.sin(a) * (width + fold), .12 + v * 2.02,
      Math.cos(a) * (.58 + fold - shoulder * .13) - .12);
  };
  addCloth(body, 'continuous pullover', surface(80, 48, torsoPoint));
  for (const v of [0, 1]) addCloth(body, v ? 'covered collar' : 'closed fabric hem', surface(64, 8, (u, t) => {
    const p = torsoPoint(u, v); return new THREE.Vector3(p.x * (1 - t), p.y, -.12 + (p.z + .12) * (1 - t));
  }));
  for (const side of [-1, 1]) {
    const sleevePoint = (u: number, v: number) => {
      const a = u * Math.PI * 2;
      const r = (.30 + .15 * Math.sin(v * Math.PI * .8) + .018 * Math.sin(v * 29 + Math.sin(a * 3)))
        * (1 - THREE.MathUtils.smoothstep(v, .82, 1));
      return new THREE.Vector3(side * (1.56 - .48 * v * v) + Math.cos(a) * r,
        .18 + 1.55 * v + Math.cos(a) * .10 * side * (1 - THREE.MathUtils.smoothstep(v, .82, 1)),
        -.02 + Math.sin(a) * r * 1.12);
    };
    addCloth(body, `draped ${side < 0 ? 'left' : 'right'} sleeve`, surface(40, 36, sleevePoint));
    addCloth(body, 'fabric cuff closure / no hand', surface(40, 8, (u, t) => {
      const p = sleevePoint(u, 0);
      return new THREE.Vector3(side * 1.56 + (p.x - side * 1.56) * (1 - t), THREE.MathUtils.lerp(p.y, .18, t), -.02 + (p.z + .02) * (1 - t));
    }));
    cable(resources, body, Array.from({ length: 65 }, (_, i) => sleevePoint(i / 64, .07).toArray()), .012, seam, 64);
    cable(resources, body, [[side * .39, 1.90, .51], [side * .43, 1.56, .53], [side * .37, 1.25, .52]], .018, seam, 28);
  }
  // A soft front pouch and curved stitching are garment details, never hard chest hardware.
  addCloth(body, 'kangaroo pouch', surface(40, 20, (u, v) => {
    const width = .68 - .17 * v;
    return new THREE.Vector3((u * 2 - 1) * width, .43 + v * .51,
      .49 + Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * .07);
  }));
  cable(resources, body, [[-.68, .43, .50], [0, .41, .51], [.68, .43, .50]], .009, seam, 36);
  cable(resources, body, Array.from({ length: 81 }, (_, i) => torsoPoint(i / 80, .035).toArray()), .016, seam, 80);

  // Closed soft hood, with an elliptical sewn lip forward of the recessed phosphor face.
  const opening = (u: number) => {
    const a = u * Math.PI * 2;
    const fold = .018 * Math.sin(a * 7) + .012 * Math.sin(a * 13);
    return new THREE.Vector3(Math.sin(a) * (1.13 + fold), Math.cos(a) * (.82 + fold) + .02,
      .68 + .025 * Math.cos(a * 3));
  };
  const hoodPoint = (u: number, v: number) => {
    const p = opening(u), a = u * Math.PI * 2;
    const taper = Math.cos(v * Math.PI / 2);
    const billow = Math.sin(v * Math.PI) * (.23 + .025 * Math.sin(a * 11 + v * 7));
    return new THREE.Vector3(p.x * taper + Math.sin(a) * billow,
      p.y * taper + Math.cos(a) * billow + Math.sin(v * Math.PI) * .12,
      THREE.MathUtils.lerp(p.z, -.85, Math.sin(v * Math.PI / 2)));
  };
  addCloth(head, 'closed draped hood', surface(96, 40, hoodPoint));
  mesh(resources, head, surface(96, 12, (u, v) => {
    const p = opening(u), a = u * Math.PI * 2;
    return p.lerp(new THREE.Vector3(Math.sin(a) * .95, Math.cos(a) * .57, .425), v);
  }), lining).name = 'recessed fabric face surround';
  cable(resources, head, Array.from({ length: 97 }, (_, i) => opening(i / 96).toArray()), .023, cloth, 96);
  cable(resources, head, Array.from({ length: 97 }, (_, i) => hoodPoint(i / 96, .045).toArray()), .008, seam, 96);
  cable(resources, head, Array.from({ length: 25 }, (_, i) => hoodPoint(0, .03 + i / 24 * .95).toArray()), .009, seam, 32);
  const face = createAnimatedFace(resources, head, getTalk, { darkBacking: true });
  let previousCloth = '';
  return {
    group,
    update(next, time, audio) {
      face.update(next, time, audio);
      if (next.hoodieColor !== previousCloth) {
        cloth.color.set(next.hoodieColor).multiplyScalar(1.9);
        seam.color.set(next.hoodieColor).multiplyScalar(1.8);
        previousCloth = next.hoodieColor;
      }
      const breath = Math.sin(time * 1.13) * .012 * next.idleIntensity;
      body.position.y = breath * .35; body.scale.y = 1 + breath * .45;
      head.position.y = 2.62 + breath;
      head.rotation.set(-.035 + Math.sin(time * .51) * .012 * next.idleIntensity,
        .075 + Math.sin(time * .37 + .6) * .028 * next.idleIntensity,
        -.092 + Math.sin(time * .43) * .025 * next.idleIntensity);
    },
  };
}
