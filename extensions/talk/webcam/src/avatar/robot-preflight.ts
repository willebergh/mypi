import * as THREE from 'three';
import type { HudTalkPreflight } from '../shared/hud-data';
import { WorldResources } from './materials';

/** A small text-only phosphor mask, sampled by the physical curved CRT material.
 * Progress, scanlines and circuit motion stay on the GPU, never on this canvas.
 */
export function createRobotPreflight(resources: WorldResources, initial: HudTalkPreflight) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 288;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Robot preflight requires a 2D canvas context');
  const texture = resources.texture(new THREE.CanvasTexture(canvas));
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // White-on-black data mask: no color-space conversion needed.
  let lastDraw = -Infinity, lastKey = '';

  function update(talk: HudTalkPreflight, time: number) {
    if (talk.readyToAnswer) return;
    const current = Math.max(0, Math.min(talk.steps.length - 1, talk.currentStep));
    const label = talk.steps[current]?.label ?? 'Preparing voice';
    const key = `${talk.source}/${talk.active}/${talk.audioEnabled}/${current}/${talk.steps.length}/${label}`;
    // A rewind permits a fresh boot; otherwise uploads are strictly <= 4 Hz.
    if (time < lastDraw) { lastDraw = -Infinity; lastKey = ''; }
    if (key === lastKey || time - lastDraw < .25) return;
    lastDraw = time; lastKey = key;
    const draw = ctx!;
    draw.fillStyle = '#000'; draw.fillRect(0, 0, 512, 288);
    draw.fillStyle = '#fff'; draw.textAlign = 'center'; draw.textBaseline = 'middle';
    draw.font = 'bold 32px monospace';
    draw.fillText(talk.source === 'mock' ? 'MOCK / BOOT' : talk.source === 'offline' ? 'LIVE / OFFLINE' : talk.active ? 'LIVE / VOICE' : 'LIVE / IDLE', 256, 38);
    draw.font = 'bold 27px monospace';
    if (talk.active !== false) draw.fillText(`STEP ${String(current + 1).padStart(2, '0')} / ${String(talk.steps.length).padStart(2, '0')}`, 256, 79);
    draw.font = 'bold 32px monospace';
    const lines: string[] = [];
    let line = '';
    for (const word of label.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && draw.measureText(candidate).width > 448) { lines.push(line); line = word; }
      else line = candidate;
    }
    if (line) lines.push(line);
    const lineHeight = 35;
    lines.forEach((text, index) => draw.fillText(text, 256, 139 + (index - (lines.length - 1) / 2) * lineHeight, 448));
    draw.font = 'bold 22px monospace';
    draw.fillText(talk.source === 'mock' ? 'AUDIO OFF / NO ANSWER' : talk.audioEnabled ? 'AUDIO ON / READ ONLY' : 'AUDIO OFF / READ ONLY', 256, 262);
    texture.needsUpdate = true;
  }
  update(initial, 0);
  return { texture, update };
}
