import * as THREE from 'three';
import { WorldResources, canvasTexture, standard, mesh, box, rod, cable } from './materials';
import { createTerminal } from './terminal';
import type { Environment } from './environment';

/** A quiet oak workstation; every asset and light belongs to this installation. */
export function createDeskRoom(resources: WorldResources): Environment {
  const group = new THREE.Group(); group.name = 'Oak / desk setup';
  const charcoal = standard(resources, { color: '#171e21', roughness: .65, metalness: .3 });
  const rubber = standard(resources, { color: '#080c10', roughness: .88 });
  const silver = standard(resources, { color: '#c2cbd0', roughness: .32, metalness: .65 });
  const wall = standard(resources, { color: '#333e40', roughness: .98 });
  const floor = standard(resources, { color: '#242c2c', roughness: .86 });
  // Long, gently wandering grain and fine pores, rather than tiled planks or distressed metal.
  const grain = canvasTexture(resources, 1024, 512, (ctx, random) => {
    ctx.fillStyle = '#bc905c'; ctx.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 1600; i++) {
      const y = random() * 512;
      ctx.strokeStyle = i % 4 ? `rgba(79,44,19,${.03 + random() * .13})` : '#edd0a540';
      ctx.lineWidth = .3 + random() * 1.5; ctx.beginPath();
      for (let x = 0; x <= 1024; x += 8) {
        const v = y + Math.sin(x * .008 + y * .023) * 7 + Math.sin(x * .021 + y * .09) * 2;
        if (!x) ctx.moveTo(x, v); else ctx.lineTo(x, v);
      }
      ctx.stroke();
    }
  }, 411);
  const oak = standard(resources, { map: grain, bumpMap: grain, bumpScale: .012, roughness: .49 });
  box(resources, group, [40, .12, 40], [0, -.09, -2], floor);
  box(resources, group, [40, 12, .18], [0, 3.4, -4.2], wall);
  box(resources, group, [40, .09, .07], [0, .08, -4.06], charcoal);
  // Solid slab, inset steel trestles, crossrail and adjustable feet.
  const slab = box(resources, group, [5.3, .17, 1.55], [1.15, 1.46, -1.95], oak, .045);
  slab.name = 'natural oak slab';
  for (const x of [-1.1, 3.4]) {
    for (const z of [-2.5, -1.4]) {
      box(resources, group, [.085, 1.35, .085], [x, .71, z], charcoal, .012);
      box(resources, group, [.16, .04, .18], [x, .025, z], rubber, .015);
    }
    box(resources, group, [.09, .09, 1.25], [x, .22, -1.95], charcoal, .01);
  }
  box(resources, group, [4.5, .09, .08], [1.15, 1.29, -2.5], charcoal);
  box(resources, group, [3.7, .08, .25], [1.1, 1.24, -2.4], charcoal, .02);

  const terminals: ReturnType<typeof createTerminal>[] = [];
  const screens: THREE.MeshBasicMaterial[] = [];
  function display(parent: THREE.Group, name: string, width: number, height: number, variant: number) {
    box(resources, parent, [width + .075, height + .075, .085], [0, 0, 0], charcoal, .028);
    const terminal = createTerminal(resources, variant, terminals.length); terminals.push(terminal);
    const material = resources.material(new THREE.MeshBasicMaterial({ map: terminal.texture, color: '#ffffff' }));
    screens.push(material);
    const panel = mesh(resources, parent, new THREE.PlaneGeometry(width, height), material, [0, 0, .047], false);
    panel.name = name;
    box(resources, parent, [.018, .005, .004], [width / 2 - .06, -height / 2 - .022, .045], silver);
  }
  function monitor(name: string, x: number, y: number, width: number, variant: number) {
    const unit = new THREE.Group(); unit.name = name; unit.position.set(x, y, -2.35); group.add(unit);
    display(unit, `${name} screen`, width, width * 9 / 16, variant);
    return unit;
  }
  monitor('large left landscape monitor', .05, 2.54, 2.25, 2);
  monitor('right lower landscape monitor', 2.12, 2.12, 1.65, 0);
  monitor('right upper landscape monitor', 2.12, 3.13, 1.65, 1);
  rod(resources, group, [.05, 1.57, -2.48], [.05, 2.5, -2.48], .055, silver);
  box(resources, group, [.65, .035, .38], [.05, 1.56, -2.3], charcoal, .04);
  rod(resources, group, [2.12, 1.52, -2.49], [2.12, 3.17, -2.49], .045, charcoal);
  box(resources, group, [.5, .045, .3], [2.12, 1.56, -2.45], charcoal, .025);
  for (const x of [.05, 2.12]) cable(resources, group,
    [[x + .08, 2.35, -2.42], [x + .15, 1.8, -2.6], [x + .25, 1.3, -2.55]], .012, rubber);

  const mini = new THREE.Group(); mini.name = 'silver Mac mini'; mini.position.set(-.85, 1.55, -1.65); group.add(mini);
  box(resources, mini, [.51, .025, .48], [0, .012, 0], rubber, .07);
  box(resources, mini, [.57, .13, .55], [0, .085, 0], silver, .065);
  // Inset front ports, status LED and dark circular underside identify the little aluminum computer.
  for (const x of [-.12, -.025]) box(resources, mini, [.042, .012, .005], [x, .075, .277], rubber, .005);
  mesh(resources, mini, new THREE.CircleGeometry(.012, 16), rubber, [.12, .075, .278]);
  const led = standard(resources, { color: '#cbe9ea', emissive: '#cbe9ea', emissiveIntensity: .7 });
  mesh(resources, mini, new THREE.SphereGeometry(.005, 8, 6), led, [.22, .075, .278], false);
  const badge = mesh(resources, mini, new THREE.CircleGeometry(.044, 24), charcoal, [0, .151, 0]); badge.rotation.x = -Math.PI / 2;

  const laptop = new THREE.Group(); laptop.name = 'open silver laptop'; laptop.position.set(1.12, 1.565, -1.43); group.add(laptop);
  box(resources, laptop, [.96, .035, .64], [0, 0, 0], silver, .025);
  box(resources, laptop, [.75, .006, .27], [0, .021, -.12], rubber, .015);
  for (let row = 0; row < 4; row++) for (let key = 0; key < 12; key++)
    box(resources, laptop, [.048, .008, .043], [-.33 + key * .06, .027, -.215 + row * .06], charcoal, .005);
  box(resources, laptop, [.34, .003, .17], [0, .02, .165], charcoal, .015);
  box(resources, laptop, [.326, .004, .156], [0, .022, .165], silver, .013);
  rod(resources, laptop, [-.40, .025, -.29], [.40, .025, -.29], .025, charcoal);
  const lid = new THREE.Group(); lid.position.set(0, .025, -.29); lid.rotation.x = -.20; laptop.add(lid);
  const panel = new THREE.Group(); panel.position.y = .29; lid.add(panel);
  box(resources, panel, [.96, .59, .025], [0, 0, -.035], silver, .022);
  display(panel, 'laptop screen', .86, .49, 2);
  cable(resources, group, [[.64, 1.56, -1.5], [.35, 1.56, -1.7], [-.5, 1.56, -1.85]], .009, rubber);

  // Three localized screen pools and one feathered camera-side robot spotlight. No room wash.
  const spill = [
    new THREE.PointLight('#a9cbe9', 15, 5, 2),
    new THREE.PointLight('#8fcdb4', 9, 4, 2),
    new THREE.PointLight('#e9c58b', 9, 4, 2),
  ];
  spill[0].position.set(.05, 2.5, -1.95);
  spill[1].position.set(2.12, 2.12, -1.95);
  spill[2].position.set(2.12, 3.13, -1.95);
  const fill = new THREE.SpotLight('#d1e6f2', 350, 24, .36, 1, 2);
  fill.name = 'camera-side robot spotlight'; fill.position.set(.6, 4.8, 14.8);
  fill.target.position.set(-.6, 2.65, .6); group.add(...spill, fill, fill.target);
  // Stage the desk beside, not directly behind, the broad foreground hood.
  // Transform only workstation objects; architecture and the robot fill stay in world space.
  const architecture = new Set(group.children.slice(0, 3));
  const workstation = new THREE.Group(); workstation.name = 'desk arrangement';
  for (const child of [...group.children]) {
    if (!architecture.has(child) && child !== fill && child !== fill.target) workstation.add(child);
  }
  workstation.scale.setScalar(.85); workstation.position.set(2, 0, 0);
  group.add(workstation);
  const cool = new THREE.Color('#a9cbe9'), warm = new THREE.Color('#ead0a4');
  return {
    group,
    setDesktopScreens(textures) {
      const slots = ['left', 'lowerRight', 'upperRight', 'laptop'] as const;
      screens.forEach((material, i) => {
        const map = textures[slots[i]] ?? terminals[i].texture;
        if (material.map !== map) { material.map = map; material.needsUpdate = true; }
      });
    },
    configureWorld(scene, camera, target) {
      scene.name = 'Oak / after-hours desk'; scene.background = new THREE.Color('#172023');
      scene.fog = new THREE.FogExp2('#172023', .025);
      camera.position.set(1.85, 4.2, 14.3); camera.fov = 29; target.set(1.85, 1.95, -.3);
    },
    update(config, time) {
      terminals.forEach(terminal => terminal.update(time));
      const balance = config.warmCoolBalance, level = config.roomIntensity;
      screens.forEach(material => { material.color.setScalar(2.5 * level * (1.12 - balance * .24)); });
      spill.forEach((light, i) => { light.intensity = [15, 9, 9][i] * level; });
      spill[0].color.copy(cool).lerp(warm, balance);
      fill.color.copy(cool).lerp(warm, balance * .45);
      fill.intensity = (420 - balance * 70) * (.8 + level * .2);
      led.emissiveIntensity = .7 * level;
    },
  };
}
