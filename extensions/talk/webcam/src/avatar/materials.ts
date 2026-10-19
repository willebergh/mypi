import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Per-world ownership: nothing GPU-backed is shared between renderer contexts. */
export class WorldResources {
  readonly geometries = new Set<THREE.BufferGeometry>();
  readonly materials = new Set<THREE.Material>();
  readonly textures = new Set<THREE.Texture>();
  geometry<T extends THREE.BufferGeometry>(value: T): T { this.geometries.add(value); return value; }
  material<T extends THREE.Material>(value: T): T { this.materials.add(value); return value; }
  texture<T extends THREE.Texture>(value: T): T { this.textures.add(value); return value; }
  dispose(): void {
    this.geometries.forEach(value => value.dispose());
    this.materials.forEach(value => value.dispose());
    this.textures.forEach(value => value.dispose());
    this.geometries.clear(); this.materials.clear(); this.textures.clear();
  }
}

export function seeded(seed: number): () => number {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function canvasTexture(resources: WorldResources, width: number, height: number,
  draw: (ctx: CanvasRenderingContext2D, random: () => number) => void, seed = 17): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Procedural scene requires a 2D canvas context');
  draw(ctx, seeded(seed));
  const texture = resources.texture(new THREE.CanvasTexture(canvas));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function surfaceTexture(resources: WorldResources, kind: 'cloth' | 'concrete' | 'metal' | 'wood'): THREE.CanvasTexture {
  const size = kind === 'concrete' || kind === 'metal' ? 1024 : 512;
  const texture = canvasTexture(resources, size, size, (ctx, random) => {
    const pixels = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = random();
      const broad = Math.sin(x * .031 + Math.sin(y * .014) * 2) * Math.sin(y * .019 + x * .004);
      let v: number;
      if (kind === 'cloth') v = 180 + n * 31 + Math.sin(x * Math.PI / 3) * 18 + Math.sin(y * Math.PI / 3) * 12 + Math.sin((x + y) * Math.PI / 6) * 7 + broad * 9;
      else if (kind === 'metal') v = 207 + n * 21 + broad * 9;
      else if (kind === 'wood') v = 88 + n * 27 + Math.sin(y * .2 + Math.sin(x * .013) * 3) * 16 + broad * 13;
      else v = 139 + n * 31 + broad * 8 + Math.sin(x * .009 + y * .007) * 6;
      const i = (y * size + x) * 4;
      pixels.data[i] = v;
      pixels.data[i + 1] = v * (kind === 'wood' ? .77 : .98);
      pixels.data[i + 2] = v * (kind === 'wood' ? .52 : .93);
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    if (kind === 'metal') {
      // Sparse chips concentrate along exposed edges; the broad faces retain old enamel.
      for (let i = 0; i < 420; i++) {
        let x = random() * size, y = random() * size;
        if (i < 320) {
          const edge = Math.floor(random() * 4), inset = random() ** 2 * 145;
          if (edge === 0) x = inset; else if (edge === 1) x = size - inset;
          else if (edge === 2) y = inset; else y = size - inset;
        }
        const r = random() ** 2 * 21 + .5;
        ctx.fillStyle = `rgba(25,28,27,${.32 + random() * .58})`;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let j = 0; j < 10; j++) { const a = j / 9 * Math.PI * 2; ctx.lineTo(x + Math.cos(a) * r * (.35 + random()), y + Math.sin(a) * r * (.3 + random())); }
        ctx.fill();
      }
      for (let i = 0; i < 3200; i++) {
        ctx.fillStyle = random() > .25 ? '#29312c55' : '#e8e5d144';
        ctx.fillRect(random() * size, random() * size, .4 + random() * 2, .4 + random() * 1.6);
      }
      for (let i = 0; i < 150; i++) {
        const x = random() * size, y = random() * size;
        ctx.strokeStyle = random() > .5 ? '#ffffff38' : '#27292377'; ctx.lineWidth = .3 + random() * .7;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + random() * 55, y - random() * 7); ctx.stroke();
      }
    }
    if (kind === 'concrete') {
      for (let i = 0; i < 120; i++) {
        const x = random() * size, y = random() * size;
        const stain = ctx.createRadialGradient(x, y, 0, x, y, 15 + random() * 120);
        stain.addColorStop(0, '#282a2422'); stain.addColorStop(1, '#282a2400');
        ctx.fillStyle = stain; ctx.fillRect(x - 150, y - 150, 300, 300);
      }
      for (let i = 0; i < 13; i++) {
        let x = random() * size, y = random() * size;
        ctx.strokeStyle = '#20231f77'; ctx.lineWidth = .5 + random() * 1.2; ctx.beginPath(); ctx.moveTo(x, y);
        for (let j = 0; j < 10; j++) { x += (random() - .44) * 20; y += random() * 19; ctx.lineTo(x, y); } ctx.stroke();
      }
      for (let i = 0; i < 380; i++) {
        const x = random() * size, y = random() * size, h = 6 + random() * 110;
        const drip = ctx.createLinearGradient(x, y, x, y + h);
        drip.addColorStop(0, '#272e2355'); drip.addColorStop(1, '#272e2300');
        ctx.fillStyle = drip; ctx.fillRect(x, y, 1 + random() * 3, h);
      }
      for (let i = 0; i < 1700; i++) {
        ctx.fillStyle = random() > .4 ? '#ddd6b82c' : '#252c2838';
        ctx.fillRect(random() * size, random() * size, .5 + random() * 4, .5 + random() * 3);
      }
      // Formwork joins and old anchor holes.
      ctx.fillStyle = '#26272150'; ctx.fillRect(0, 506, size, 5); ctx.fillRect(508, 0, 3, size);
      for (const x of [35, 478, 548, 986]) for (const y of [38, 475, 550, 985]) {
        ctx.fillStyle = '#363a31'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#bebaa266'; ctx.fillRect(x - 3, y + 3, 6, 1);
      }
    }
  }, kind === 'cloth' ? 21 : kind === 'concrete' ? 31 : 74);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

