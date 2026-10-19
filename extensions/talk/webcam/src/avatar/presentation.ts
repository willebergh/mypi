import * as THREE from 'three';
import { PRESENTATION_CC_SAFE_PX, parsePresentation, preparedPresentationImage, type Presentation, type PreparedPresentation } from '../shared/presentation-protocol';
import { CYAN, BRIGHT, MUTED, AMBER, MONO, OPEN_DURATION, CLOSE_DURATION,
  paintHudGlass, PANEL_VERTEX, PANEL_FRAGMENT } from './hud-panel';

export interface PresentationRect { x: number; y: number; width: number; height: number }
export interface PresentationOverlayState {
  /** Includes the empty-frame exit, so the render-only HUD mask cannot flash. */
  active: boolean;
  /** Same logical 1280x720 / 720x1280 coordinates used by HUD/captions. */
  rect: PresentationRect | null;
  captionSafeBottom: number;
  textTruncated: boolean;
}
export function presentationRectsOverlap(a: PresentationRect, b: PresentationRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const RASTER_SIZE = 1280;
const PAINT_INTERVAL = 1 / 30;
const REPLACE_DURATION = 0.28;
const IMAGE_DURATION = 0.24;
// Content is separate from the non-sensitive glass. Clearing can erase it NOW
// while the shared HUD shader reverses its frame, without retaining exit text.
const CONTENT_FRAGMENT = `
  uniform sampler2D map;
  uniform vec2 size;
  uniform vec2 mapScale;
  uniform float opening;
  uniform float replacement;
  uniform float imageOpacity;
  uniform vec2 imageBand;
  varying vec2 vHudUv;
  void main() {
    vec2 pixel = vec2(vHudUv.x, 1.0 - vHudUv.y) * size;
    vec2 inkUv = vec2(vHudUv.x * mapScale.x, 1.0 - (1.0 - vHudUv.y) * mapScale.y);
    vec4 ink = texture2D(map, inkUv);
    // Same scan phase as the telemetry shader, without scaling/reflowing ink.
    float revealY = smoothstep(0.52, 1.0, opening) * (size.y + 8.0);
    float reveal = 1.0 - smoothstep(revealY - 8.0, revealY, pixel.y);
    float refreshY = smoothstep(0.0, 0.75, replacement) * (size.y + 24.0);
    float refresh = 1.0 - smoothstep(refreshY - 24.0, refreshY, pixel.y);
    float alpha = ink.a * reveal * refresh * smoothstep(0.0, 1.0, replacement);
    if (pixel.y >= imageBand.x && pixel.y <= imageBand.y) alpha *= imageOpacity;
    gl_FragColor = vec4(ink.rgb, alpha);
    #include <colorspace_fragment>
  }
`;

type Row = { text: string; indent: number; marker?: string };

/** Holographic public overlay. Feed ONLY trusted prepared main/preload values.
 * No fetch, path rendering, HTML/Markdown engine, provider, or audio API.
 * Two fixed backing rasters/quads; animation only changes uniforms/visibility.
 */
export function createCallPresentationOverlay() {
  const scene = new THREE.Scene();
  scene.visible = false;
  const camera = new THREE.OrthographicCamera(0, 1280, 0, 720, 0.1, 10);
  camera.position.z = 1;
  const geometry = new THREE.PlaneGeometry(1, 1);
  function raster() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = RASTER_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Presentation requires a 2D canvas');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return { canvas, ctx, texture };
  }
  const glass = raster(), content = raster();
  const frameMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: glass.texture }, size: { value: new THREE.Vector2() },
      mapScale: { value: new THREE.Vector2() }, visibleHeight: { value: 0 },
      opening: { value: 0 }, opacity: { value: 0.82 }, strip: { value: 0 }, cyan: { value: new THREE.Color(CYAN) },
    },
    vertexShader: PANEL_VERTEX, fragmentShader: PANEL_FRAGMENT,
    transparent: true, depthTest: false, depthWrite: false,
    toneMapped: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true,
  });
  const contentMaterial = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: content.texture }, size: { value: new THREE.Vector2() },
      mapScale: { value: new THREE.Vector2() }, opening: { value: 0 }, replacement: { value: 0 },
      imageOpacity: { value: 1 }, imageBand: { value: new THREE.Vector2(-1, -1) },
    },
    vertexShader: PANEL_VERTEX, fragmentShader: CONTENT_FRAGMENT,
    transparent: true, depthTest: false, depthWrite: false,
    toneMapped: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true,
  });
  const frameMesh = new THREE.Mesh(geometry, frameMaterial);
  const contentMesh = new THREE.Mesh(geometry, contentMaterial);
  frameMesh.frustumCulled = contentMesh.frustumCulled = false;
  frameMesh.renderOrder = 1; contentMesh.renderOrder = 2;
  scene.add(frameMesh, contentMesh);
  let width = 1280, height = 720, disposed = false, generation = 0;
  let presentation: Presentation | null = null, decoded: HTMLImageElement | null = null;
  let loading: HTMLImageElement | null = null;
  let metadataKey = '', imageKey = '', truncated = false, imageFailed = false;
  let lastValue: PreparedPresentation | null | undefined;
  let progress = 0, target: 0 | 1 = 0, contentProgress = 0, imageProgress = 1;
  let lastSample = performance.now() / 1000, lastPaint = -Infinity;
  let glassDirty = true, contentDirty = false, contentReady = false, imageRevealPending = false;
  let imageArea: PresentationRect | null = null;

  function rect(): PresentationRect {
    // Both leave >120 logical pixels for CC; only layout, never animation,
    // changes the card bounds. Font sizes are identical in either orientation.
    return height > width ? { x: 24, y: 92, width: 672, height: 1028 }
      : { x: 400, y: 32, width: 848, height: 536 };
  }
  function layout(): void {
    const box = rect();
    for (const mesh of [frameMesh, contentMesh]) {
      mesh.scale.set(box.width, -box.height, 1);
      mesh.position.set(box.x + box.width / 2, box.y + box.height / 2, 0);
      mesh.material.uniforms.size.value.set(box.width, box.height);
      mesh.material.uniforms.mapScale.value.set(box.width / RASTER_SIZE, box.height / RASTER_SIZE);
    }
    frameMaterial.uniforms.visibleHeight.value = box.height;
    glassDirty = true;
  }
  function sample(now = performance.now() / 1000): void {
    const elapsed = Math.max(0, now - lastSample);
    lastSample = now;
    progress = THREE.MathUtils.clamp(progress + elapsed * (target ? 1 / OPEN_DURATION : -1 / CLOSE_DURATION), 0, 1);
    contentProgress = Math.min(1, contentProgress + elapsed / REPLACE_DURATION);
    imageProgress = Math.min(1, imageProgress + elapsed / IMAGE_DURATION);
    frameMaterial.uniforms.opening.value = contentMaterial.uniforms.opening.value = progress;
    contentMaterial.uniforms.replacement.value = contentProgress;
    contentMaterial.uniforms.imageOpacity.value = THREE.MathUtils.smoothstep(imageProgress, 0, 1);
    frameMesh.visible = progress > 0;
    contentMesh.visible = !!presentation && contentReady && progress > 0;
    scene.visible = target === 1 || progress > 0;
  }
  function cancelImage(): void {
    generation++;
    if (loading) { loading.onload = loading.onerror = null; loading.src = ''; }
    loading = decoded = null; imageFailed = false; imageRevealPending = false;
  }
  function eraseContent(): void {
    // Hide synchronously even if a security clear arrives between render ticks.
    contentMesh.visible = contentReady = false;
    content.ctx.clearRect(0, 0, RASTER_SIZE, RASTER_SIZE);
    content.texture.needsUpdate = true;
    contentDirty = false; truncated = false; imageArea = null;
    contentMaterial.uniforms.imageBand.value.set(-1, -1);
  }
  function eraseImage(): void {
    if (!imageArea) return;
    content.ctx.clearRect(imageArea.x, imageArea.y, imageArea.width, imageArea.height);
    content.texture.needsUpdate = true;
  }
  function wrap(value: string, available: number, bullets = true): Row[] {
    const rows: Row[] = [], ctx = content.ctx;
    for (const paragraph of value.split('\n')) {
      const plain = paragraph.trim();
      if (!plain) { rows.push({ text: '', indent: 0 }); continue; }
      const marker = bullets ? plain.match(/^(?:[-*•]|\d+[.)])\s+/u)?.[0] : undefined;
      const hanging = marker ? ctx.measureText(marker).width : 0;
      let row = '', continuation = false;
      const push = () => {
        rows.push({ text: row, indent: continuation ? hanging : 0, marker: continuation ? undefined : marker });
        row = ''; continuation = true;
      };
      for (const word of plain.split(/\s+/u)) {
        const limit = () => available - (continuation ? hanging : 0);
        if (row && ctx.measureText(`${row} ${word}`).width <= limit()) { row += ` ${word}`; continue; }
        if (row) push();
        for (const point of word) {
          if (row && ctx.measureText(row + point).width > limit()) push();
          row += point;
        }
      }
      if (row) push();
    }
    return rows;
  }
  function ellipsis(value: string, available: number): string {
    const points = Array.from(value);
    while (points.length && content.ctx.measureText(points.join('') + '…').width > available) points.pop();
    return points.join('') + '…';
  }
  function paintContent(): void {
    const ctx = content.ctx;
    ctx.clearRect(0, 0, RASTER_SIZE, RASTER_SIZE);
    truncated = false; imageArea = null;
    contentMaterial.uniforms.imageBand.value.set(-1, -1);
    if (!presentation) return;
    const box = rect(), padding = 28, innerWidth = box.width - padding * 2;
    const bottom = box.height - padding;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let y = padding;
    if (presentation.title) {
      ctx.font = `600 26px ${MONO}`; ctx.fillStyle = CYAN;
      const title = wrap(presentation.title, innerWidth, false);
      const shown = title.slice(0, 2);
      if (title.length > shown.length) {
        truncated = true;
        shown[shown.length - 1].text = ellipsis(shown[shown.length - 1].text, innerWidth);
      }
      shown.forEach((row, i) => ctx.fillText(row.text, padding, y + i * 34));
      y += shown.length * 34 + 12;
      ctx.fillStyle = 'rgba(108, 221, 255, 0.3)'; ctx.fillRect(padding, y, innerWidth, 1);
      ctx.fillStyle = AMBER; ctx.fillRect(padding, y - 1, 30, 2);
      y += 22;
    }
    if (presentation.image) {
      const imageHeight = presentation.text ? Math.floor((bottom - y - 20) * 0.46) : bottom - y;
      imageArea = { x: padding, y, width: innerWidth, height: imageHeight };
      ctx.save(); ctx.translate(padding, y);
      paintHudGlass(ctx, innerWidth, imageHeight);
      ctx.clip();
      if (decoded) {
        const scale = Math.min((innerWidth - 16) / decoded.naturalWidth, (imageHeight - 16) / decoded.naturalHeight);
        const w = decoded.naturalWidth * scale, h = decoded.naturalHeight * scale;
        ctx.drawImage(decoded, (innerWidth - w) / 2, (imageHeight - h) / 2, w, h);
        contentMaterial.uniforms.imageBand.value.set(y, y + imageHeight);
      } else {
        ctx.font = `14px ${MONO}`; ctx.fillStyle = MUTED;
        ctx.fillText(imageFailed ? 'Image unavailable' : 'Preparing image…', 18, 18);
      }
      ctx.restore();
      y += imageHeight + (presentation.text ? 20 : 0);
    }
    if (presentation.text) {
      ctx.font = `24px ${MONO}`; ctx.fillStyle = BRIGHT;
      const lineHeight = 34, rows = wrap(presentation.text, innerWidth);
      const capacity = Math.max(0, Math.floor((bottom - y) / lineHeight));
      const shown = rows.slice(0, capacity);
      if (rows.length > capacity) {
        truncated = true;
        if (shown.length) {
          const last = shown[shown.length - 1];
          last.text = ellipsis(last.text, innerWidth - last.indent);
        }
      }
      shown.forEach((row, i) => {
        ctx.fillStyle = BRIGHT; ctx.fillText(row.text, padding + row.indent, y + i * lineHeight);
        if (row.marker) { ctx.fillStyle = AMBER; ctx.fillText(row.marker, padding, y + i * lineHeight); }
      });
    }
    if (imageRevealPending) { imageProgress = 0; imageRevealPending = false; }
    contentReady = true;
    content.texture.needsUpdate = true;
  }
  layout();
  sample();
  return {
    scene, camera,
    resize(w: number, h: number): void {
      if (disposed) return;
      const nextWidth = h > w ? 720 : 1280, nextHeight = h > w ? 1280 : 720;
      if (width === nextWidth && height === nextHeight) return;
      width = nextWidth; height = nextHeight;
      camera.right = width; camera.bottom = height; camera.updateProjectionMatrix();
      // Reflow once; keep the current opening phase and fixed backing stores.
      eraseContent(); layout(); contentDirty = !!presentation;
    },
    /** Called by the existing render loop; uploads ink only on changed content,
     * coalesced to <=30Hz. No raster/texture allocation or paint for animation. */
    animate(): void {
      if (disposed) return;
      const now = performance.now() / 1000;
      sample(now);
      if (glassDirty) {
        const box = rect();
        glass.ctx.clearRect(0, 0, RASTER_SIZE, RASTER_SIZE);
        paintHudGlass(glass.ctx, box.width, box.height);
        glass.texture.needsUpdate = true; glassDirty = false;
      }
      if (contentDirty && now - lastPaint >= PAINT_INTERVAL) {
        paintContent(); contentDirty = false; lastPaint = now;
      }
      sample(now); // Apply new image fade/ink readiness without a one-frame flash.
    },
    /** Event-driven; safe per frame. Null synchronously erases protected ink. */
    update(value: PreparedPresentation | null): void {
      if (disposed || value === lastValue) return;
      sample(); // Reverse from this instant, not the last rendered phase.
      lastValue = value;
      // Prepared IPC is main-owned; scene independently matches fresh HUD metadata.
      const next = value ? parsePresentation(value.presentation, value.presentation.version === 1
        ? { callRunId: value.presentation.runId } : { displayScopeId: value.presentation.scopeId }) : undefined;
      const nextMetadata = next ? JSON.stringify(next) : '';
      if (nextMetadata !== metadataKey) {
        cancelImage(); imageKey = ''; metadataKey = nextMetadata;
        eraseContent(); presentation = next ?? null; target = next ? 1 : 0;
        contentProgress = 0; imageProgress = 1; contentDirty = !!next;
      }
      sample();
      if (!next) return;
      const image = preparedPresentationImage(value?.image);
      const nextImageKey = image && image.assetId === next.image?.assetId ? image.dataUrl : '';
      if (nextImageKey === imageKey) return;
      cancelImage(); eraseImage(); imageKey = nextImageKey;
      contentDirty = true; imageProgress = 1;
      if (!image || !nextImageKey) return;
      const token = generation;
      const candidate = new Image(); loading = candidate;
      candidate.onload = () => {
        if (disposed || token !== generation || loading !== candidate) return;
        loading = null; candidate.onload = candidate.onerror = null;
        if (candidate.naturalWidth !== image.width || candidate.naturalHeight !== image.height) {
          imageFailed = true; contentDirty = true; return;
        }
        decoded = candidate; imageRevealPending = true; contentDirty = true;
      };
      candidate.onerror = () => {
        if (disposed || token !== generation || loading !== candidate) return;
        loading = null; candidate.onload = candidate.onerror = null; imageFailed = true; contentDirty = true;
      };
      candidate.src = image.dataUrl; // ONLY trusted bounded PNG/JPEG data URLs.
    },
    read(): PresentationOverlayState {
      const active = !disposed && (target === 1 || progress > 0);
      return { active, rect: active ? rect() : null,
        captionSafeBottom: PRESENTATION_CC_SAFE_PX, textTruncated: truncated };
    },
    dispose(): void {
      if (disposed) return;
      cancelImage(); eraseContent(); disposed = true; presentation = null; lastValue = undefined;
      imageKey = metadataKey = ''; progress = target = 0;
      scene.visible = false; scene.clear(); geometry.dispose(); frameMaterial.dispose(); contentMaterial.dispose();
      glass.texture.dispose(); content.texture.dispose();
      glass.canvas.width = glass.canvas.height = content.canvas.width = content.canvas.height = 1;
    },
  };
}
