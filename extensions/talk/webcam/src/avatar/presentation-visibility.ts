import { presentationRectsOverlap, type PresentationRect } from './presentation';

export interface PresentationHudLayer {
  /** Layer's current animated/layout rectangle in logical output pixels. */
  bounds: PresentationRect;
  /** Mesh only, NOT the HUD scene or captions scene. */
  target: { visible: boolean };
}
/** Render-only mask: call AFTER normal hud.update(), around the HUD render pass.
 * No settings mutation, no closing/reflow animations, no guessed defaults. Every
 * original visible bit is restored in finally, including already-disabled panels
 * and user config changes made during a presentation. Recompute from actual
 * layout every frame, so portrait/insets/exiting panels are handled exactly.
 * While active, also pass the bottom-120px captionRegion to reserve CC space.
 * Keep captions OUT of layers and render them after the presentation pass. */
export function withPresentationHudMask<T>(rect: PresentationRect | null, layers: readonly PresentationHudLayer[], render: () => T, captionRegion?: PresentationRect): T {
  if (!rect) return render();
  const previous = new Map<PresentationHudLayer['target'], boolean>();
  for (const layer of layers) {
    if (previous.has(layer.target) || !(presentationRectsOverlap(rect, layer.bounds)
      || (captionRegion && presentationRectsOverlap(captionRegion, layer.bounds)))) continue;
    previous.set(layer.target, layer.target.visible);
    layer.target.visible = false;
  }
  try { return render(); }
  finally { for (const [target, visible] of previous) target.visible = visible; }
}
