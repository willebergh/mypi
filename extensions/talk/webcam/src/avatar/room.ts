import * as THREE from 'three';
import type { SceneConfig } from '../shared/scene-config';
import { createTerminal } from './terminal';
import { WorldResources, canvasTexture, surfaceTexture, standard, mesh, box, rod, cable, batchStatic, seeded } from './materials';

export interface Room {
  group: THREE.Group;
  update(config: SceneConfig, time: number): void;
}

export function createRoom(resources: WorldResources): Room {
  const group = new THREE.Group(); group.name = 'basement workshop';
  const random = seeded(3107);
  const concreteMap = surfaceTexture(resources, 'concrete'); concreteMap.repeat.set(1, 1);
  const concrete = standard(resources, { color: '#68665d', map: concreteMap, bumpMap: concreteMap, bumpScale: .055, roughness: .95 });
  const pillarMap = resources.texture(concreteMap.clone()); pillarMap.repeat.set(1, 1);
  const pillar = standard(resources, { color: '#666b66', map: pillarMap, bumpMap: pillarMap, bumpScale: .06, roughness: .91 });
  const wearMap = surfaceTexture(resources, 'metal');
  const steel = standard(resources, { color: '#303b3c', metalness: .67, roughness: .64, map: wearMap, bumpMap: wearMap, bumpScale: .013 });
  const rusty = standard(resources, { color: '#64503b', metalness: .58, roughness: .8, map: wearMap });
  const dark = standard(resources, { color: '#101719', metalness: .36, roughness: .71, map: wearMap });
  const rubber = standard(resources, { color: '#0b1010', roughness: .94 });
  const aluminum = standard(resources, { color: '#777d78', metalness: .77, roughness: .54, map: wearMap });
  const woodMap = surfaceTexture(resources, 'wood'); woodMap.repeat.set(2, 1);
  const wood = standard(resources, { color: '#8d826c', map: woodMap, bumpMap: woodMap, bumpScale: .024, roughness: .8 });
  const paper = standard(resources, { color: '#9d977f', roughness: .99, map: concreteMap });
  const floorMap = resources.texture(concreteMap.clone()); floorMap.repeat.set(1, 1);
  const floorMaterial = standard(resources, { color: '#434943', roughness: .62, metalness: .12, map: floorMap, bumpMap: floorMap, bumpScale: .035 });
  const coolMaterials: THREE.MeshStandardMaterial[] = [];
  const warmMaterials: THREE.MeshStandardMaterial[] = [];
  const screenFrame = standard(resources, { color: '#222e31', roughness: .57, metalness: .46, map: wearMap });
  const blueIndicator = standard(resources, { color: '#4e8793', emissive: '#356d8b', emissiveIntensity: .8 });
  const amberIndicator = standard(resources, { color: '#8b5924', emissive: '#ca681d', emissiveIntensity: .65 });
  coolMaterials.push(blueIndicator); warmMaterials.push(amberIndicator);

  // Enough architecture beyond the frame to hold together under gentle orbit controls.
  box(resources, group, [13, .18, 15], [0, -.12, -2.5], floorMaterial);
  box(resources, group, [12, 6.2, .3], [0, 2.9, -5.25], concrete);
  box(resources, group, [.24, 6.2, 11], [-5.5, 2.9, -.25], concrete);
  box(resources, group, [.24, 6.2, 11], [5.5, 2.9, -.25], concrete);
  box(resources, group, [12, .25, 12], [0, 5.75, -1.5], concrete);
  for (const x of [-4.25, .35, 4.55]) {
    box(resources, group, [.43, 5.8, .58], [x, 2.8, -4.68], pillar, .025);
    box(resources, group, [.6, .24, .76], [x, .10, -4.68], concrete);
    box(resources, group, [.56, .13, .70], [x, 3.75, -4.68], rusty);
    for (const y of [1.3, 3.75]) {
      box(resources, group, [.5, .10, .64], [x, y, -4.68], steel);
      for (const dx of [-.16, .16]) mesh(resources, group, new THREE.SphereGeometry(.026, 6, 4), aluminum, [x + dx, y, -4.34]);
    }
  }
  for (const z of [-4.5, -1.5, 1.8]) box(resources, group, [11, .38, .48], [0, 5.28, z], pillar);
  box(resources, group, [10.5, .3, .40], [0, 4.65, -4.65], concrete);
  // Rear utility door and steps suggest a deeper service corridor.
  box(resources, group, [1.25, 2.8, .12], [.95, 1.65, -5.04], dark, .025);
  for (const x of [.28, 1.62]) box(resources, group, [.09, 2.95, .17], [x, 1.68, -4.96], rusty);
  box(resources, group, [.08, .27, .08], [1.43, 1.65, -4.91], aluminum, .016);
  for (let i = 0; i < 4; i++) box(resources, group, [1.5, .15 * (i + 1), .33], [.95, .075 * (i + 1), -3.66 - i * .34], concrete);

  // Exposed pipework, couplings, conduit and slack service cables.
  for (let i = 0; i < 4; i++) {
    const y = 4.10 + i * .17;
    rod(resources, group, [-5.2, y, -4.73], [5.2, y, -4.73], .035 + (i === 0 ? .025 : 0), i === 0 ? rusty : steel);
    for (const x of [-3.5, -1.5, 1.8, 3.8]) rod(resources, group, [x - .035, y, -4.73], [x + .035, y, -4.73], .055 + (i === 0 ? .025 : 0), aluminum);
  }
  for (const x of [-3.75, 3.95]) {
    cable(resources, group, [[x, .2, -4.6], [x, 3.8, -4.6], [x + .25, 4.45, -4.6], [x + 1, 4.52, -4.6]], .065, rusty);
    for (const y of [.7, 2.1, 3.4]) box(resources, group, [.20, .055, .15], [x, y, -4.59], steel);
  }
  for (const x of [-3, -.8, 1.4, 3.6]) rod(resources, group, [x, 5.32, -5], [x, 5.32, 3], .045, steel);
  for (let i = 0; i < 3; i++) {
    rod(resources, group, [5.32, 3.75 + i * .18, -5], [5.32, 3.75 + i * .18, 2.8], .04, i === 0 ? rusty : steel);
    for (const z of [-3.7, -.5, 2.2]) box(resources, group, [.16, .06, .08], [5.34, 3.75 + i * .18, z], aluminum);
  }
  for (const z of [-3.4, -.6]) {
    box(resources, group, [.24, .72, .44], [5.23, 2.65, z], steel, .025);
    rod(resources, group, [5.24, 2.95, z], [5.24, 3.72, z], .023, rusty);
    cable(resources, group, [[5.24, 2.3, z], [5.24, 1.3, z - .1], [5.24, .3, z + .22], [4.5, .03, z + .4]], .024, rubber);
  }
  cable(resources, group, [[-4.7, 5.15, .4], [-3.5, 4.48, -1], [-1.8, 4.28, -2.9], [.5, 4.83, -4.6], [3.6, 4.7, -4.6]], .025, rubber, 48);
  cable(resources, group, [[-5, 4.9, -4.5], [-3, 4.46, -4.3], [-.6, 4.63, -4.35], [1.5, 4.30, -4.4], [4.4, 4.8, -4.5]], .017, rubber, 48);

  const terminals: ReturnType<typeof createTerminal>[] = [];
  // One conventional triple-monitor workstation: equal panels and desk-height feet.
  const monitor = (x: number, y: number, z: number, width: number, variant: number, angle = 0) => {
    const unit = new THREE.Group(); unit.name = `workstation monitor ${variant}`;
    unit.position.set(x, y, z); unit.rotation.y = angle; group.add(unit);
    const h = width * .64;
    box(resources, unit, [width + .13, h + .14, .15], [0, 0, 0], screenFrame, .045);
    box(resources, unit, [width + .035, h + .025, .018], [0, .012, .083], rubber, .025);
    const terminal = createTerminal(resources, variant, terminals.length);
    terminals.push(terminal);
    const texture = terminal.texture;
    const screen = standard(resources, { color: '#111c22', map: texture, emissiveMap: texture,
      emissive: '#b2d9ed', emissiveIntensity: 4.2, roughness: .94, metalness: 0 });
    coolMaterials.push(screen);
    mesh(resources, unit, new THREE.PlaneGeometry(width, h), screen, [0, .012, .095], false);
    box(resources, unit, [.035, .009, .008], [width * .41, -h / 2 - .033, .081], blueIndicator);
    rod(resources, unit, [0, -h / 2, -.04], [0, -h / 2 - .27, -.06], .045, steel);
    box(resources, unit, [.44, .035, .25], [0, -h / 2 - .28, -.02], dark, .015);
    cable(resources, group, [[x + .12, y - h / 2, z - .1], [x + .25, y - h / 2 - .3, z - .3], [x + .18, 1.0, z - .4], [x + .7, .2, z - .3]], .018, rubber);
  };
  // Feet sit on the 1.325-high desktop; side panels turn 12 degrees inward.
  monitor(1.60, 2.0235, -2.78, 1.25, 0, .21);
  monitor(3.00, 2.0235, -2.92, 1.25, 1, 0);
  monitor(4.40, 2.0235, -2.78, 1.25, 2, -.21);

  // Rear workstation, keyboard rows and open equipment shelves.
  box(resources, group, [4.6, .13, 1.25], [2.85, 1.26, -2.73], wood, .025);
  box(resources, group, [4.65, .055, .04], [2.85, 1.255, -2.085], aluminum);
  for (const x of [.78, 4.92]) {
    box(resources, group, [.10, 1.24, .10], [x, .60, -2.23], steel);
    box(resources, group, [.10, 1.24, .10], [x, .60, -3.20], steel);
  }
  const keyboard = (x: number, z: number) => {
    box(resources, group, [.83, .045, .28], [x, 1.36, z], dark, .022);
    for (let row = 0; row < 4; row++) for (let key = 0; key < 13; key++) {
      box(resources, group, [.042, .015, .038], [x - .36 + key * .058, 1.39, z - .10 + row * .06], key % 11 === 0 ? aluminum : steel, .003);
    }
  };
  keyboard(3.00, -2.22);
  box(resources, group, [.12, .045, .19], [3.61, 1.36, -2.20], rubber, .028);
  // Small under-desk tower, drive bays and the familiar tangle rather than an empty black void.
  box(resources, group, [.52, .92, .76], [3.48, .49, -2.61], dark, .04);
  for (let i = 0; i < 4; i++) box(resources, group, [.42, .10, .03], [3.48, .70 - i * .12, -2.215], steel, .008);
  for (let i = 0; i < 4; i++) box(resources, group, [.018, .015, .01], [3.64, .71 - i * .12, -2.19], i === 0 ? amberIndicator : blueIndicator);
  for (let i = 0; i < 10; i++) {
    const x = .3 + i * .4;
    cable(resources, group, [[x, 1.21, -3], [x + .20, .49 + random() * .35, -2.94], [x + .35, .07, -2.5], [x + .75, .04, -1.5 - random()]], .012 + random() * .01, i % 4 === 0 ? rusty : rubber, 20);
  }

  // Matching server racks: vented units, rails, patch leads and independent status LEDs.
  const racks = [{ x: -3.03, z: -3.25 }, { x: -1.85, z: -3.25 }];
  for (const { x: rackX, z: rackZ } of racks) {
    box(resources, group, [1.0, 3.65, .65], [rackX, 1.86, rackZ], dark, .035);
    for (const dx of [-.47, .47]) box(resources, group, [.075, 3.67, .13], [rackX + dx, 1.86, rackZ + .38], aluminum);
    for (let i = 0; i < 13; i++) {
      const y = .26 + i * .265;
      box(resources, group, [.84, .225, .07], [rackX, y, rackZ + .37], i % 4 === 0 ? rusty : steel, .009);
      for (let j = 0; j < 8; j++) box(resources, group, [.038, .08, .008], [rackX - .26 + j * .065, y + .025, rackZ + .411], rubber);
      for (const dx of [-.395, .395]) mesh(resources, group, new THREE.SphereGeometry(.013, 6, 4), aluminum, [rackX + dx, y, rackZ + .413]);
      if (i % 3 === 0) cable(resources, group, [[rackX - .28, y, rackZ + .43], [rackX - .54, y - .12, rackZ + .55], [rackX - .57, y - .6, rackZ + .46], [rackX + .1, Math.max(.2, y - .55), rackZ + .43]], .015, i % 2 ? rubber : rusty, 20);
    }
  }
  // Junction boxes and a lower shelf of battered instruments.
  for (let i = 0; i < 3; i++) {
    const x = -4.7 + i * .43;
    box(resources, group, [.30, .51, .18], [x, 3.13 + (i % 2) * .22, -4.84], steel, .025);
    rod(resources, group, [x, 3.4, -4.79], [x, 4.4, -4.79], .018, aluminum);
  }
  box(resources, group, [2.25, .10, .53], [-4.2, 2.3, -3.9], wood);
  for (let i = 0; i < 6; i++) {
    box(resources, group, [.24 + random() * .15, .23 + random() * .25, .33], [-5.03 + i * .33, 2.52, -3.85], i % 2 ? rusty : steel, .018);
  }

  // Left foreground workbench: equipment and clutter, no local task lamp.
  box(resources, group, [2.2, .12, 2.1], [-2.90, .91, -.45], wood, .018);
  for (const x of [-3.8, -2.0]) box(resources, group, [.12, .87, .12], [x, .43, -.1], steel);
  for (let i = 0; i < 5; i++) {
    box(resources, group, [.65 - i * .035, .075, .44], [-2.85 + i * .025, 1.01 + i * .078, .12], i % 2 ? paper : rusty, .012).rotation.y = (i - 2) * .08;
  }
  box(resources, group, [.68, .23, .51], [-3.46, 1.075, -.98], steel, .025);
  for (let i = 0; i < 4; i++) rod(resources, group, [-3.67 + i * .14, 1.08, -.71], [-3.67 + i * .14, 1.08, -.68], .033, rubber);
  // Open circuit board: copper paths and actual discrete components on the tabletop.
  const board = standard(resources, { color: '#273c31', roughness: .79, metalness: .2 });
  box(resources, group, [.48, .012, .33], [-2.24, .985, .13], board);
  for (let i = 0; i < 8; i++) {
    box(resources, group, [.045, .035, .075], [-2.41 + (i % 4) * .10, 1.01, .04 + Math.floor(i / 4) * .15], rubber);
    box(resources, group, [.004, .002, .22], [-2.40 + (i % 4) * .1, .994, .12], rusty);
  }
  // A dark mug at the left edge supplies foreground scale without stealing focus.
  const cup = mesh(resources, group, new THREE.CylinderGeometry(.15, .125, .32, 32, 1, true), dark, [-3.28, 1.13, .43]);
  const cupRim = mesh(resources, group, new THREE.TorusGeometry(.15, .014, 6, 32), aluminum, [-3.28, 1.29, .43]); cupRim.rotation.x = Math.PI / 2;
  mesh(resources, group, new THREE.CircleGeometry(.138, 24), rubber, [-3.28, 1.25, .43]).rotation.x = -Math.PI / 2;
  const handle = mesh(resources, group, new THREE.TorusGeometry(.104, .026, 8, 20), dark, [-3.10, 1.14, .43]); handle.scale.x = .7;
  cup.castShadow = true;

  // Worn technical notices, no reference artwork, logos or recognizable interface copied.
  const noticeTexture = canvasTexture(resources, 512, 512, (ctx, rnd) => {
    ctx.fillStyle = '#a7a18a'; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = '#3c423b'; ctx.font = 'bold 26px monospace'; ctx.fillText('SERVICE ACCESS', 32, 49);
    ctx.font = '12px monospace'; ctx.fillText('ISOLATE SUPPLY BEFORE MAINTENANCE', 32, 76);
    ctx.strokeStyle = '#424c43'; ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const x = 45 + rnd() * 350, y = 110 + rnd() * 260;
      ctx.strokeRect(x, y, 20 + rnd() * 70, 30 + rnd() * 45);
      ctx.beginPath(); ctx.moveTo(x + 15, y); ctx.lineTo(x + 15, y - 15); ctx.lineTo(430, y - 15); ctx.stroke();
    }
    ctx.font = '11px monospace'; for (let i = 0; i < 5; i++) ctx.fillText(`${i + 1}.  CHECK CONTINUITY / GROUND  ${22 + i * 7}`, 35, 418 + i * 15);
    for (let i = 0; i < 1200; i++) { ctx.fillStyle = rnd() > .5 ? '#e4ddc222' : '#343c3433'; ctx.fillRect(rnd() * 512, rnd() * 512, rnd() * 13, rnd() * 4); }
  }, 86);
  const notice = standard(resources, { color: '#9a9a86', map: noticeTexture, roughness: 1 });
  mesh(resources, group, new THREE.PlaneGeometry(.73, .86), notice, [-1.95, 3.18, -5.077]).rotation.z = -.035;
  mesh(resources, group, new THREE.PlaneGeometry(.46, .55), notice, [4.55, 2.32, -4.375]).rotation.z = .07;

  // A faded carpet, with an original geometric border and a few loose floor leads.
  const rugTexture = canvasTexture(resources, 512, 512, (ctx, rnd) => {
    ctx.fillStyle = '#302e2b'; ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#59443a'; ctx.lineWidth = 28; ctx.strokeRect(24, 24, 464, 464);
    ctx.strokeStyle = '#77705a'; ctx.lineWidth = 3; ctx.strokeRect(44, 44, 424, 424);
    for (let y = 70; y < 460; y += 41) for (let x = 70; x < 460; x += 41) {
      ctx.strokeStyle = '#5b4a3e'; ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 12); ctx.lineTo(x - 9, y); ctx.closePath(); ctx.stroke();
    }
    for (let i = 0; i < 22000; i++) { ctx.fillStyle = rnd() > .45 ? '#11181755' : '#b6a78422'; ctx.fillRect(rnd() * 512, rnd() * 512, 1, 3); }
  }, 47);
  const rug = standard(resources, { color: '#706458', map: rugTexture, roughness: 1 });
  const carpet = mesh(resources, group, new THREE.PlaneGeometry(4.8, 3.8), rug, [1.7, -.017, -.72]); carpet.rotation.x = -Math.PI / 2;
  for (let i = 0; i < 4; i++) cable(resources, group, [[3.8, .035, -3], [4.4 - i * .1, .04, -1.6], [3.4, .04, -.3 + i * .1], [4.7, .04, 1.1 + i * .1]], .018, rubber, 35);

  // Dusty ceiling fixture stays in place, switched off.
  box(resources, group, [1.8, .09, .16], [1.3, 4.92, -3.8], steel, .015);
  const strip = standard(resources, { color: '#7d9794' });
  box(resources, group, [1.63, .022, .08], [1.3, 4.862, -3.8], strip, .008);

  // Metric UV projection prevents long concrete beams inheriting stretched wood-like grain.
  const masonryMaterials = new Set<THREE.Material>([concrete, pillar, floorMaterial]);
  group.updateMatrixWorld(true);
  const sample = new THREE.Vector3();
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !masonryMaterials.has(object.material as THREE.Material)) return;
    const position = object.geometry.getAttribute('position'), normal = object.geometry.getAttribute('normal'), uv = object.geometry.getAttribute('uv');
    for (let i = 0; i < position.count; i++) {
      sample.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      if (Math.abs(normal.getY(i)) > .7) uv.setXY(i, sample.x * .34, sample.z * .34);
      else if (Math.abs(normal.getX(i)) > .7) uv.setXY(i, sample.z * .34, sample.y * .34);
      else uv.setXY(i, sample.x * .34, sample.y * .34);
    }
  });
  batchStatic(resources, group);
  // Room surfaces use only unshadowed screen spill and camera-side fill.
  group.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = false; object.receiveShadow = false; } });

  // Add AFTER batchStatic: it intentionally strips vertex colors and replaces geometries.
  // One draw for both racks' 104 LEDs; only vertex colors change, no extra lights.
  const ledRandom = seeded(917);
  const ledPositions: number[] = [], ledIndices: number[] = [];
  const leds = Array.from({ length: racks.length * 52 }, (_, i) => {
    const { x: rackX, z: rackZ } = racks[Math.floor(i / 52)];
    const row = Math.floor((i % 52) / 4), port = i % 4;
    const x = rackX + .13 + port * .07, y = .26 + row * .265 - .065;
    const vertex = i * 4;
    ledPositions.push(x - .011, y - .007, rackZ + .416,
      x + .011, y - .007, rackZ + .416,
      x + .011, y + .007, rackZ + .416,
      x - .011, y + .007, rackZ + .416);
    ledIndices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
    return { phase: ledRandom() * 20, period: .7 + ledRandom() * 2.7,
      duty: .16 + ledRandom() * .45, rate: 9 + ledRandom() * 19,
      link: port === 0, color: new THREE.Color(row % 4 === 0 && port === 3 ? '#ffb54d' : '#7edab4') };
  });
  const ledGeometry = new THREE.BufferGeometry();
  ledGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ledPositions, 3));
  ledGeometry.setIndex(ledIndices);
  const ledColors = new THREE.BufferAttribute(new Float32Array(leds.length * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
  ledGeometry.setAttribute('color', ledColors);
  const ledMaterial = resources.material(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  const ledMesh = mesh(resources, group, ledGeometry, ledMaterial, [0, 0, 0], false);
  ledMesh.name = 'asynchronous network link / activity'; ledMesh.receiveShadow = false;
  const baseCool = coolMaterials.map(m => m.emissiveIntensity);
  const baseWarm = warmMaterials.map(m => m.emissiveIntensity);
  return {
    group,
    update(config, time) {
      terminals.forEach(terminal => terminal.update(time));
      const cool = config.roomIntensity * (1.17 - config.warmCoolBalance * .34);
      const warm = config.roomIntensity * (.78 + config.warmCoolBalance * .40);
      coolMaterials.forEach((material, i) => { material.emissiveIntensity = baseCool[i] * cool; });
      warmMaterials.forEach((material, i) => { material.emissiveIntensity = baseWarm[i] * warm; });
      // Steady link LEDs plus independent packet bursts with hard, irregular edges.
      // Absolute-time hashing keeps preview/output deterministic, including after seeks.
      for (let i = 0; i < leds.length; i++) {
        const led = leds[i], clock = Math.max(0, time) + led.phase;
        const tick = Math.floor(clock * led.rate);
        const hash = Math.imul(tick ^ (i * 7919), 1597334677) >>> 0;
        const burst = (clock % led.period) < led.period * led.duty;
        const on = led.link || (burst && (hash % 11) > 3);
        const level = (on ? (led.link ? .65 : 1.65) : .035) * cool;
        for (let v = i * 4; v < i * 4 + 4; v++) {
          ledColors.setXYZ(v, led.color.r * level, led.color.g * level, led.color.b * level);
        }
      }
      ledColors.needsUpdate = true;
    },
  };
}
