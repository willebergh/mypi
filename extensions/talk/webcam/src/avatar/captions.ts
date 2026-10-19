import * as THREE from 'three';
import type { LiveCaptionLine } from '../shared/live-protocol';

/** Ordinary video CC, independent of holographic HUD visibility/opacity.
 * One fixed backing/texture for its lifetime; repaint/upload only changed ink
 * or layout. Shared scene.ts burns this pass into editor AND hidden output. */
export function createClosedCaptions() {
  const scene = new THREE.Scene();
  scene.visible = false;
  const camera = new THREE.OrthographicCamera(0, 1280, 0, 720, 0.1, 10);
  camera.position.z = 1;
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Captions require a 2D canvas context');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const geometry = new THREE.PlaneGeometry(1280, 192);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true,
    depthTest: false, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.y = -1;
  mesh.frustumCulled = false;
  scene.add(mesh);
  let width = 1280, height = 720, signature = '', disposed = false;

  // Timestamp first; actual observed revisions break ties, never speaker role.
  const revisions = new Map<LiveCaptionLine['speaker'], { ink: string; order: number }>();
  let revision = 0, newestAt = -Infinity, newestOrder = 0;

  function fittingTail(value: string, label: string, maxWidth: number): string {
    const text = value.trim().replace(/\s+/gu, ' ');
    if (ctx!.measureText(label + text).width <= maxWidth) return label + text;
    // Keep the font legible and the latest text on exactly one visual line.
    const points = Array.from(text);
    const prefix = label + '… ';
    let tail = '';
    for (let i = points.length - 1; i >= 0; i--) {
      const candidate = points[i] + tail;
      if (ctx!.measureText(prefix + candidate).width > maxWidth) break;
      tail = candidate;
    }
    return prefix + tail;
  }
  return {
    scene, camera,
    resize(w: number, h: number) {
      const portrait = h > w;
      width = portrait ? 720 : 1280; height = portrait ? 1280 : 720;
      camera.right = width; camera.bottom = height;
      camera.updateProjectionMatrix();
      signature = '';
    },
    update(lines: readonly LiveCaptionLine[], bottomClearance: number) {
      if (disposed) return;
      let current: LiveCaptionLine | undefined;
      let currentOrder = 0;
      for (const line of lines) {
        const ink = JSON.stringify([line.id, line.text, line.final, line.updatedAt]);
        let observed = revisions.get(line.speaker);
        if (!observed || observed.ink !== ink) {
          observed = { ink, order: ++revision };
          revisions.set(line.speaker, observed);
        }
        if (!line.text.trim()) continue;
        if (!current || line.updatedAt > current.updatedAt
          || (line.updatedAt === current.updatedAt && observed.order > currentOrder)) {
          current = line;
          currentOrder = observed.order;
        }
      }
      // Remember the newest selection even after expiry/removal: never fall
      // back to the other speaker's older, still-live caption. Empty input still
      // clears the scene immediately; no expiry or call gating lives here.
      if (current && (current.updatedAt < newestAt
        || (current.updatedAt === newestAt && currentOrder < newestOrder))) current = undefined;
      if (current) { newestAt = current.updatedAt; newestOrder = currentOrder; }
      const portrait = height > width;
      const font = portrait ? 22 : 24, lineHeight = portrait ? 26 : 30;
      const margin = portrait ? 10 : 18, padding = portrait ? 4 : 6;
      // Preserve the existing clearance gate, but allow only one row total.
      const fits = bottomClearance - margin - 2 * padding >= lineHeight;
      scene.visible = !!current && fits;
      if (!current || !scene.visible) { signature = ''; return; }
      const next = JSON.stringify([width, current.id, current.speaker, current.text]);
      if (next === signature) return;
      signature = next;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `600 ${font}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const maxWidth = Math.min(1000, width - 48);
      const label = current.speaker === 'user' ? 'You: ' : 'Agent: ';
      const text = fittingTail(current.text, label, maxWidth);
      const boxHeight = lineHeight + 2 * padding;
      const y = canvas.height - boxHeight;
      const boxWidth = Math.min(maxWidth + 24, ctx.measureText(text).width + 24);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.74)';
      ctx.beginPath();
      ctx.roundRect((canvas.width - boxWidth) / 2, y, boxWidth, boxHeight, 6);
      ctx.fill();
      // Labels identify speakers without names/caller identity or HUD styling.
      ctx.fillStyle = current.speaker === 'user' ? '#e7f2ff' : '#ffffff';
      ctx.shadowColor = '#000000'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
      ctx.fillText(text, canvas.width / 2, y + padding + 0.5 * lineHeight);
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      // Eight-percent bottom safe inset in preview and output, clamped so
      // the single caption row still fits small viewports.
      const bottomInset = Math.min(height * 0.08, Math.max(0, height - boxHeight));
      mesh.position.set(width / 2, height - bottomInset - canvas.height / 2, 0);
      texture.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; scene.visible = false; scene.clear();
      geometry.dispose(); material.dispose(); texture.dispose();
      canvas.width = canvas.height = 1;
    },
  };
}
