# Milestone 4 — Low Signal visual prototype

## Run / operate

```sh
pnpm install
pnpm dev
```

The editor opens with a shared-world CRT robot portrait and an independent 1280×720/30 offscreen renderer. Drag to orbit, wheel to zoom, Shift-drag to pan, **Reset camera** to return to the output hero framing. The right panel changes nine properties live. **Reset look** restores defaults. Scene/output revision indicators show when the hidden renderer has actually rendered a configuration.

**Capture output** saves a PNG through the existing save dialog. **Stop output** destroys only the hidden renderer and drains native GPU work; the editor remains usable. Restart retains the current look. Closing the editor hides it; output continues. Reopen through the application menu/Dock/tray. **Quit** stops both. **Diagnostics** contains the existing native bridge resource/counter/timing information.

No microphone, avatar import, lip sync, camera-extension integration, signing, activation or FaceTime work was added in this pass. All native source/signing components are unchanged. Existing Forge hooks still compile/bundle their existing components when building the app, but never sign or install them automatically.

## Reference grounding / visual implementation

Both supplied images were directly inspected and copied into:

- `references/robot_reference.png`
- `references/room_reference.png`

The procedural assets use no source-image pixels or copied branding/UI. The direction is the worn CRT housing, fabric hood, dark curved glass, downcast amber eyes, a warm left-side practical and cool workstation depth. The room contains concrete formwork/pillars, overhead beams/pipes, multiple terminal/map/graph monitors, desk/keyboard, books, mug, equipment towers, cables and a worn floor/rug. No external models/textures, generated images, Blender assets, fonts, postprocessing framework or asset pipeline were introduced.

The robot has rounded layered casing, a curved shader-driven screen, scanlines, glass highlights, wear, fasteners, mechanical neck/chest support, custom hood surfaces, seams, drawstrings, shoulders and fabric folds. Blinks, eye drift, head sway/tilt, breathing and glow variation remain restrained. Static workshop meshes are merged by material; only one light casts a 1024² shadow map. All geometry/material/texture ownership is scoped to one world and explicitly disposed.

### Ownership

- **Astra (`gpt-6-astra`)** inspected the references and built `world.ts`, `robot.ts`, `room.ts`, `materials.ts`: character geometry, procedural materials/textures, workshop, lighting and hero composition. It iterated on wear, eye shape, hood silhouette, batching and render readability.
- **Luna (`gpt-6-luna`)** compared actual renders against the references, identified thin eyes/uniform wear/hood and lighting weaknesses, then reviewed Astra's revised shot. Its final polish moved the cool fill obliquely and reduced broad ambient fill without adding lights/shadows/postprocessing.
- **Lead (`gpt-6.1-sol`)** implemented the editor, shared renderer wrapper, settings/IPC synchronization, resource lifetime integration, input/security/performance verification and final visual inspection. The preview limiter preserves phase, so a high-refresh display does not quantize a nominal 60 FPS preview down to 48 FPS.

## Shared rendering architecture

```text
React settings ── coalesced typed/validated SceneConfig ── Electron main
       │                                                  │
       │                             current config + revision broadcast
       ▼                                                  ▼
Visible createScene(editor)                       Hidden createScene(output)
  OrbitControls                                    Fixed hero camera
         └────────── createWorld(config) ──────────────────┘
                             │
                      same scene builders
                                                paint IOSurface → Metal
```

- `src/shared/scene-config.ts`: defaults, ranges, validation, `SceneConfig`, `SceneState`.
- `src/avatar/world.ts`, `robot.ts`, `room.ts`, `materials.ts`: one Electron-independent world implementation, deterministic static assets, update/dispose methods.
- `src/avatar/scene.ts`: renderer, sizing, timing, interactive/fixed camera selection and disposal. Preview is capped at 60 FPS; output at 30 FPS with Electron frame-rate control. Pixel ratio is 1; preview preserves a 16:9 frame and resizes through `ResizeObserver`.
- `src/ui/ScenePreview.tsx`, `useSceneConfig.ts`: one mounted world, immediate local edits with coalesced ~33 ms IPC flushes, no scene reconstruction for settings.
- `src/main/index.ts`, preload: authoritative validated config/revision. Editor alone can mutate; hidden output alone can acknowledge a rendered revision. Both can read. Sender main-frame checks and bounded numeric/RGB validation reject malformed or unauthorized requests.
- `src/output/main.ts`: the same scene wrapper, fixed camera, preload subscription and render acknowledgements. Acknowledgement broadcasts do not resubmit unchanged revisions (avoids an IPC/render feedback loop).

Each renderer process necessarily owns a separate Three.js world/GPU resource set; the **implementation and configuration** are shared, not a JS object transported between processes. Idle clocks begin independently, so preview/output are not frame-phase synchronized. Orbit never changes the output camera. Config survives output stops/starts, but is currently in-memory and resets on app quit.

The Metal addon and its one-job/zero-waiting-frame bound are unchanged. Continuous frames remain GPU-only; explicit PNG/debug readbacks are exceptions. Editor background throttling is left enabled so a hidden editor does not waste preview work; the separate output still disables background throttling.

## Actual verification / screenshots