export function standard(resources: WorldResources, parameters: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return resources.material(new THREE.MeshStandardMaterial(parameters));
}

export function mesh(resources: WorldResources, parent: THREE.Object3D, geometry: THREE.BufferGeometry,
  material: THREE.Material, position: [number, number, number] = [0, 0, 0], shadow = true): THREE.Mesh {
  resources.geometry(geometry); resources.material(material);
  const object = new THREE.Mesh(geometry, material); object.position.set(...position);
  object.castShadow = shadow; object.receiveShadow = true; parent.add(object); return object;
}

export function box(resources: WorldResources, parent: THREE.Object3D, size: [number, number, number],
  position: [number, number, number], material: THREE.Material, radius = 0): THREE.Mesh {
  return mesh(resources, parent, radius > 0
    ? new RoundedBoxGeometry(...size, 3, Math.min(radius, Math.min(...size) * .48))
    : new THREE.BoxGeometry(...size), material, position);
}

export function cable(resources: WorldResources, parent: THREE.Object3D, points: number[][],
  radius: number, material: THREE.Material, segments = 28): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
  return mesh(resources, parent, new THREE.TubeGeometry(curve, segments, radius, 6, false), material);
}

export function rod(resources: WorldResources, parent: THREE.Object3D, start: number[], end: number[], radius: number,
  material: THREE.Material, sides = 10): THREE.Mesh {
  const a = new THREE.Vector3(...start as [number, number, number]);
  const b = new THREE.Vector3(...end as [number, number, number]);
  const direction = b.clone().sub(a);
  const object = mesh(resources, parent, new THREE.CylinderGeometry(radius, radius, direction.length(), sides), material);
  object.position.copy(a.add(b).multiplyScalar(.5));
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return object;
}

/** Collapse static workshop details by material; hundreds of screws/keys cost only a few draws. */
export function batchStatic(resources: WorldResources, root: THREE.Group): void {
  root.updateMatrixWorld(true);
  const inverseRoot = root.matrixWorld.clone().invert();
  const batches = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; geometries: THREE.BufferGeometry[] }>();
  const originals: THREE.Mesh[] = [];
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const key = `${object.material.uuid}:${object.castShadow}:${object.receiveShadow}`;
    let batch = batches.get(key);
    if (!batch) { batch = { material: object.material, cast: object.castShadow, receive: object.receiveShadow, geometries: [] }; batches.set(key, batch); }
    let geometry = object.geometry.clone();
    if (geometry.index) { const indexed = geometry; geometry = indexed.toNonIndexed(); indexed.dispose(); }
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseRoot, object.matrixWorld));
    for (const key of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv'].includes(key)) geometry.deleteAttribute(key);
    batch.geometries.push(geometry); originals.push(object);
  });
  for (const batch of batches.values()) {
    const geometry = mergeGeometries(batch.geometries, false);
    batch.geometries.forEach(value => value.dispose());
    if (!geometry) throw new Error('Unable to batch procedural workshop geometry');
    const object = mesh(resources, root, geometry, batch.material, [0, 0, 0], batch.cast);
    object.receiveShadow = batch.receive;
  }
  for (const object of originals) {
    object.removeFromParent();
    if (resources.geometries.delete(object.geometry)) object.geometry.dispose();
  }
}
