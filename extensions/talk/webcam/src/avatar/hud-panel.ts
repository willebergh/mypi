// Shared render-only visual language for telemetry and explicit presentations.
export const CYAN = '#6cddff';
export const BRIGHT = '#c9f5ff';
export const MUTED = '#83aebd';
export const AMBER = '#ffc477';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const OPEN_DURATION = 1.08;
export const CLOSE_DURATION = 0.62;

/** Leaves the chamfer path available for callers that clip interior ink. */
export function paintHudGlass(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const fill = ctx.createLinearGradient(0, 0, w, h);
  fill.addColorStop(0, 'rgba(4, 20, 29, 0.88)');
  fill.addColorStop(1, 'rgba(4, 15, 23, 0.65)');
  ctx.beginPath();
  ctx.moveTo(12, 2); ctx.lineTo(w - 12, 2); ctx.lineTo(w - 2, 12);
  ctx.lineTo(w - 2, h - 12); ctx.lineTo(w - 12, h - 2);
  ctx.lineTo(12, h - 2); ctx.lineTo(2, h - 12); ctx.lineTo(2, 12); ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = 'rgba(108, 221, 255, 0.7)';
  ctx.shadowColor = '#21b9f6'; ctx.shadowBlur = 6; ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Fixed-size quads: GPU clipping animates the opening, never text scale.
export const PANEL_VERTEX = `
  varying vec2 vHudUv;
  void main() {
    vHudUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
export const PANEL_FRAGMENT = `
  uniform sampler2D map;
  uniform vec2 size;
  // Logical card / fixed backing raster; (1,1) for telemetry panels.
  uniform vec2 mapScale;
  uniform float visibleHeight;
  uniform float opening;
  uniform float opacity;
  uniform float strip;
  uniform vec3 cyan;
  varying vec2 vHudUv;
  void main() {
    // Keep UVs in backing-raster pixels while only visible card bounds reflow.
    vec2 pixel = vec2(vHudUv.x, 1.0 - vHudUv.y) * size;
    vec2 bounds = vec2(size.x, visibleHeight);
    if (visibleHeight < 4.0 || pixel.y > visibleHeight) discard;
    vec2 q = pixel - bounds * 0.5;
    vec2 halfSize = max(bounds * 0.5 - 2.0, vec2(0.5));
    vec2 edge = abs(q) - halfSize;
    float distance = max(max(edge.x, edge.y), (edge.x + edge.y + 10.0) * 0.707107);
    float inside = 1.0 - smoothstep(-0.5, 0.5, distance);
    vec2 inkUv = vec2(vHudUv.x * mapScale.x, 1.0 - (1.0 - vHudUv.y) * mapScale.y);
    vec4 ink = texture2D(map, inkUv);
    ink.a *= inside;
    if (opening >= 1.0) {
      gl_FragColor = vec4(ink.rgb, ink.a * opacity);
    } else if (strip > 0.5) {
      // Reveal only the strip's ink: no transient glass or card perimeter.
      float reach = smoothstep(0.0, 1.0, opening) * (size.x * 0.5 + 2.0);
      float reveal = 1.0 - smoothstep(reach - 2.0, reach, abs(vHudUv.x - 0.5) * size.x);
      gl_FragColor = vec4(ink.rgb, ink.a * reveal * opacity);
    } else {
      // First a centered line extends along the top edge.
      float reach = smoothstep(0.0, 0.19, opening) * (halfSize.x - 10.0);
      float ignition = (1.0 - smoothstep(reach, reach + 2.0, abs(q.x)))
        * exp(-abs(pixel.y - 2.0) * 0.85);
      ignition *= 1.0 - smoothstep(0.24, 0.42, opening);

      // Twin tracing heads sweep down the chamfered perimeter.
      float angle = abs(atan(q.x / halfSize.x, -q.y / halfSize.y)) / 3.141593;
      float trace = smoothstep(0.14, 0.62, opening);
      float traced = 1.0 - smoothstep(trace, trace + 0.025, angle);
      float stroke = exp(-abs(distance) * 1.8) + 0.17 * exp(-abs(distance) * 0.35);
      float head = exp(-abs(angle - trace) * 85.0) * step(0.15, opening);
      float border = stroke * traced * (0.65 + head * 0.65);

      // Glass unfolds before a separate scan reveals unchanged text.
      float glassY = smoothstep(0.32, 0.74, opening) * (bounds.y + 8.0);
      float glass = inside * (1.0 - smoothstep(glassY - 8.0, glassY, pixel.y));
      float revealY = smoothstep(0.52, 1.0, opening) * (bounds.y + 8.0);
      float reveal = 1.0 - smoothstep(revealY - 8.0, revealY, pixel.y);
      float scan = exp(-abs(pixel.y - revealY) * 0.75) * inside
        * step(0.52, opening) * (1.0 - smoothstep(0.94, 1.0, opening));
      float light = clamp(border + ignition + scan * 0.4, 0.0, 1.0);
      float stageAlpha = max(glass * 0.65, light);
      vec3 stageColor = mix(vec3(0.003, 0.012, 0.02), cyan, light);
      float inkAlpha = ink.a * reveal;
      // Hand off to the original canvas chamfer glow without an extra draw.
      stageAlpha *= 1.0 - smoothstep(0.82, 1.0, opening);
      float alpha = inkAlpha + stageAlpha * (1.0 - inkAlpha);
      vec3 color = (ink.rgb * inkAlpha + stageColor * stageAlpha * (1.0 - inkAlpha)) / max(alpha, 0.0001);
      gl_FragColor = vec4(color, alpha * opacity);
    }
    #include <colorspace_fragment>
  }
`;