```sh
pnpm typecheck
pnpm native:test
VERIFY_ARTIFACT_DIR=artifacts/milestone4-development pnpm verify
pnpm package
VERIFY_ARTIFACT_DIR=artifacts/milestone4-packaged \
  "out/pi-talk-webcam-darwin-arm64/pi-talk-webcam.app/Contents/MacOS/pi-talk-webcam" --verify
```

The final development and packaged suites exercise real browser pointer input for orbit/zoom/reset and the squint slider; all nine settings then change via typed IPC and are acknowledged after output render. The test checks the output WebContents ID never changes across customization, and restores the default shot. It also rejects invalid/out-of-range/unauthorized IPC, measures visible/hidden/minimized/closed operation, compares actual native source/destination readbacks, repeats eight starts/stops, stops during an in-flight submission, checks drained resources/window counts, and verifies bitmap fallback and explicit Quit. Expected invalid-IPC error lines appear in test logs; these are deliberate rejection checks, not unexpected runtime failures.

The packaged run includes a 30-second closed-editor soak. The final development run uses a 10-second soak. These are short regression runs, not a multi-hour memory audit. Native source/destination pixel comparisons passed on both debug frames; changing hashes show actual animation, not placeholders.

Final packaged screenshots were opened and visually inspected:

- **Editor UI:** `evidence/milestone4-packaged/editor.png`
- **Preview scene:** `evidence/milestone4-packaged/preview-scene.png`
- **Hidden hero output:** `evidence/milestone4-packaged/output-hero.png`
- **Native Metal result:** `evidence/milestone4-packaged/native-metal-1.png` / `native-metal-2.png`
- **Live custom look:** `evidence/milestone4-packaged/output-custom.png` / `editor-custom.png`
- **Actual narrow-eye slider:** `evidence/milestone4-packaged/output-squint.png`
- **Bitmap fallback:** `evidence/milestone4-packaged/output-bitmap.png`

First iterations hit a cold Vite dependency-reload/blank-editor issue and an unreliable unfocused synthetic drag. The final code prebundles both renderer pages, permits only same-document-URL reloads, and explicitly focuses the test WebContents with correct held-button modifiers. Final browser-input checks pass. A temporary test-only debugger startup wait also stalled a run; it was removed before the successful final suites. None of these failures is counted as a visual or performance success.

## Measured performance — Apple M4 / macOS ARM64

Final packaged run, default scene, both renderers active during the visible interval:

| Measurement | Result |
| --- | --- |
| Preview (actual sampled rate) | **59.95 FPS** |
| Preview draw calls / triangles | **61 / 211,008** (includes shadow work in Three.js counters) |
| Hidden output, native enabled, visible editor | **29.99 FPS** |
| Hidden output, editor minimized / hidden / closed | **29.99 / 29.99 / 29.99 FPS** |
| Native processed frames, three closed-editor soak samples | **30.00 / 30.00 / 29.80 FPS** |
| Bitmap output, editor visible / hidden / closed | **29.99 / 29.99 / 29.99 FPS** |
| Native CPU submission, visible interval | **0.235 ms/frame** |
| Native GPU copy, visible interval | **0.087 ms/frame** |
| Main-process paint → native callback, visible interval | **0.814 ms/frame** |
| Main CPU, bridge disabled → enabled | **0.85% → 2.26% of one logical core** |
| Main RSS, bridge disabled → enabled | **128.0 → 142.8 MiB** |

The full shared/native session received 2,091 frames, processed 2,051, dropped 40 under its bounded policy, and had zero native failures/ordering errors. No continuous debug readbacks occurred during the soak. All tracked source/destination resources were zero after each drain; these counters are not a proof that driver caches or every possible allocation never leak.

Exact per-process CPU, RSS, FPS, camera poses, settings/revisions, native timings and cleanup data: `evidence/milestone4-packaged/verification.json` and `evidence/milestone4-development/verification.json`. Native GPU-copy timing is **not** Three.js GPU shading time; no total GPU-utilization figure or render-to-camera latency is claimed. Sequential baseline/bridge snapshots are not a statistically controlled benchmark. Frame-count windows can straddle an in-flight completion, hence processed FPS can briefly exceed paint FPS by one boundary frame.

## First-prototype limitations / next visual iteration

- It is visibly procedural: hood folds and torso silhouettes still need tailoring, casing wear is repeated procedural detail rather than authored edge damage, and the room is more orderly/less organically cluttered than the reference.
- No depth of field, true volumetric lighting, screen-space AO or physically simulated cloth; small scanline/fabric detail can alias at preview resolution. Stronger lamp haze and softer foreground/background separation are good next look-development targets, not claims of reference-level photorealism.
- Hero framing is composition-first; extreme orbit angles expose simplified/backside geometry and room boundaries. There is no collision camera.
- Color/tint/wear controls are prototype material controls, not a full material editor. Config persistence, presets and undo are not yet implemented.
- PNG generation/filesystem writes and captures are automated; the native save-dialog click path is still manual. Other OSes, Retina/high-DPI rendering policy beyond pixel ratio 1, display sleep and long-duration GPU memory behavior remain unverified.

**Recommended next iteration:** review these shots with the user, tune hood/neck proportions and casing wear, add a little more asymmetrical room clutter and controlled atmospheric separation, then add saved look presets. Do not connect this scene to the camera extension until that separate milestone is explicitly resumed.
