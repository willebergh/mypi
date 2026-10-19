import * as THREE from 'three';
import { WorldResources, canvasTexture } from './materials';

const SERVICES = ['frame queue', 'phosphor pass', 'tile cache', 'sensor replay', 'archive scan', 'clock sync'];
const EVENTS = ['batch complete', 'buffer ready', 'sample verified', 'checkpoint saved', 'cycle complete'];
const CODE = [
  'const frame = workshop.sample();',
  '',
  'function render(frame) {',
  '  const tiles = frame.split(32);',
  '  for (const tile of tiles) {',
  '    phosphor.trace(tile);',
  '    cache.mark(tile.id);',
  '  }',
  '  return screen.present();',
  '}',
];

/** Decorative data only: no shell, telemetry, wall clock, or external IO. */
export function terminalLine(sequence: number, channel: number): string {
  const tick = Math.max(0, sequence);
  const seconds = tick * 3 + channel * 17;
  const stamp = `${Math.floor(seconds / 60) % 60}`.padStart(2, '0') + ':' + `${seconds % 60}`.padStart(2, '0');
  return `${stamp} ${SERVICES[(tick + channel) % SERVICES.length].padEnd(13)} ${EVENTS[Math.floor(tick / 3) % EVENTS.length]}`;
}

export function terminalFrame(time: number, channel: number): number {
  return Math.floor(Math.max(0, Number.isFinite(time) ? time : 0) * 8 + channel * .73);
}

/** Equal CRT panels, different visual languages: logs / telemetry / code + build.
 * Three small canvases, no base texture or mipmaps, at most eight uploads/sec each.
 * Absolute scene time makes preview/output and backwards seeks deterministic.
 */
export function createTerminal(resources: WorldResources, variant: number, channel: number) {
  let context!: CanvasRenderingContext2D;
  const texture = canvasTexture(resources, 512, 320, ctx => { context = ctx; });
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.anisotropy = 1;
  let previousFrame = -1;
  const update = (time: number) => {
    const frame = terminalFrame(time, channel);
    if (frame === previousFrame) return;
    previousFrame = frame;
    const clock = frame / 8;
    const ctx = context;
    const accent = ['#79b794', '#c9a15e', '#8eadd0'][variant];
    ctx.fillStyle = ['#081710', '#19150c', '#0c1423'][variant]; ctx.fillRect(0, 0, 512, 320);
    ctx.fillStyle = accent; ctx.font = 'bold 16px monospace';
    ctx.fillText(['01 / EVENT STREAM', '02 / SYSTEM LOAD', '03 / PHOSPHOR.TS'][variant], 18, 27);
    ctx.fillRect(18, 38, 476, 1);
    if (variant === 0) {
      const scroll = clock * 1.35, sequence = Math.floor(scroll), offset = (scroll - sequence) * 18;
      ctx.save(); ctx.beginPath(); ctx.rect(18, 48, 476, 244); ctx.clip();
      ctx.font = '13px monospace';
      for (let row = 0; row < 15; row++) {
        const index = sequence + row;
        ctx.fillStyle = index % 5 === 0 ? '#b4dbad' : '#619b7a';
        ctx.fillText(terminalLine(index, channel), 18, 63 + row * 18 - offset);
      }
      ctx.restore();
    } else if (variant === 1) {
      // Large meters and a sweeping history trace, not another column of logs.
      for (let i = 0; i < 3; i++) {
        const load = .45 + Math.sin(clock * (.7 + i * .19) + i * 2) * .25;
        const y = 65 + i * 47;
        ctx.font = '14px monospace'; ctx.fillStyle = '#bba77f';
        ctx.fillText(['CPU', 'MEM', 'I/O'][i], 18, y);
        ctx.fillText(`${Math.round(load * 100)}%`, 444, y);
        ctx.fillStyle = '#3c321c'; ctx.fillRect(72, y - 13, 354, 17);
        ctx.fillStyle = accent; ctx.fillRect(72, y - 13, 354 * load, 17);
      }
      ctx.strokeStyle = '#493c23'; ctx.lineWidth = 1;
      for (let y = 191; y <= 281; y += 30) {
        ctx.beginPath(); ctx.moveTo(18, y); ctx.lineTo(494, y); ctx.stroke();
      }
      ctx.strokeStyle = '#b69b58'; ctx.lineWidth = 2; ctx.beginPath();
      for (let x = 0; x <= 476; x += 4) {
        const phase = x * .035 - clock * 1.8;
        const y = 236 + Math.sin(phase) * 25 + Math.sin(phase * 2.3) * 10;
        if (x === 0) ctx.moveTo(18 + x, y); else ctx.lineTo(18 + x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#eed292'; ctx.fillRect(18 + (clock * 65 % 476), 186, 2, 99);
    } else {
      const step = Math.floor(clock * 1.6) % CODE.length;
      ctx.fillStyle = '#22334a'; ctx.fillRect(16, 48 + step * 17, 480, 17);
      ctx.font = '13px monospace';
      CODE.forEach((line, i) => {
        ctx.fillStyle = '#526b8e'; ctx.fillText(`${i + 1}`.padStart(2, '0'), 20, 61 + i * 17);
        ctx.fillStyle = i === 0 || i === 2 ? '#b5a4cf' : '#83a6c9'; ctx.fillText(line, 55, 61 + i * 17);
      });
      const progress = clock % 8 / 8;
      ctx.fillStyle = '#253951'; ctx.fillRect(18, 231, 476, 1);
      ctx.fillStyle = '#9fbfda'; ctx.font = '14px monospace';
      ctx.fillText(`BUILD ${Math.floor(clock / 8) + 1} / ${progress < .75 ? 'COMPILE' : 'VERIFY'}`, 18, 254);
      ctx.fillStyle = '#253951'; ctx.fillRect(18, 267, 476, 12);
      ctx.fillStyle = '#739cbf'; ctx.fillRect(18, 267, 476 * progress, 12);
      if (frame % 8 < 4) ctx.fillRect(478, 242, 10, 14);
    }
    ctx.fillStyle = accent; ctx.font = '10px monospace'; ctx.fillText('WORKSHOP / SYNTHETIC FIXTURE / LOCAL', 18, 309);
    ctx.fillStyle = '#00000025';
    for (let y = 0; y < 320; y += 3) ctx.fillRect(0, y, 512, 1);
    const edge = ctx.createRadialGradient(256, 160, 100, 256, 160, 310);
    edge.addColorStop(0, '#00000000'); edge.addColorStop(1, '#00000070');
    ctx.fillStyle = edge; ctx.fillRect(0, 0, 512, 320);
    texture.needsUpdate = true;
  };
  update(0);
  return { texture, update };
}
