import * as THREE from 'three';
import type { SceneConfig } from '../shared/scene-config';
import type { HudSnapshot, HudUsageWindow } from '../shared/hud-data';
import type { PresentationHudLayer } from './presentation-visibility';
import type { LiveHudTranscriptBlock } from '../shared/live-protocol.ts';
import { OFFLINE_LIVE_HUD, projectLiveHud } from '../shared/live-projection.ts';
import { selectTodoDisplay } from '../shared/todo-display.ts';
import { reduceSubagentAnimation, type SubagentAnimationState, type SubagentAnimationFrame,
  type SubagentAnimationRow, type SubagentAnimationOutcome } from '../shared/subagent-animation.ts';

import { CYAN, BRIGHT, MUTED, AMBER, MONO, OPEN_DURATION, CLOSE_DURATION,
  paintHudGlass, PANEL_VERTEX, PANEL_FRAGMENT } from './hud-panel';

const GREEN = '#8ce3c1';
const RED = '#ff8b91';
const PAINT_INTERVAL = 0.25;
const AGENT_PAINT_INTERVAL = 1 / 30;
type Box = { x: number; y: number; w: number; h: number };
type PanelKind = 'session' | 'events' | 'agents' | 'todos' | 'weekly';
type Layer = {
  box: Box;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
};
type PanelLayer = Layer & {
  kind: PanelKind;
  progress: number;
  target: 0 | 1;
  startAt: number;
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function tokens(value: number | null | undefined): string {
  return finite(value) && value >= 0 ? `${(value / 1000).toFixed(1)}k` : 'N/A';
}
function contextPercent(used: unknown, window: unknown): number | null {
  return finite(used) && used >= 0 && finite(window) && window > 0 ? used / window * 100 : null;
}
function percentage(value: number | null | undefined): string {
  return finite(value) ? `${value.toFixed(1)}%` : 'N/A';
}
function duration(seconds: number | null): string {
  if (!finite(seconds)) return 'N/A';
  const n = Math.max(0, Math.floor(seconds));
  return `${Math.floor(n / 3600).toString().padStart(2, '0')}:${Math.floor(n / 60 % 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
}
function resetLabel(window: HudUsageWindow | undefined, now: number): string {
  const seconds = finite(window?.resetAfterSeconds) ? window.resetAfterSeconds
    : finite(window?.resetAt) ? window.resetAt - now / 1000 : null;
  if (seconds === null) return 'Reset N/A';
  const minutes = Math.max(0, Math.ceil(seconds / 60));
  return minutes >= 1440 ? `Reset ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
    : `Reset ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function weeklyWindow(s: HudSnapshot): HudUsageWindow | undefined {
  if (s.usage.status !== 'ready') return undefined;
  return [s.usage.snapshot.primary, s.usage.snapshot.secondary].find(window =>
    window && (/week/i.test(window.label) || window.windowSeconds === 604800));
}
function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size = 12, color = BRIGHT, maxWidth?: number) {
  ctx.font = `${size >= 15 ? '600 ' : ''}${size}px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  let label = value;
  if (maxWidth !== undefined && ctx.measureText(label).width > maxWidth) {
    while (label.length && ctx.measureText(`${label}…`).width > maxWidth) label = label.slice(0, -1);
    label += '…';
  }
  ctx.fillText(label, x, y);
}
function rightText(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size = 12, color = MUTED, maxWidth?: number) {
  ctx.save();
  ctx.textAlign = 'right';
  text(ctx, value, x, y, size, color, maxWidth);
  ctx.restore();
}
function line(ctx: CanvasRenderingContext2D, x: number, y: number, endX: number, endY: number, alpha = 0.3) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.restore();
}
function panel(layer: Layer, title: string, detail: string, visibleHeight = layer.box.h) {
  const { ctx, box: { w, h: backingHeight } } = layer;
  const h = Math.max(4, visibleHeight);
  ctx.clearRect(0, 0, w, backingHeight);
  paintHudGlass(ctx, w, h);
  if (title) {
    text(ctx, title, 15, 22, 15, CYAN, w - 30 - (detail ? 70 : 0));
    rightText(ctx, detail, w - 15, 22, 11, MUTED, 72);
    line(ctx, 15, 39, w - 15, 39);
    ctx.fillStyle = AMBER;
    ctx.fillRect(15, 38, 30, 2);
  }
}
function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, percent: number | null | undefined, color = CYAN, h = 7) {
  ctx.fillStyle = 'rgba(108, 221, 255, 0.14)';
  ctx.fillRect(x, y, w, h);
  if (finite(percent)) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * THREE.MathUtils.clamp(percent / 100, 0, 1), h);
  } else {
    // Empty, dashed track means unavailable, never an invented zero-percent value.
    ctx.save();
    ctx.strokeStyle = MUTED;
    ctx.setLineDash([3, 5]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
  }
}
function session(s: HudSnapshot, layer: Layer) {
  const { ctx, box: { w } } = layer;
  panel(layer, '', '');
  text(ctx, s.session.model || 'No live session data', 15, 22, 16, BRIGHT, w - 30);
  const pct = finite(s.context.percent) ? s.context.percent : null;
  text(ctx, `${tokens(s.context.tokens)} / ${tokens(s.context.contextWindow)}`, 15, 46, 12, BRIGHT, w - 100);
  rightText(ctx, percentage(pct), w - 15, 46, 12, AMBER, 64);
  bar(ctx, 15, 60, w - 30, pct);
}
const AGENT_ROW_HEIGHT = 52;
function agentGeneration(s: HudSnapshot): string {
  // Projection exposes publisher identity inside preflight.generation. Ignore
  // its third (VOICE run) component: restarting a call is not an agent reset.
  let stream: string | null = null;
  if (s.source === 'live' && s.talk.generation) {
    try {
      const identity: unknown = JSON.parse(s.talk.generation);
      if (Array.isArray(identity) && typeof identity[0] === 'string') stream = identity[0];
    } catch { /* Custom projections may not provide publisher identity. */ }
  }
  return JSON.stringify([s.source, stream, s.session.id, s.session.startedAt, s.session.branch]);
}
function agents(frame: SubagentAnimationFrame, count: number, layer: Layer) {
  const { ctx, box: { w } } = layer;
  const shown = frame.rows;
  panel(layer, 'SUBAGENTS', count > shown.length ? `${shown.length}/${count}` : `${shown.length}`, frame.containerHeight);
  ctx.save();
  // Entries may originate above zero. Never let them paint over the header.
  ctx.beginPath();
  ctx.rect(2, 41, w - 4, Math.max(0, frame.containerHeight - 43));
  ctx.clip();
  // Paint ALL reducer rows, including exits; the reducer owns the shared cap.
  shown.forEach(animated => {
    const agent = animated.row;
    const y = 59 + animated.y;
    const color = animated.tint === 'green' ? GREEN : animated.tint === 'amber' ? AMBER
      : animated.tint === 'red' ? RED : animated.status === 'unknown' ? MUTED : CYAN;
    ctx.save();
    ctx.globalAlpha = animated.opacity;
    if (animated.highlight > 0) {
      ctx.save();
      ctx.globalAlpha *= animated.highlight * 0.32;
      ctx.fillStyle = color;
      ctx.fillRect(8, y - 11, w - 16, AGENT_ROW_HEIGHT - 4);
      ctx.restore();
    }
    const pct = contextPercent(agent.contextTokens, agent.contextWindow);
    text(ctx, agent.label, 15, y, 12, animated.tint ? color : BRIGHT, w - 139);
    rightText(ctx, animated.status.toUpperCase(), w - 15, y, 11, color, 110);
    const model = agent.model?.trim().replace(/^[^/]+\//, '').trim() || 'N/A';
    const usage = `${tokens(agent.contextTokens)} / ${finite(agent.contextWindow) && agent.contextWindow > 0 ? tokens(agent.contextWindow) : 'N/A'}`;
    const percent = pct === null ? 'UNAVAILABLE' : percentage(pct);
    ctx.font = `10px ${MONO}`;
    const percentWidth = Math.min(100, ctx.measureText(percent).width);
    const detailWidth = w - 30 - percentWidth - 10;
    const usageWidth = Math.min(ctx.measureText(usage).width, detailWidth * 0.55);
    const modelWidth = detailWidth - usageWidth - 10;
    text(ctx, model, 15, y + 13, 10, MUTED, modelWidth);
    text(ctx, usage, 15 + modelWidth + 10, y + 13, 10, MUTED, usageWidth);
    rightText(ctx, percent, w - 15, y + 13, 10, pct === null ? MUTED : color, percentWidth);
    bar(ctx, 15, y + 23, w - 30, pct, color, 3);
    ctx.restore();
  });
  ctx.restore();
}
const TODO_FIRST_ROW_Y = 22;
const TODO_ROW_PITCH = 25;
const TODO_BOTTOM_PADDING = 19;
const TODO_FOOTER_HEIGHT = 18;
/** One content measurement for ink, card bounds and both orientation stacks. */
function todoLayout(s: HudSnapshot) {
  const display = selectTodoDisplay(s.todos.items, 5);
  const counts = s.todos.counts ?? display.counts;
  const known = s.todos.counts !== undefined;
  const hiddenPending = counts.pending - display.rows.filter(item => !item.completed).length;
  const hiddenCompleted = counts.completed - display.rows.filter(item => item.completed).length;
  const hidden = [hiddenPending > 0 ? `+${hiddenPending} pending` : '', hiddenCompleted > 0 ? `+${hiddenCompleted} done` : ''].filter(Boolean);
  // Empty/offline messages occupy one real row; only omitted items need a footer.
  const height = TODO_FIRST_ROW_Y + (Math.max(1, display.rows.length) - 1) * TODO_ROW_PITCH
    + TODO_BOTTOM_PADDING + (hidden.length ? TODO_FOOTER_HEIGHT : 0);
  return { display, counts, known, hidden, height };
}
function todos(s: HudSnapshot, layer: Layer) {
  const { ctx, box: { w } } = layer;
  const { display, counts, known, hidden, height } = todoLayout(s);
  panel(layer, '', '', height);
  if (!display.rows.length) {
    text(ctx, s.source === 'offline' ? `Pi ${s.connection ?? 'offline'} · no todo data`
      : known && counts.total === 0 ? 'No tasks' : 'No received tasks',
      15, TODO_FIRST_ROW_Y, 12, MUTED, w - 30);
  }
  display.rows.forEach((item, i) => {
    const y = TODO_FIRST_ROW_Y + i * TODO_ROW_PITCH;
    // Amber outline means next queued, not running or completed.
    const color = item.completed ? GREEN : item.isNextPending ? AMBER : MUTED;
    ctx.strokeStyle = color;
    ctx.strokeRect(16, y - 5, 10, 10);
    if (item.completed) {
      ctx.fillStyle = color;
      ctx.fillRect(19, y - 2, 4, 4);
    }
    text(ctx, item.label, 37, y, 12, color, w - 52);
  });
  if (hidden.length) {
    text(ctx, `${hidden.join(' · ')} hidden${known ? '' : ' (received)'}`, 15, height - 14, 10, MUTED, w - 30);
  }
}
function weekly(s: HudSnapshot, layer: Layer) {
  const { ctx, box: { w, h } } = layer;
  panel(layer, '', '');
  const window = weeklyWindow(s);
  const used = finite(window?.usedPercent) ? window.usedPercent
    : finite(window?.remainingPercent) ? 100 - window.remainingPercent : null;
  // Tint the entire glass interior behind the text, not a separate track.
  // panel() leaves its chamfer path available for clipping.
  if (used !== null) {
    ctx.save();
    ctx.clip();
    const fill = ctx.createLinearGradient(0, 2, 0, h - 2);
    fill.addColorStop(0, 'rgba(108, 221, 255, 0.26)');
    fill.addColorStop(1, 'rgba(33, 185, 246, 0.10)');
    ctx.fillStyle = fill;
    ctx.fillRect(2, 2, (w - 4) * THREE.MathUtils.clamp(used / 100, 0, 1), h - 4);
    ctx.restore();
  }
  // Both label and background describe USED budget; only the fill is clamped.
  text(ctx, 'Weekly', 15, h / 2, 11, CYAN);
  text(ctx, used === null ? 'N/A used' : `${percentage(used)} used`, 65, h / 2, 10, used === null ? MUTED : AMBER, 78);
  const reset = window ? resetLabel(window, Date.now())
    : s.usage.status === 'ready' ? 'No weekly data' : `Usage ${s.usage.status}`;
  rightText(ctx, reset, w - 15, h / 2, 10, MUTED, w - 166);
}

const EVENT_ROW_HEIGHT = 20;
const EVENT_CONTENT_INSET = 38;
const EVENT_MIN_HEIGHT = EVENT_CONTENT_INSET + 2 * EVENT_ROW_HEIGHT;
// Design pixels, in addition to the normal outer margin and user bottom inset.
// Captions render in a separate layer; Activity never consumes their safe area.
const CAPTION_SAFE_HEIGHT = 120;
/** Wrap plain public text without flattening paragraphs or code indentation.
 * Tabs use four spaces; roles stay internal. The line budget keeps the recent
 * chronological tail (including the tail of an oversized newest block).
 */
export function activityLines(blocks: readonly LiveHudTranscriptBlock[], measure: (text: string) => number,
  width: number, budget: number): { text: string; role: LiveHudTranscriptBlock['role'] }[] {
  if (width <= 0 || budget <= 0) return [];
  const lines: { text: string; role: LiveHudTranscriptBlock['role'] }[] = [];
  for (const block of blocks) {
    for (const paragraph of block.text.replace(/\t/g, '    ').split('\n')) {
      let remaining = Array.from(paragraph);
      const leading = paragraph.match(/^ +/)?.[0] ?? '';
      const indent = measure(leading) < width / 2 ? leading : '';
      let continuation = false;
      do {
        const prefix = continuation ? indent : '';
        let end = 0;
        while (end < remaining.length && measure(prefix + remaining.slice(0, end + 1).join('')) <= width) end++;
        // A glyph wider than the card must still make progress; painting clips it.
        end = Math.max(1, end);
        if (end < remaining.length) {
          let boundary = end;
          while (boundary > 0 && remaining[boundary - 1] !== ' ') boundary--;
          if (boundary > 0 && remaining.slice(0, boundary).some(char => char !== ' ')) end = boundary;
        }
        lines.push({ text: prefix + remaining.slice(0, end).join(''), role: block.role });
        remaining = remaining.slice(end);
        continuation = true;
      } while (remaining.length);
    }
  }
  return lines.slice(-budget);
}
function events(s: HudSnapshot, layer: Layer) {
  const { ctx, box: { w, h } } = layer;
  panel(layer, '', '');
  text(ctx, s.session.status.toUpperCase(), 15, 17, 11, CYAN, w - 98);
  rightText(ctx, duration(s.session.elapsedMs === null ? null : s.session.elapsedMs / 1000), w - 15, 17, 10, MUTED, 58);
  line(ctx, 15, 30, w - 15, 30, 0.2);
  ctx.font = `11px ${MONO}`;
  const budget = Math.max(0, Math.floor((h - EVENT_CONTENT_INSET) / EVENT_ROW_HEIGHT));
  const shown = activityLines(s.transcript, value => ctx.measureText(value).width, w - 30, budget);
  if (!shown.length) {
    text(ctx, s.source === 'offline' ? `Pi ${s.connection ?? 'offline'} · no activity` : 'No visible conversation yet',
      15, 48, 11, MUTED, w - 30);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(15, 35, w - 30, layer.box.h - 39);
  ctx.clip();
  shown.forEach((row, i) => {
    const color = row.role === 'user' ? CYAN : row.role === 'tool' ? MUTED : row.role === 'custom' ? AMBER : BRIGHT;
    text(ctx, row.text, 15, 46 + i * EVENT_ROW_HEIGHT, 11, color);
  });
  ctx.restore();
}

/** Up to five panel draws, no full-screen layer or scene IO.
 * Telemetry rasters refresh at <=4Hz; animated agent ink at <=30Hz.
 * Independent 1.08s openings / 0.62s reverse closings only change uniforms.
 * Agent bounds/anchors tick every frame with a fixed-capacity backing raster.
 */
export function createHud(getSnapshot: (time: number) => HudSnapshot = () => projectLiveHud(OFFLINE_LIVE_HUD)): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  resize(width: number, height: number): void;
  /** Read-only bottom band; includes exiting panels so CC never covers them. */
  bottomClearance(): number;
  /** Actual current logical rectangles/meshes, including opening/exiting cards. */
  renderLayers(): readonly PresentationHudLayer[];
  update(config: SceneConfig, time: number, delta: number): void;
  dispose(): void;
} {
  const scene = new THREE.Scene();
  scene.visible = false;
  const root = new THREE.Group();
  scene.add(root);
  const camera = new THREE.OrthographicCamera(0, 1280, 0, 720, 0.1, 10);
  camera.position.z = 1;
  const geometry = new THREE.PlaneGeometry(1, 1);
  let width = 1280;
  let height = 720;
  let portrait = false;
  let mode: 'dashboard' | 'off' = 'off';
  let lastPaint = -Infinity;
  let lastUpdate = 0;
  let layoutDirty = true;
  let selectionDirty = true;
  let disposed = false;
  let panels: PanelLayer[] = [];
  let selection = '';
  let agentsHeight = 0;
  let todosHeight = TODO_FIRST_ROW_Y + TODO_BOTTOM_PADDING;
  let agentState: SubagentAnimationState | undefined;
  let agentFrame = reduceSubagentAnimation(undefined, { nowMs: 0, generation: 'offline', online: false });
  let agentSignature = '';
  let agentCount = 0;
  let agentPaintDirty = false;
  let lastAgentPaint = -Infinity;
  let paddingKey = '';
  let padding = { left: 0, right: 0, top: 0, bottom: 0 };
  let enabled: Record<PanelKind, boolean> = { session: true, events: true, agents: true, todos: true, weekly: true };

  function createLayer(box: Box, order = 1): Layer {
    const canvas = document.createElement('canvas');
    canvas.width = box.w;
    canvas.height = box.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('HUD requires a 2D canvas context');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture }, size: { value: new THREE.Vector2(box.w, box.h) },
        mapScale: { value: new THREE.Vector2(1, 1) },
        visibleHeight: { value: box.h },
        opening: { value: 1 }, opacity: { value: 1 }, strip: { value: 0 }, cyan: { value: new THREE.Color(CYAN) },
      },
      vertexShader: PANEL_VERTEX, fragmentShader: PANEL_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false,
      toneMapped: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Canvas top stays at the top in the downward-positive orthographic camera.
    mesh.scale.set(box.w, -box.h, 1);
    mesh.position.set(box.x + box.w / 2, box.y + box.h / 2, 0);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    root.add(mesh);
    return { box, canvas, ctx, texture, material, mesh };
  }
  function destroyLayer(layer: Layer) {
    root.remove(layer.mesh);
    layer.material.dispose();
    layer.texture.dispose();
    layer.canvas.width = layer.canvas.height = 1;
  }
  function reconcile(now: number): PanelLayer[] {
    const reopen = layoutDirty;
    if (reopen) {
      panels.forEach(destroyLayer);
      panels = [];
    }
    const existing = new Map(panels.map(layer => [layer.kind, layer]));
    const next: PanelLayer[] = [];
    const added: PanelLayer[] = [];
    const add = (kind: PanelKind, requestedBox: Box) => {
      if (!enabled[kind]) return;
      const box = { x: requestedBox.x, y: requestedBox.y,
        w: Math.round(requestedBox.w),
        // Never allocate/recreate textures for fractional animated heights.
        h: kind === 'agents' ? 52 + 3 * AGENT_ROW_HEIGHT : Math.round(requestedBox.h) };
      let layer = existing.get(kind);
      if (layer) {
        existing.delete(kind);
        if (layer.box.w !== box.w || layer.box.h !== box.h) {
          // Reflow to a different pixel width, not a transform that scales text.
          // Reflow does not restart an opening, even with a new backing texture.
          const { progress, target, startAt } = layer;
          destroyLayer(layer);
          layer = { ...createLayer(box), kind, progress, target, startAt };
          added.push(layer);
        } else {
          layer.box = box;
          layer.mesh.position.set(box.x + box.w / 2, box.y + box.h / 2, 0);
        }
      } else {
        layer = { ...createLayer(box), kind, progress: 0, target: 1,
          startAt: now + (reopen ? next.length * 0.12 : 0) };
        added.push(layer);
      }
      layer.material.uniforms.strip.value = kind === 'weekly' ? 1 : 0;
      layer.material.uniforms.visibleHeight.value = kind === 'agents' ? agentsHeight : box.h;
      next.push(layer);
    };
    // Dashboard honors every independent panel selection.
    const left = 24 + padding.left;
    const right = width - 24 - padding.right;
    // Weekly and Todos remain independent; Activity follows Session visibility.
    // Todos use their natural height between Session and the remaining Activity.
    const stackWidth = portrait ? right - left : 284;
    const stack: [PanelKind, number][] = [['weekly', 30], ['session', 84], ['todos', todosHeight], ['events', EVENT_MIN_HEIGHT]];
    const selectedStack = stack.filter(([kind]) => enabled[kind]);
    const stackHeight = selectedStack.reduce((sum, [, h]) => sum + h, 0) + Math.max(0, selectedStack.length - 1) * 10;
    const usableBottom = height - 24 - padding.bottom;
    let stackBottom = usableBottom - CAPTION_SAFE_HEIGHT;
    if (portrait && enabled.agents) {
      // Reserve full agent capacity, not animated containerHeight.
      // Activity's backing texture stays stable through row arrivals and exits;
      // the single column, including Subagents, stays above the CC safe area.
      const agentCapacity = 52 + 3 * AGENT_ROW_HEIGHT;
      stackBottom -= agentCapacity + 16;
    }
    let stackY = Math.max(24 + padding.top, Math.min((portrait ? 88 : 100) + padding.top, stackBottom - stackHeight));
    for (const [kind, minimumHeight] of selectedStack) {
      const h = kind === 'events' ? Math.max(EVENT_MIN_HEIGHT, Math.floor(stackBottom - stackY)) : minimumHeight;
      add(kind, { x: left, y: stackY, w: stackWidth, h });
      stackY += h + 10;
    }
    if (portrait) {
      add('agents', { x: left, y: usableBottom - CAPTION_SAFE_HEIGHT - agentsHeight,
        w: stackWidth, h: agentsHeight });
    } else {
      // Padding translates the side stacks. Their text and panel sizes never zoom.
      const y = 100 + padding.top;
      const agentY = Math.min(y, usableBottom - agentsHeight);
      add('agents', { x: right - 414, y: agentY, w: 414, h: agentsHeight });
    }
    existing.forEach(destroyLayer);
    panels = next;
    layoutDirty = false;
    selectionDirty = false;
    return added;
  }
  function paint(snapshot: HudSnapshot, layers: PanelLayer[]) {
    for (const layer of layers) {
      switch (layer.kind) {
        case 'session': session(snapshot, layer); break;
        case 'events': events(snapshot, layer); break;
        case 'agents': agents(agentFrame, agentCount, layer); break;
        case 'todos': todos(snapshot, layer); break;
        case 'weekly': weekly(snapshot, layer); break;
      }
      layer.texture.needsUpdate = true;
    }
  }

  return {
    scene,
    camera,
    renderLayers() {
      return panels.map(layer => ({ target: layer.mesh, bounds: { x: layer.box.x, y: layer.box.y,
        width: layer.box.w, height: layer.kind === 'agents' ? agentsHeight : layer.box.h } }));
    },
    bottomClearance() {
      const bottom = panels.reduce((edge, layer) => Math.max(edge,
        layer.box.y + (layer.kind === 'agents' ? agentsHeight : layer.box.h)), 0);
      return Math.max(0, height - bottom);
    },
    resize(actualWidth, actualHeight) {
      if (disposed || !finite(actualWidth) || !finite(actualHeight) || actualWidth <= 0 || actualHeight <= 0) return;
      const nextPortrait = actualHeight > actualWidth;
      if (nextPortrait === portrait) return;
      portrait = nextPortrait;
      width = portrait ? 720 : 1280;
      height = portrait ? 1280 : 720;
      camera.right = width;
      camera.bottom = height;
      camera.updateProjectionMatrix();
      layoutDirty = true;
      // Canonical design pixels keep previews readable. Rebuild on the next
      // update; never resize a texture that Three has already uploaded.
    },
    update(config, time, _delta) {
      if (disposed) return;
      const requested = config.hudMode ?? 'dashboard';
      // Legacy Minimal is Dashboard too, including renderer HMR on older main.
      const nextMode = requested === 'off' ? 'off' : 'dashboard';
      const now = finite(time) ? Math.max(0, time) : 0;
      const current = getSnapshot(now);
      const snapshot = current;
      // Keep the last active profile across Off so quick On reverses its meshes.
      if (nextMode !== 'off' && nextMode !== mode) {
        mode = nextMode;
        layoutDirty = true;
      }
      const nextTodosHeight = todoLayout(snapshot).height;
      if (nextTodosHeight !== todosHeight) {
        todosHeight = nextTodosHeight;
        selectionDirty = true; // Reflow actual card bounds without scaling text.
        lastPaint = -Infinity;
      }
      const activeRows: SubagentAnimationRow[] = [];
      const outcomes: SubagentAnimationOutcome[] = [];
      for (const agent of snapshot.subagents) {
        // Producer IDs are monotonic within a session. Do NOT rekey a queued
        // run when startedAt arrives, and never retain task/activity/error text.
        const runKey = String(agent.id);
        if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'aborted') {
          // #28 retains authoritative terminal snapshots. Absence is NOT success.
          outcomes.push({ runKey, status: agent.status });
        } else if (agent.status === 'queued' || agent.status === 'starting'
          || agent.status === 'thinking' || agent.status === 'running') {
          activeRows.push({ runKey, id: agent.id, label: agent.label, status: agent.status,
            model: agent.model, contextTokens: agent.contextTokens,
            contextWindow: agent.contextWindow, tokensPerSecond: agent.tokensPerSecond });
        }
      }
      const generation = agentGeneration(snapshot);
      const online = snapshot.source !== 'offline'; // Projection reports stale feeds offline.
      const signature = JSON.stringify([activeRows, outcomes]);
      const inputChanged = signature !== agentSignature || generation !== agentState?.generation
        || !online || now * 1000 < (agentState?.nowMs ?? 0);
      const wasAnimating = agentFrame.animating;
      agentFrame = reduceSubagentAnimation(agentState, {
        nowMs: now * 1000, generation, online,
        ...(inputChanged ? { snapshot: activeRows, outcomes } : {}),
        layout: { maxRows: 3, rowPitch: AGENT_ROW_HEIGHT, headerHeight: 52 },
      });
      agentState = agentFrame.state;
      agentSignature = signature;
      agentCount = activeRows.length;
      agentPaintDirty ||= inputChanged || wasAnimating || agentFrame.animating;
      const nextEnabled = {
        session: config.hudSession ?? true,
        events: config.hudSession ?? true,
        // Last-row pulses/fades and height collapse finish BEFORE auto-closing.
        agents: (config.hudSubagents ?? true) && (agentFrame.rows.length > 0 || agentFrame.containerHeight > 0),
        todos: config.hudTodos ?? true,
        weekly: config.hudWeekly ?? true,
      };
      const nextSelection = Object.values(nextEnabled).map(value => value ? '1' : '0').join('');
      const nextAgentsHeight = Math.min(52 + 3 * AGENT_ROW_HEIGHT, agentFrame.containerHeight);
      if (nextAgentsHeight !== agentsHeight) {
        agentsHeight = nextAgentsHeight;
        selectionDirty = true; // Move anchors, NOT text scale or backing size.
      }
      if (nextSelection !== selection) {
        enabled = nextEnabled;
        selection = nextSelection;
        selectionDirty = true;
        lastPaint = -Infinity;
      }
      // Website-style padding: translate anchors and reflow available widths.
      // The root and all typography stay at their normal pixel scale.
      const inset = (value: number | undefined) => finite(value) ? THREE.MathUtils.clamp(value, 0, 15) / 100 : 0;
      const left = width * inset(portrait ? config.hudPortraitInsetLeft : config.hudInsetLeft);
      const right = width * inset(portrait ? config.hudPortraitInsetRight : config.hudInsetRight);
      const top = height * inset(portrait ? config.hudPortraitInsetTop : config.hudInsetTop);
      const bottom = height * inset(portrait ? config.hudPortraitInsetBottom : config.hudInsetBottom);
      const nextPaddingKey = [left, right, top, bottom].join(',');
      if (nextPaddingKey !== paddingKey) {
        paddingKey = nextPaddingKey;
        padding = { left, right, top, bottom };
        selectionDirty = true; // Reuse existing progress, exactly like a panel toggle.
      }
      if (now < lastUpdate) {
        lastPaint = lastAgentPaint = -Infinity;
        panels.forEach(layer => { layer.startAt += now - lastUpdate; });
        lastUpdate = now;
      }
      const active = nextMode !== 'off';
      for (const layer of panels) {
        // First sample the old trajectory at this instant, then reverse from
        // that exact phase. No reset, blank frame, or duplicate kind on reversal.
        const elapsed = Math.max(0, now - Math.max(lastUpdate, layer.startAt));
        layer.progress = THREE.MathUtils.clamp(layer.progress
          + elapsed * (layer.target ? 1 / OPEN_DURATION : -1 / CLOSE_DURATION), 0, 1);
        const target = active && enabled[layer.kind] ? 1 : 0;
        if (target !== layer.target) {
          layer.target = target;
          layer.startAt = now; // Cancel any initial stagger when reversing.
          selectionDirty = true;
        }
      }
      lastUpdate = now;
      panels = panels.filter(layer => {
        if (layer.target || layer.progress > 0) return true;
        // At zero the ignition shader can still emit a dot: remove the mesh.
        destroyLayer(layer);
        selectionDirty = true;
        return false;
      });
      let added: PanelLayer[] = [];
      if (layoutDirty && !active) {
        // Orientation changes may discard exits, but Off never allocates.
        panels.forEach(destroyLayer);
        panels = [];
      } else if (active && (layoutDirty || selectionDirty)) {
        // Freeze ALL anchors while exiting, including the surviving cards.
        // Defer new kinds too: they must not occupy an exiting card's space.
        // Once exits finish, reflow without changing retained progress.
        if (layoutDirty || !panels.some(layer => !layer.target)) added = reconcile(now);
      }
      // Tick animation every render, upload only agent ink at a bounded cadence.
      // Ordinary panels keep their original telemetry cadence.
      const live = panels.filter(layer => layer.target === 1 || layer.kind === 'agents');
      const telemetryDue = now - lastPaint >= PAINT_INTERVAL;
      if (live.length && telemetryDue) {
        lastPaint = now;
        paint(snapshot, live.filter(layer => layer.kind !== 'agents'));
      } else if (added.length) {
        paint(snapshot, added.filter(layer => layer.kind !== 'agents'));
      }
      const agentLayer = panels.find(layer => layer.kind === 'agents');
      if (agentLayer && (added.includes(agentLayer)
        || ((agentPaintDirty || telemetryDue) && now - lastAgentPaint >= AGENT_PAINT_INTERVAL))) {
        paint(snapshot, [agentLayer]);
        lastAgentPaint = now;
        agentPaintDirty = false;
      }
      const opacity = finite(config.hudOpacity) ? THREE.MathUtils.clamp(config.hudOpacity, 0, 1) : 0.82;
      panels.forEach(layer => {
        layer.mesh.visible = layer.progress > 0;
        layer.material.uniforms.opening.value = layer.progress;
        layer.material.uniforms.opacity.value = opacity;
        if (layer.kind === 'agents') layer.material.uniforms.visibleHeight.value = agentsHeight;
      });
      // The parent renders by scene.visible, including the entire Off exit.
      scene.visible = active || panels.length > 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      panels.forEach(destroyLayer);
      panels = [];
      agentState = undefined;
      agentFrame = reduceSubagentAnimation(undefined, { nowMs: 0, generation: 'disposed', online: false });
      agentSignature = '';
      geometry.dispose();
      scene.clear();
      scene.visible = false;
    },
  };
}
