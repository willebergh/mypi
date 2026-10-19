import * as THREE from 'three';
import type { SceneConfig } from '../shared/scene-config';
import type { HudTalkPreflight } from '../shared/hud-data';
import { createAnimatedFace, surface } from './animated-face';
import { WorldResources, surfaceTexture, standard, mesh, box, rod, cable, batchStatic } from './materials';

import type { SpeechAudioFrame } from '../shared/audio';

export interface Robot {
  group: THREE.Group;
  update(config: SceneConfig, time: number, audio?: SpeechAudioFrame): void;
}

function roundedPath<T extends THREE.Path>(path: T, w: number, h: number, r: number): T {
  const x = -w / 2, y = -h / 2;
  path.moveTo(x + r, y); path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r); path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h); path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r); path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y); path.closePath(); return path;
}

export function createRobot(resources: WorldResources, config: SceneConfig, getTalk: (time: number) => HudTalkPreflight): Robot {
  const group = new THREE.Group(); group.name = 'hooded CRT / hero'; group.position.set(-.62, 0, .62);
  const body = new THREE.Group(); group.add(body);
  const head = new THREE.Group(); head.position.set(0, 2.62, .04); group.add(head);

  const clothMap = surfaceTexture(resources, 'cloth'); clothMap.repeat.set(1.5, 1.5);
  const cloth = resources.material(new THREE.MeshPhysicalMaterial({
    color: config.hoodieColor, map: clothMap, bumpMap: clothMap, bumpScale: .042,
    roughness: .99, metalness: 0, sheen: .34, sheenColor: new THREE.Color('#384650'),
    sheenRoughness: .92, side: THREE.DoubleSide,
  }));
  const seam = standard(resources, { color: '#252a2c', map: clothMap, roughness: 1 });
  const lining = standard(resources, { color: '#080b0c', roughness: 1, side: THREE.DoubleSide });
  const enamelMap = surfaceTexture(resources, 'metal');
  const wearUniform = { value: config.casingWear };
  const enamel = standard(resources, {
    color: config.casingTint, map: enamelMap, bumpMap: enamelMap, bumpScale: .024,
    metalness: .34, roughness: .61,
  });
  enamel.onBeforeCompile = shader => {
    shader.uniforms.enamelWear = wearUniform;
    shader.fragmentShader = `uniform float enamelWear;\n${shader.fragmentShader}`.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D(map, vMapUv);
        diffuseColor *= mix(vec4(1.0), sampledDiffuseColor, enamelWear);
      #endif
    `);
  };
  enamel.customProgramCacheKey = () => 'worn-enamel-v1';
  const chassis = standard(resources, { color: '#292e2d', metalness: .72, roughness: .52, map: enamelMap });
  const steel = standard(resources, { color: '#73766e', metalness: .8, roughness: .4, map: enamelMap });
  const rubber = standard(resources, { color: '#080d0e', roughness: .82 });
  const brass = standard(resources, { color: '#786344', metalness: .78, roughness: .49 });

  // Garment is an open draped shell, with an actual split at the chest.
  const torsoGeometry = surface(84, 48, (u, v) => {
    const y = .06 + v * 1.87;
    const theta = .39 + u * (Math.PI * 2 - .78);
    const width = v < .58 ? 1.36 + Math.sin(v / .58 * Math.PI * .5) * .2 : 1.56 - Math.pow((v - .58) / .42, 1.3) * .88;
    const fold = .034 * Math.sin(theta * 13 + v * 7) * Math.sin(v * Math.PI)
      + .014 * Math.sin(theta * 27 - v * 7) + .013 * Math.sin(v * 28 + theta * 5);
    return new THREE.Vector3(Math.sin(theta) * (width + fold), y + .028 * Math.sin(theta * 8) * Math.sin(v * Math.PI),
      Math.cos(theta) * (.59 + fold) - .16);
  });
  mesh(resources, body, torsoGeometry, cloth);
  // Heavy asymmetric sleeve folds, not ellipsoidal toy arms.
  for (const side of [-1, 1]) {
    mesh(resources, body, surface(42, 36, (u, v) => {
      const a = u * Math.PI * 2;
      const y = .03 + v * 1.47;
      const cx = side * (1.49 - .42 * v * v);
      const r = .36 + .13 * Math.sin(v * Math.PI) + .022 * Math.sin(v * 27 + Math.sin(a * 3) * 1.9) + .011 * Math.sin(v * 47 - a * 5);
      return new THREE.Vector3(cx + Math.cos(a) * r, y + Math.cos(a) * .12 * side,
        .01 + .16 * (1 - v) + Math.sin(a) * r * 1.12);
    }), cloth);
    cable(resources, body, [[side * .47, 1.81, .47], [side * .63, 1.40, .53], [side * .56, .93, .55], [side * .48, .43, .51]], .021, seam, 35);
    rod(resources, body, [side * .48, .43, .51], [side * .48, .31, .51], .026, chassis);
  }

  // A compact exposed breast plate and serviceable neck beneath the monitor.
  box(resources, body, [.93, 1.02, .63], [0, .91, .22], enamel, .16);
  box(resources, body, [.65, .48, .08], [0, 1.14, .568], chassis, .055);
  box(resources, body, [.47, .31, .035], [0, 1.16, .62], rubber, .028);
  for (const x of [-.33, .33]) for (const y of [.75, 1.38]) {
    const bolt = mesh(resources, body, new THREE.CylinderGeometry(.037, .037, .025, 8), steel, [x, y, .557]); bolt.rotation.x = Math.PI / 2;
    box(resources, body, [.031, .005, .005], [x, y, .573], chassis);
  }
  rod(resources, body, [0, 1.42, .03], [0, 2.04, .03], .16, chassis, 16);
  for (let i = 0; i < 8; i++) {
    mesh(resources, body, new THREE.TorusGeometry(.17, .028, 6, 20), rubber, [0, 1.53 + i * .057, .03]).rotation.x = Math.PI / 2;
  }
  for (const x of [-.32, .32]) {
    rod(resources, body, [x, 1.35, .20], [x * .78, 2.03, .11], .043, steel);
    rod(resources, body, [x, 1.35, .20], [x * .89, 1.65, .16], .062, chassis);
    box(resources, body, [.20, .13, .34], [x * .78, 1.96, .04], brass, .025);
  }
  cable(resources, body, [[-.24, 1.89, -.08], [-.39, 1.73, .21], [-.34, 1.48, .36], [-.2, 1.38, .36]], .035, rubber);
  cable(resources, body, [[.24, 1.91, .03], [.42, 1.74, .08], [.43, 1.41, .25]], .024, brass);

  const headHardware = new THREE.Group(); head.add(headHardware);
  box(resources, headHardware, [2.16, 1.48, .82], [0, 0, -.07], enamel, .23);
  box(resources, headHardware, [1.96, 1.32, .53], [0, .01, -.43], chassis, .21);
  // Real inset glass and raised curved bezel; the front is not a cube with a face decal.
  const bezelShape = roundedPath(new THREE.Shape(), 2.27, 1.59, .24);
  bezelShape.holes.push(roundedPath(new THREE.Path(), 1.965, 1.215, .17));
  const bezel = new THREE.ExtrudeGeometry(bezelShape, { depth: .115, bevelEnabled: true, bevelSegments: 3,
    steps: 1, bevelSize: .051, bevelThickness: .055, curveSegments: 14 });
  const bezelPosition = bezel.getAttribute('position'), bezelUV = bezel.getAttribute('uv');
  for (let i = 0; i < bezelPosition.count; i++) bezelUV.setXY(i, bezelPosition.getX(i) / 2.35 + .5, bezelPosition.getY(i) / 1.67 + .5);
  mesh(resources, headHardware, bezel, enamel, [0, 0, .345]);
  const gasketShape = roundedPath(new THREE.Shape(), 2.005, 1.26, .18);
  gasketShape.holes.push(roundedPath(new THREE.Path(), 1.917, 1.16, .16));
  mesh(resources, headHardware, new THREE.ShapeGeometry(gasketShape, 14), rubber, [0, 0, .447]);

  const face = createAnimatedFace(resources, head, getTalk);

  for (const x of [-.985, .985]) for (const y of [-.62, .62]) {
    const screw = mesh(resources, headHardware, new THREE.CylinderGeometry(.022, .022, .012, 8), chassis, [x, y, .496]);
    screw.rotation.x = Math.PI / 2;
    box(resources, headHardware, [.023, .004, .004], [x, y, .505], steel);
  }
  // Small lower service slot and a single subdued status lamp.
  box(resources, headHardware, [.20, .017, .008], [.69, -.686, .504], chassis, .003);
  const status = standard(resources, { color: '#7e7041', emissive: '#b18d43', emissiveIntensity: .35, roughness: .6 });
  mesh(resources, headHardware, new THREE.SphereGeometry(.012, 8, 6), status, [.84, -.68, .501], false);
  for (let i = 0; i < 10; i++) box(resources, headHardware, [.008, .28, .025], [1.078, -.23 + i * .047, -.12], rubber, .003).rotation.x = Math.PI / 2;

  // Hood opening follows an irregular sewn arch. A deep sheet runs back over the skull,
  // with longitudinal folds, a soft peak and hanging tails down onto the shoulders.
  const opening = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-.89, -1.51, .35), new THREE.Vector3(-1.27, -.88, .57),
    new THREE.Vector3(-1.34, -.18, .63), new THREE.Vector3(-1.21, .51, .62),
    new THREE.Vector3(-.77, .87, .60), new THREE.Vector3(-.19, .97, .60),
    new THREE.Vector3(.29, .94, .60), new THREE.Vector3(.86, .78, .61),
    new THREE.Vector3(1.26, .30, .64), new THREE.Vector3(1.32, -.40, .61),
    new THREE.Vector3(1.16, -1.04, .49), new THREE.Vector3(.87, -1.53, .25),
  ]);
  const hoodPoint = (u: number, v: number): THREE.Vector3 => {
    const edge = opening.getPoint(u);
    const crown = Math.sin(u * Math.PI);
    const fold = Math.sin(u * 59 + v * 8) * .027 + Math.sin(u * 27 - v * 5) * .042;
    const billow = Math.sin(v * Math.PI) * (.22 + fold);
    return new THREE.Vector3(edge.x * (1 - .28 * v) + Math.sign(edge.x) * billow + fold * Math.sin(v * Math.PI),
      edge.y + Math.sin(v * Math.PI) * (.12 + crown * .43) - v * .12 + (fold * .65 + .065 * Math.sin(u * 24 + v * 9) * crown) * Math.sin(v * Math.PI),
      edge.z - v * 1.51 + Math.sin(u * 45 + v * 7) * .023 * Math.sin(v * Math.PI));
  };
  mesh(resources, head, surface(100, 35, hoodPoint), cloth);
  const innerHood = surface(70, 18, (u, v) => hoodPoint(u, v).add(new THREE.Vector3(0, -.018, -.018)));
  mesh(resources, head, innerHood, lining);
  // The far rear closes behind the monitor, deliberately not visible as a hard helmet rim.
  mesh(resources, head, surface(60, 20, (u, v) => {
    const p = hoodPoint(u, 1); return new THREE.Vector3(p.x * (1 - v), p.y * (1 - v) - v * .15, p.z - Math.sin(v * Math.PI) * .18);
  }), cloth);
  const hemPoints = Array.from({ length: 81 }, (_, i) => hoodPoint(i / 80, .012).toArray());
  cable(resources, head, hemPoints, .012, seam, 96);
  const stitchPoints = Array.from({ length: 81 }, (_, i) => hoodPoint(i / 80, .067).add(new THREE.Vector3(0, .004, .006)).toArray());
  cable(resources, head, stitchPoints, .006, seam, 96);
  // Top panel's seam breaks the otherwise smooth silhouette.
  cable(resources, head, Array.from({ length: 18 }, (_, i) => hoodPoint(.475, i / 17).add(new THREE.Vector3(0, .012, 0)).toArray()), .008, seam, 24);

  batchStatic(resources, body);
  batchStatic(resources, headHardware);
  let previousTint = '', previousCloth = '';
  return {
    group,
    update(next, time, audio?: SpeechAudioFrame) {
      face.update(next, time, audio);
      if (next.casingTint !== previousTint) { enamel.color.set(next.casingTint).multiplyScalar(.82); previousTint = next.casingTint; }
      if (next.hoodieColor !== previousCloth) {
        cloth.color.set(next.hoodieColor).multiplyScalar(1.9); seam.color.set(next.hoodieColor).multiplyScalar(1.8);
        previousCloth = next.hoodieColor;
      }
      wearUniform.value = next.casingWear;
      enamel.bumpScale = .005 + next.casingWear * .027;
      enamel.roughness = .38 + next.casingWear * .18;
      const idle = next.idleIntensity;
      const breath = Math.sin(time * 1.13) * .012 * idle;
      body.position.y = breath * .35;
      body.scale.y = 1 + breath * .45;
      head.position.y = 2.62 + breath;
      head.rotation.set(-.035 + Math.sin(time * .51) * .012 * idle,
        .075 + Math.sin(time * .37 + .6) * .028 * idle,
        -.092 + Math.sin(time * .43) * .025 * idle);
    },
  };
}
