# Preserved artifact checks

Imported from the original project's ignored `artifacts/` sources. These are focused historical fixtures, not a full regression suite. Imports now resolve from this directory. No generated renderer or duplicate compiled TS helpers are checked in.

## Build without launching anything

Install this webcam package's existing dependencies first (Vite, Electron and Three.js). From `extensions/talk/webcam`:

```sh
node test/artifact-checks/run.mjs all --build-only
# Or build just one fixture:
node test/artifact-checks/run.mjs speech-mouth-check --build-only
```

The runner uses the existing **Vite build API**, no direct esbuild dependency or dev server. It disables project Vite config loading and builds CJS Electron entries plus an IIFE renderer. It copies `hud-capture.html` alongside `hud-capture-renderer.js` under ignored `artifacts/artifact-checks/`; the HTML script reference works with `file://`. The aspect check also builds the actual `src/preload/index.ts` beside its entry. Builds never launch Electron or load native addons.

## Standalone hoodie asset preview

`node test/artifact-checks/hoodie-capture.mjs [--build-only]` is a separate asset-only fixture, independent of `run.mjs` and the application/world factories. It captures front/three-quarter/back plus boot/blink/synthetic mouth into ignored `artifacts/hoodie-preview/`, with separate Electron user data and denied permissions. No active scene wiring, app restart, camera output or real audio. See [the factory contract](../../docs/hoodie-character.md).

## Explicit opt-in execution

Run one named fixture (omit `--build-only`). The runner first rebuilds it, sets the working directory to the webcam package, then launches only that fixture. There is deliberately no execute-all mode.

```sh
node test/artifact-checks/run.mjs hud-capture
node test/artifact-checks/run.mjs hud-close-check
node test/artifact-checks/run.mjs speech-mouth-check
node test/artifact-checks/run.mjs aspect-resize-smoke
node test/artifact-checks/run.mjs closed-pipe-smoke
```

- **character-capture**: `node test/artifact-checks/run.mjs character-capture` hot-switches Robot/Hoodie in Workshop/Desk, landscape/portrait, HUD off with synthetic ready telemetry/speech. Writes eight PNGs and `capture.json` to `artifacts/character-preview/`. Separate fixture user data, denied permissions, no app main/preload/native adapters or user-app restarts. See [character selection](../../docs/hoodie-character.md).
- **desk-capture**: `node test/artifact-checks/run.mjs desk-capture` captures the distinct desk scene in landscape/portrait with HUD off/dashboard; writes `artifacts/desk-preview/`. Reuses the hidden renderer with synthetic data, no audio/camera.
- **hud-capture**: hidden Electron/Three.js GPU captures and HUD assertions; writes `artifacts/hud-preview/`.
- **hud-close-check**: hidden Electron GPU captures and panel lifecycle assertions; writes `artifacts/hud-preview/closing-checks.json` and closing PNGs.
- **speech-mouth-check**: hidden Electron GPU captures using synthetic numerical speech fixtures only; writes `artifacts/speech-mouth/`. Does not open audio streams, request permissions, or load the audio addon.
- **aspect-resize-smoke**: macOS/Electron shared-texture/Metal fixture using animated 2D canvas, not a camera. Requires an already-built Electron-compatible `native/macos/build/Release/bridge.node` (see the webcam/native build instructions). Writes `artifacts/aspect-resize-smoke.json`. The runner does not build native code. `VC4M_OUTPUT=1` is rejected for Electron checks so these commands cannot opt into camera publication.
- **closed-pipe-smoke**: unique preserved CJS snapshot of the historical logging fixture, not a regeneration of current `src/main/logging.ts`. Node-only; no Electron/Vite needed when selected alone. The runner closes stdout/stderr readers, requires exit zero, and checks the persisted error marker in `artifacts/closed-pipe-smoke/main-errors.log`. The previous log is removed first.

GPU fixtures require a working graphical macOS session/GPU; they intentionally create hidden Electron windows. None of these commands installs/activates a camera or enables real audio. Only run them deliberately. Assertion/runtime failures return nonzero. Success is not evidence of live speech, FaceTime compatibility, signing, or camera operation.

Fresh output always goes to ignored `artifacts/`, never to [preserved evidence](../../docs/evidence/README.md). Re-running can overwrite prior runtime captures. The preserved evidence records the original machine's results and must not be mistaken for a new run here.

Package-script shorthand: `pnpm artifact:check all --build-only` or `pnpm artifact:check closed-pipe-smoke`.
