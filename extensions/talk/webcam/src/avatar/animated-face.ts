import * as THREE from 'three';
import type { SceneConfig } from '../shared/scene-config';
import type { HudTalkPreflight } from '../shared/hud-data';
import type { SpeechAudioFrame } from '../shared/audio';
import { createTalkReadiness } from '../shared/live-projection';
import { createRobotPreflight } from './robot-preflight';
import { mouthVisualTargets } from './mouth-visual';
import { WorldResources, mesh } from './materials';

function audioLevel(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function surface(uCount: number, vCount: number, point: (u: number, v: number) => THREE.Vector3): THREE.BufferGeometry {
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let j = 0; j <= vCount; j++) for (let i = 0; i <= uCount; i++) {
    const p = point(i / uCount, j / vCount); positions.push(p.x, p.y, p.z); uv.push(i / uCount, j / vCount);
  }
  for (let j = 0; j < vCount; j++) for (let i = 0; i < uCount; i++) {
    const a = j * (uCount + 1) + i, b = a + uCount + 1;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

function crtMaterial(resources: WorldResources, bootTexture: THREE.Texture, darkBacking: boolean): THREE.ShaderMaterial {
  return resources.material(new THREE.ShaderMaterial({
    uniforms: {
      eyeColor: { value: new THREE.Color('#ffc16b') }, glow: { value: 1.25 }, squint: { value: .55 },
      blink: { value: 0 }, gaze: { value: new THREE.Vector2() }, eyePower: { value: 0 },
      mouthBands: { value: new Float32Array(12) }, mouthGlow: { value: 1.25 },
      bootTexture: { value: bootTexture }, bootActive: { value: 1 }, bootRunning: { value: 0 },
      bootTime: { value: 0 }, bootStep: { value: 0 }, bootCount: { value: 9 },
    },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 eyeColor;
      uniform float glow, squint, blink, eyePower;
      uniform float mouthBands[12], mouthGlow;
      uniform sampler2D bootTexture;
      uniform float bootActive, bootTime, bootStep, bootCount, bootRunning;
      uniform vec2 gaze;
      float eye(vec2 p, float center, out float halo) {
        // A genuinely closed lid emits neither a minimum-height eye nor a halo.
        halo = 0.0;
        if (blink <= .001) return 0.0;
        float h = (0.126 - squint * 0.075) * blink;
        vec2 q = vec2((p.x - center) / 0.123, (p.y - 0.548) / max(h, 0.002));
        float ellipse = length(q) - 1.0;
        // A level heavy upper lid over a shallow lower arc, not circular cartoon eyes.
        float lid = (p.y - 0.544 + (p.x - center) * (center < .5 ? .035 : -.035)) / max(h, .002);
        float d = max(ellipse, lid);
        halo = exp(-max(d, 0.0) * 3.8) * 0.105 * blink;
        return 1.0 - smoothstep(-.035, .045, d);
      }
      void main() {
        vec2 uv = vUv;
        float edge = pow(max(0.0, 1.0 - pow(abs(uv.x - .5) * 1.94, 6.0)), .5)
                   * pow(max(0.0, 1.0 - pow(abs(uv.y - .5) * 1.94, 6.0)), .5);
        float scan = .66 + .34 * sin(uv.y * 790.0);
        vec3 glass = vec3(.007, .013, .014);
        float reflection = exp(-pow((uv.y - .93 + uv.x * .055) * 29.0, 2.0));
        glass += vec3(.012, .021, .024) * reflection * (.2 + uv.x * .8);
        glass += vec3(.013, .017, .018) * pow(uv.y, 4.0) * (1.0 - uv.x) * .7;
        glass *= .94 + .06 * sin(uv.y * 790.0);
        ${darkBacking ? 'glass = vec3(0.0);\n        ' : ''}vec3 light = vec3(0.0);
        if (bootActive > .5) {
          // All boot pixels live in the same UVs, glass and curved mesh as the eyes.
          float text = texture2D(bootTexture, uv).r;
          float x = (uv.x - .075) / .85;
          float inside = step(0.0, x) * step(x, 1.0);
          float cell = floor(x * bootCount);
          float segment = step(.08, fract(x * bootCount)) * step(fract(x * bootCount), .88);
          float band = smoothstep(.205, .211, uv.y) * (1.0 - smoothstep(.255, .261, uv.y));
          float done = 1.0 - step(bootStep, cell);
          float activeCell = 1.0 - step(.5, abs(cell - bootStep));
          float pulse = .62 + .22 * sin(bootTime * 5.0);
          float progress = inside * segment * band * (.10 + done * .72 + activeCell * pulse);
          // A thin routed circuit trace with moving packets; no canvas animation.
          float route = .146 + .009 * clamp((x - .28) * 40.0, 0.0, 1.0)
                               - .009 * clamp((x - .70) * 40.0, 0.0, 1.0);
          float trace = 1.0 - smoothstep(.002, .005, abs(uv.y - route));
          float packet = pow(max(0.0, 1.0 - fract(x * 2.0 - bootTime * .8)), 14.0);
          float circuit = trace * inside * (.18 + packet * .85);
          vec3 phosphor = vec3(.44, .84, .73);
          light = phosphor * (text * 1.35 + (progress + circuit) * bootRunning) * (.85 + scan * .15);
        } else {
          vec2 p = uv - gaze;
          float haloL, haloR;
          float mask = max(eye(p, .268, haloL), eye(p, .732, haloR));
          light = eyeColor * glow * eyePower * (mask * scan * 1.85 + (haloL + haloR) * .36);
          // Frequency-derived mirrored visualizer, not phoneme lip sync.
          // Max of each adjacent real-bin pair preserves peaks without extra gain:
          // bins 0/1 nearest center, then 2/3 ... 10/11 towards both edges.
          // At rest these are a quiet dotted line, never an idle talking animation.
          float mouth = 0.0;
          for (int i = 0; i < 6; i++) {
            float amplitude = max(mouthBands[2 * i], mouthBands[2 * i + 1]);
            float offset = (float(i) + .5) * (.40 / 12.0);
            // Folding x draws both members of each pair at the original spacing.
            vec2 d = abs(vec2(abs(uv.x - .5) - offset, uv.y - .28)) - vec2(.010, .0025 + .064 * amplitude);
            float bar = 1.0 - smoothstep(-.001, .002, max(d.x, d.y));
            mouth += bar * (.26 + .85 * amplitude);
          }
          light += eyeColor * mouthGlow * eyePower * mouth * (.80 + .20 * scan);
        }
        gl_FragColor = vec4((glass + light) * edge, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
}

/** Shared curved phosphor face; no casing, garment, devices or scene wiring. */
export function createAnimatedFace(resources: WorldResources, head: THREE.Group,
  getTalk: (time: number) => HudTalkPreflight, options: { darkBacking?: boolean } = {}) {
  const preflight = createRobotPreflight(resources, getTalk(0));
  const screenMaterial = crtMaterial(resources, preflight.texture, options.darkBacking === true);
  const screenGeometry = surface(48, 32, (u, v) => {
    const y = (v - .5) * 1.17;
    const r = .165, halfW = .9675, halfH = .585;
    const dy = Math.max(0, Math.abs(y) - (halfH - r));
    const maxX = halfW - r + Math.sqrt(Math.max(0, r * r - dy * dy));
    const x = (u * 2 - 1) * maxX;
    return new THREE.Vector3(x, y, .445 + .055 * (1 - (x / halfW) ** 2) * (1 - (y / halfH) ** 2));
  });
  // Surface UVs use physical screen coordinates so scanlines remain straight at curved corners.
  const screenPosition = screenGeometry.getAttribute('position'), screenUV = screenGeometry.getAttribute('uv');
  for (let i = 0; i < screenPosition.count; i++) screenUV.setXY(i, screenPosition.getX(i) / 1.935 + .5, screenPosition.getY(i) / 1.17 + .5);
  mesh(resources, head, screenGeometry, screenMaterial, [0, 0, 0], false);

  let previousEye = '';
  let readyAt: number | null = null, previousTime = -Infinity;
  const readiness = createTalkReadiness();
  const mouthBands = screenMaterial.uniforms.mouthBands.value as Float32Array;
  return {
    update(next: SceneConfig, time: number, audio?: SpeechAudioFrame) {
      // World time is seconds and keeps advancing even when idleIntensity is zero.
      // Never reuse a nominal frame step: attack/release must be frame-rate independent.
      const dt = Number.isFinite(time) && Number.isFinite(previousTime)
        ? Math.max(0, time - previousTime) : 0;
      const rewind = time < previousTime;
      // Cross-process timestamps use epoch ms, not a renderer's performance origin.
      const targets = mouthVisualTargets(audio, Date.now());
      const attack = 1 - Math.exp(-dt / .035), release = 1 - Math.exp(-dt / .145);
      for (let i = 0; i < 12; i++) {
        const target = targets[i];
        const current = rewind ? 0 : mouthBands[i];
        const value = current + (target - current) * (target > current ? attack : release);
        mouthBands[i] = value < .0001 ? 0 : audioLevel(value);
      }
      screenMaterial.uniforms.mouthGlow.value = next.eyeGlowIntensity;
      // Same structured feed as the HUD; no detail-string parsing or readiness latch.
      const talk = getTalk(time);
      readyAt = readiness(talk, time);
      previousTime = time;
      screenMaterial.uniforms.bootRunning.value = talk.active === false ? 0 : 1;
      const loading = readyAt === null;
      const opening = loading ? 0 : THREE.MathUtils.clamp((time - readyAt!) / .9, 0, 1);
      const lidOpening = THREE.MathUtils.smoothstep(opening, 0, 1);
      screenMaterial.uniforms.bootActive.value = loading ? 1 : 0;
      screenMaterial.uniforms.bootTime.value = time;
      screenMaterial.uniforms.bootStep.value = talk.currentStep;
      screenMaterial.uniforms.bootCount.value = Math.max(1, talk.steps.length);
      screenMaterial.uniforms.eyePower.value = THREE.MathUtils.smoothstep(opening, 0, .8);
      if (loading) preflight.update(talk, time);
      if (next.eyeGlowColor !== previousEye) { screenMaterial.uniforms.eyeColor.value.set(next.eyeGlowColor); previousEye = next.eyeGlowColor; }
      const idle = next.idleIntensity;
      // A small phosphor drift, not a flashing/neon effect; the still setting suppresses it.
      screenMaterial.uniforms.glow.value = next.eyeGlowIntensity * (1 + idle * (.023 * Math.sin(time * .73) + .007 * Math.sin(time * 2.1)));
      screenMaterial.uniforms.squint.value = next.eyeSquint;
      // Stable deterministic blinks; a rapid close and slower reopening, every ~6 seconds.
      // Start the idle blink clock after warmup so it cannot interrupt the first opening.
      const eyeAge = readyAt === null ? 0 : Math.max(0, time - readyAt - .9);
      const phase = (eyeAge + 2.3) % 6.7;
      const blinking = phase < .085 ? 1 - phase / .085 : phase < .24 ? (phase - .085) / .155 : 1;
      const idleBlink = Math.max(.035, 1 - (1 - blinking) * Math.min(1, idle * 1.8));
      screenMaterial.uniforms.blink.value = lidOpening * (opening < 1 ? 1 : idleBlink);
      screenMaterial.uniforms.gaze.value.set(Math.sin(time * .41) * .007 * idle, Math.sin(time * .63 + 1) * .003 * idle);
    },
  };
}
