# Editor vs camera-source output

## Controls

The workspace defaults to **Output** (an already selected view remains local UI state):

- **EDITOR** is the interactive Three.js view. Drag/orbit, zoom, and Shift+drag/pan here.
- **OUTPUT** samples the **actual hidden output renderer**, not a third scene or a second approximation. This is the source image passed to camera transport, before any receiving application processing.
- **Output / Editor / Both** changes the visible layout; Both is an explicit comparison option. The editor remains mounted, so switching views or inspector sections does not reset its camera or restart the robot. Reset camera and orbit hints appear only with Editor.

**Format** and **Output framing** sit beside the workspace preview, separate from the Scene / Character / Overlay inspector. Under **Output framing**:

- **Fixed hero** (default): webcam output uses the hero preset; editor orbit stays local.
- **Follow editor**: output follows editor position, target and field of view as you orbit/zoom/pan, up to 20 camera updates/sec.
- **Use current view**: captures the editor's current framing as a custom output camera. Later editor movement does not affect it; robot/HUD/audio animation continues. This is not a frozen video frame.

Aspect ratio and appearance controls still apply to both. A saved custom pose is retained when aspect changes; the new aspect crops that camera's view. Hero mode uses its orientation-specific preset. Output restarts retain the selected framing for the app session; app launch starts in Fixed hero. No persistent camera preset file was added.

Restart Electron once for the new main/preload IPC. Old backend detection shows a single restart notice rather than repeatedly invoking unknown handlers. No camera-extension rebuild or activation change is needed for these controls.

## Why the views differed

Previously, the editor had an independently orbitable camera while output always used the fixed hero camera. Both also own separate animation clocks/renderers, so mock runtime/boot/idle phases need not be pixel-identical. Follow editor synchronizes **framing**, not the entire editor framebuffer or simulation clocks. The actual output monitor removes the ambiguity about the source image.

This monitor does **not** show what FaceTime itself displays after cropping, mirroring, scaling, caching or other receiver processing. It also is not a readback of a camera extension's final destination buffer. Native transport failures remain visible in existing diagnostics; a healthy source monitor alone is not proof a receiving app is consuming it.

## Cost / transport

`OffscreenRenderer.previewFrame()` uses a bounded pull readback:

- Maximum 4 samples/sec, one capture in flight, cached responses inside the rate interval.
- Long edge at most 640 px, JPEG quality 75; original width/height and frame-count metadata accompany the thumbnail.
- Polling only when the output panel intersects the viewport and the editor document is visible. Main also rejects monitoring while the editor is hidden/minimized.
- Stop, error, visibility loss and aspect changes clear stale images. Lifecycle epochs discard in-flight old-window/old-size captures.
- Shared-texture mode uses `webContents.capturePage()`; bitmap mode reuses the current output `NativeImage`. Resize happens after capture because Electron's capture API has no resize option.

This sampled monitor adds CPU/readback/encoding work only for monitoring. The continuous camera path is still the existing IOSurface → Metal owner/release pipeline, with no per-camera-frame PNG/JPEG readback added. Camera transport stays at its existing 30 FPS target; the monitor is labeled sampled 4 FPS. A future GPU monitor transfer could avoid readback, but Electron's experimental shared-texture transfer needs separate lifetime/ownership validation and was not introduced here.

## Implementation

- `src/shared/output-view.ts`: typed camera pose/view/monitor DTOs and finite bounded pose validation.
- `src/main/output-view.ts`: source mode and revision state; editor-pose messages affect output only in Follow editor.
- `src/main/index.ts`: editor-only mutation/monitor IPC, output-readable view state, visibility gate and broadcasts.
- `src/avatar/scene.ts`: pose get/apply, throttled dirty-camera callbacks, hero restore and preserved overrides across aspect updates.
- `src/ui/ScenePreview.tsx`: sends changed editor poses, never creates an extra output world.
- `src/output/main.ts`: consumes the selected pose for the existing hidden scene, including on renderer restart.
- `src/ui/{OutputMonitor,OutputViewControls}.tsx`: visibility-gated monitor and source controls.

No `mypi`, audio capture, FaceTime call lifecycle, signing, camera installation, or native Metal source was changed for this feature.

## Focused validation (historical, before the editor layout refactor)

The source-only editor layout refactor has not been tested, checked, built or visually verified; no app launches/restarts or live probes were performed for it. The renderer-only changes do not require new backend IPC. Existing older-backend guards remain.

For the original monitor implementation, `pnpm typecheck` passed. One isolated hidden UI/output harness exercised the real new UI, preload, output renderer, monitor and framing controller in **bitmap mode with native camera/audio disabled**. It checked actual output position after real mouse orbit events, independent saved framing, hero restore, thumbnail caching and portrait resize.

The first run exposed a test observation issue (camera position statistics sampled at 1 Hz lagged damping); output pose diagnostics now also update immediately after applying a pose. The rerun passed all checks with no renderer errors. A nonfatal macOS task-policy diagnostic appeared at teardown. No full app build/regression suite or receiver-side FaceTime test was run.

Artifacts, opened and inspected:

- `evidence/dual-view/both-landscape.png`
- `evidence/dual-view/follow-editor.png`
- `evidence/dual-view/saved-framing.png`
- `evidence/dual-view/both-portrait.png`
- `evidence/dual-view/checks.json`

This completes todo #12's dual preview and camera-framing controls, not receiver-side crop inspection or a new Metal performance benchmark.
