# Optional VirtualCamera4Mac output

Optional integration with an additive native adapter and a small opt-in loader change in `src/main/native-bridge.ts`. No scene, character, editor-layout, or in-house camera extension files are changed. The later FaceTime sync adds narrowly scoped main/preload/shared-type wiring and edit-intent tracking in the existing studio hook. `output.html` now uses a responsive viewport/body instead of fixed 1280×720 CSS, which previously clipped portrait frames before capture. The coordinating user explicitly waived the original Git-worktree requirement because this directory has no Git repository. No Git history was created and no other agent's files were committed.

## FaceTime aspect synchronization

Normal macOS app runs now follow the existing Swift controller's video-layout socket and send a guarded rotation for explicit studio aspect edits. See [FaceTime ↔ studio aspect sync](../../../docs/facetime-aspect-sync.md) for setup, behavior, safety, tests and limitations. `FACETIME_ASPECT_SYNC=0` disables this optional connection. The standalone cube CLI does not connect to the FaceTime socket.

## Publish the actual editor/robot output

Stop the separate cube producer first, quit the currently running development app, then launch from the project root:

```sh
VC4M_OUTPUT=1 pnpm dev
```

Both **16:9 Landscape / 1280×720** and **9:16 Portrait / 720×1280** sources are supported. Portrait is GPU-scaled to a centered 405×720 image with black sidebars inside the backend's fixed 1280×720 camera frame; it is not a negotiated portrait camera format. Switch aspect in the existing editor. After upgrading the native addon, fully quit/restart the app to load the new binary (a renderer reload is insufficient). Leave backend **Flip (vertical)** unchecked for upright output unless an intentional flip is wanted. The existing hidden offscreen renderer now publishes directly to VirtualCamera4Mac; editor close/hide does not stop that renderer. `NativeBridge` remains the only owner of Electron's texture release callback and waits for camera GPU completion. Normal camera frames avoid the original extra private-texture copy; explicit debug readback requests still use the existing Metal bridge before publication. Without `VC4M_OUTPUT=1`, the original backend is unchanged. This opt-in loader currently supports development, not packaged builds.

The user confirmed the cube in Photo Booth/FaceTime and subsequently confirmed the actual scene working after this connection was added. An additional automated actual-scene run received changing BGRA frames with the editor visible, minimized and closed/hidden. Its later stop/start receiver check was inconclusive (1080p NV12 standby rather than expected 720p BGRA); full automated app restart verification is not claimed. Use a full producer app restart if necessary. Camera-client format negotiation remains an upstream limitation.


## Build and run

From the project root, using already installed project dependencies and Xcode/CLT:

```sh
node native/macos/vc4m/build.mjs
node --test native/macos/vc4m/output.test.cjs
node_modules/.bin/electron native/macos/vc4m/run.cjs
```

The final command continuously publishes the existing `src/avatar/cube.ts` from a hidden, independent Electron offscreen window. It does **not** launch or depend on the editor. Ctrl-C stops painting, drains the GPU job, stops/disconnects the sink, and destroys the source window. Start the command again to restart. No Homebrew installation, extension activation, signing, or security changes are performed by these commands.

Finite automated integration test (starts a separate CMIO receiver, tests stop/disconnect/reconnect/restart):

```sh
node_modules/.bin/electron native/macos/vc4m/run.cjs --verify --seconds 15
```

Results go to `build/last-run.json`, `build/receiver-last.json`. Rebuilding replaces `build/`. The bounded diagnostic receiver performs sparse CPU reads; the producer never maps/reads pixels. Receiver alone: `native/macos/vc4m/build/receive 5` (exit 0 = changing image with contrast; 2 = inconclusive, including static standby; 1 = error). A moving hash is evidence of animated frames, not mathematical recognition of the cube.

## Manual FaceTime check — pending

1. Run the continuous producer command above and wait for `acceptedLastSecond: 30` (startup may be slower).
2. Open FaceTime. Choose **Video → Camera → VirtualCamera4Mac** (on versions with an ungrouped Video menu, select VirtualCamera4Mac directly). Allow FaceTime camera access if macOS prompts.
3. Confirm a continuously rotating cube, not static colored standby bands. Start a test call to verify the remote image as well.
4. Minimize/close the **separate editor** while leaving this producer running. Motion should continue; this CLI owns its own hidden source window. Do not quit this producer's Electron process.
5. Ctrl-C the producer: the backend should return to its standby bands. Rerun the command: animation should resume. Confirm both local preview and remote call.

**The user manually confirmed FaceTime output after the cube verification.** The automated receiver alone does not establish FaceTime compatibility; that confirmation is from the user's live test.

## Installation / approval

The installed `/Applications/VirtualCamera4Mac.app` and embedded extension were inspected: Developer ID team `9U26G7YWJ9`, notarization ticket on the app, bundle version `1.0/1`. After the user approved activation, `systemextensionsctl list` showed `[activated enabled]`, and CMIO discovery found the expected UID. Nothing in the signed bundle was modified.

If missing, install manually (only with user approval):

```sh
brew install --cask m96-chan/tap/virtualcamera4mac
```

Keep the app in `/Applications`. Launch it, use its menu-bar **Install / Activate**, approve under **System Settings → General → Login Items & Extensions → Camera Extensions**, and restart only if macOS requests it. Keep SIP enabled. The external unsandboxed producer does not require the extension's Team ID, App Group or installation entitlement. This build/run succeeded without a paid developer identity or special producer entitlement. A future sandboxed/distributed application needs its own policy/signing review; those claims are not generalized here.

## Interface

`output.cjs` exports `VirtualCameraOutput`, independent of the scene/editor:

```js
const { VirtualCameraOutput } = require('./native/macos/vc4m/output.cjs');
const output = new VirtualCameraOutput();
output.discover(); // { available, device, sink }
output.connect();
output.start();
// In a TRUSTED main-process paint handler:
// output.consume(event.texture, sequence);
// Ownership is transferred to consume: caller MUST NOT also release texture.
// Stop painting first, then:
await output.stop();
await output.disconnect();
```

Native `build/Release/vc4m.node` exposes `discover`, `connect`, `start`, `submit(handle,width,height,pixelFormat,sequence)`, `stop`, `status`, `disconnect`. `submit` is a Promise; synchronous validation errors throw. Stop/disconnect require the Promise to be drained. Status includes connection/liveness, publishing, in-flight job, accepted/dropped counts, allocation count and last native transport error. Wrapper status adds admission state, JS-busy drops, releases and errors. It stops admitting after an error; reconnect explicitly after draining.

Inputs support **1280×720 landscape or 720×1280 portrait, packed BGRA at 30 FPS**. Camera output remains **1280×720 BGRA**. Landscape uses the existing exact GPU blit; portrait uses a linear-filtered Metal aspect-fit render pass with opaque-black pillars, preserving all content and orientation. Other formats/dimensions are rejected. Native `status()` reports source/output dimensions and `scaleMode`. Arbitrary handle pointers are unsafe: accept only trusted process-local Electron `ioSurface` Buffers. Never expose this API or handle bytes through preload/renderer IPC.

## Ownership and synchronization

- At most one native GPU job and zero queued JS frames. Busy input is dropped and its Electron texture released immediately.
- Native synchronously retains/imports the Electron IOSurface, validating dimensions, format, stride and allocation. The JS texture/release closure remains held until the native Promise settles.
- Allocate a **fresh IOSurface-backed CVPixelBuffer per accepted transfer**, then one Metal GPU-to-GPU blit (landscape) or GPU aspect-fit render pass (portrait). No continuous CPU readback, PNG encoding or compression. Wait for Metal completion on a libuv worker before publishing. Native source references are destroyed before Promise settlement; only then is Electron's release called.
- Fresh storage is intentional: no output surface is ever written a second time. This avoids treating sink dequeue/scheduled-output notifications as downstream completion. Allocation throughput is about **3.52 MiB/frame / 105 MiB/s at 30 FPS**, excluding padding/metadata; this is not resident-memory growth. Pool reuse is a future optimization requiring an audited cross-process reuse contract.
- Create a host-clock CMSampleBuffer with duration `1/30`. Its create-rule +1 transfers to CMIO on successful enqueue; release it locally on failure. Do not drain/release successfully transferred producer tokens on disconnect: transport owns them. Output pixel storage remains alive through framework ownership independently of our local CVPixelBuffer reference.
- Backpressure drops **new** frames when full, before allocating/copying where possible. Non-full enqueue failures are errors, not ordinary drops.
- Sink callback has no state/refcon and is safe against late calls. Disconnect stops and unregisters it, releases copied queue and GPU objects; errors are retained/reported. Async environment cleanup drains committed GPU work before releasing resources. A hypothetical Metal wait exception is retried until terminal GPU status rather than releasing possibly busy storage; irrecoverably stuck GPU work can therefore stall shutdown (fail closed).
- Liveness and device UID are checked before submission and after GPU completion; disappearance rejects/stops admission. No automatic reconnect loop or competing-producer arbitration. Use **one producer at a time**. Physical device removal/extension deactivation was not induced, since that would change system state; rejection/release logic is unit-tested with injected failures.

## Actual upstream API research

Inspected main `05b6f396f23f21ee83dfb465ceccb61eeacfd1f3` and latest release **v0.0.7**, `26f8f2dfb77a898a4e58025bb7779913ef68d35c`. Relevant source blobs match between these revisions. Release source really contains a sink producer; release packaging does not distribute a ready-to-link producer SDK alongside the installed app.

- [Producer implementation](https://github.com/m96-chan/VirtualCamera4Mac/blob/v0.0.7/Sources/Producer/VirtualCameraSink.swift): actual Swift API is `VirtualCameraSink(frameRate:)` and `send(_:presentationTime:)`. README `discover/negotiate/enqueue` pseudocode is **not implemented**. Swift class is not an Objective-C-ready interface; building/embedding Swift frameworks would add dependencies, so this adapter independently uses the same supported CMIO C APIs rather than copying upstream implementation.
- [Identity](https://github.com/m96-chan/VirtualCamera4Mac/blob/v0.0.7/Sources/VirtualCameraCore/VirtualCameraIdentity.swift): enumerate `kCMIOHardwarePropertyDevices`, match `kCMIODevicePropertyDeviceUID` to `B9E1C0F2-6A2E-4B7D-9C3A-2F1E7D4A5C6B`. Our adapter checks `kCMIOStreamPropertyDirection == 0` (CMIO output/sink), unlike upstream's stream-index assumption.
- Connect via `CMIOStreamCopyBufferQueue` with a callback and `CMIODeviceStartStream`. On this device, passing NULL as the initial callback produced no queue: NULL is for unregistering. A process-lifetime no-op callback works.
- [Catalog](https://github.com/m96-chan/VirtualCamera4Mac/blob/v0.0.7/Sources/VirtualCameraCore/FormatCatalog.swift): 720p/1080p, BGRA/NV12 video-range, 30 FPS. Sink ignores producer format setters; there is no genuine producer negotiation. Stick to its default 720p BGRA.
- [Extension](https://github.com/m96-chan/VirtualCamera4Mac/blob/v0.0.7/Sources/Extension/ExtensionProvider.swift): accepts any producer, consumes IOSurface-backed samples directly via CMIO, retains latest image, forwards/repeats with current host-clock timestamps. Identity transform avoids image conversion; optional mirror/flip/rotation uses another buffer and vImage. For minimal copying, leave backend transforms disabled. Standby resumes about one second after stalled arrivals. Source format chosen by consumer does not rescale live producer frames.
- Queue depth 1 rejects incoming frames when full: upstream's “overwrite/latest-frame-wins” language is misleading. `notifyScheduledOutputChanged` acknowledges sink consumption, **not** final camera-client completion. The README app/XPC broker diagram is also stale; implemented frame transport is direct CMIO sink, not custom XPC.
- [Sample CLI](https://github.com/m96-chan/VirtualCamera4Mac/blob/v0.0.7/Sources/TestSource/main.swift) uses IOSurface CVPixelBuffers but CPU-fills colors. Our producer uses existing Electron GPU frames instead.
- [Signing configuration](https://github.com/m96-chan/VirtualCamera4Mac/blob/v0.0.7/project.yml): special entitlements/signing belong to backend installation; the external test producer has no entitlement file. Sink authorization returns true. Upstream transport has no robust reconnect, identity gate or multi-producer arbitration; this adapter cannot fix extension-side limitations without changing the signed bundle.

## Verification performed

Recorded reports: `results/producer-verification.json`, `results/receiver-verification.json`.

- Native discovery and sink start succeeded; 428 frames published/released in a 15-second run, including startup and a deliberate 0.5-second stop. Steady-state logs: **30 accepted FPS**, zero busy/queue drops. Whole-run average: 28.52 FPS (includes the deliberate pause/startup).
- Independent receiver: **149/149 expected 1280×720 BGRA frames in 5.02 seconds**, 149 distinct sparse hashes, 148 changes, ~33.34 ms mean PTS interval, no invalid frames/lock errors. Static standby baseline previously had just one hash.
- Mean native CPU submission **0.327 ms** (p95 0.363); GPU copy **0.089 ms** (p95 0.153); entry-to-completion **0.973 ms** (p95 1.248). These are not renderer-to-FaceTime latency or total GPU utilization.
- Electron main + native-worker CPU: **18.77% of one logical core**, not system-wide CPU. Main RSS 133 MiB, peak 152 MiB at report time (Electron working-set metric). Renderer/GPU-helper per-process cumulative CPU/memory are recorded separately; no controlled baseline or GPU utilization measurement was performed.
- Stop/disconnect/reconnect/restart passed. Source window remained hidden throughout. Independence from editor is architectural; an explicit minimize/close interaction with the other agent's live editor was **not** performed.
- Existing native Metal smoke suite passed unchanged (BGRA/RGBA, busy, debug copies and async teardown). Five wrapper tests cover drain/release ordering, busy drop, release exceptions, missing-device/disconnect injection and teardown after stop failure.
- Reviewed by a separate native implementation reviewer. Final revision builds cleanly; review fixes harden exception/error/teardown paths. Recorded live measurements precede those error-path-only fixes; no additional live run was started after announcing FaceTime readiness.

Not verified: a remote call, long-duration endurance, physical device removal, multiple producers, backend conversion/scaling, or packaged integration. FaceTime was subsequently confirmed manually by the user. This is an opt-in backend, not a replacement for our own extension.

## Portrait verification

```sh
native/macos/vc4m/build/gpu-fit-test
```

This offline test creates known quadrant patterns and runs the **same Metal aspect-fit shader used by the producer**, without touching the camera or an existing producer. It verifies color, upright quadrant orientation, opaque black sidebars and centered active bounds. Observed portrait active pixels x=437…842 (fractional viewport x=437.5, width=405); landscape fills x=0…1279. Diagnostic CPU pixel access is confined to the test executable. Results are recorded in `results/gpu-fit-verification.json`. Single-command GPU timings are diagnostic samples, not a sustained portrait benchmark.

Once any other producer is stopped, a live standalone portrait test can be run:

```sh
node_modules/.bin/electron native/macos/vc4m/run.cjs --portrait --verify --seconds 15
```

The receiver supports `build/receive 5 --portrait-fit` to check opaque-black sidebars, contrasted interior content and changing interior hashes. The initial portrait implementation passed the offline GPU correctness tests, wrapper tests and TypeScript checks. A subsequent live full-app test found and fixed the hidden output shell's fixed 1280×720 CSS clipping. Its viewport, body, mount and canvas now all measure 720×1280 in portrait. Independent camera reception passed in portrait (88 frames/3 seconds), with editor closed (89), landscape after switching (89), and portrait after switching back (89). GPU render mean was about 0.09 ms in sampled portrait sessions; no native failures. A direct camera PNG confirms the full top-to-bottom scene, not the previous cropped upper 720 rows. See `results/portrait-scene-verification.json` and `results/portrait-camera.png`. This validates the camera stream, not FaceTime's final display behavior. Diagnostic capture is optional via `VC4M_RECEIVER_PNG=/absolute/path.png build/receive 3 --portrait-fit` and reads only one frame for PNG encoding.

## Incorporating safely later

There is **no branch/worktree/commit hash**: the project was not a Git repository, and the user authorized proceeding without Git isolation. This directory was added, plus a focused opt-in loader change in `src/main/native-bridge.ts` and responsive viewport/CSS fixes in `output.html`. Once the coordinating agent establishes a baseline, stage/review `native/macos/vc4m/` (excluding ignored `build/`), that loader change and those output-shell sizing fixes in its own feature branch and commit them. No merge was performed here. Do not wholesale copy a working tree over the editor; apply only these integration changes. Offscreen admission chooses this adapter with `VC4M_OUTPUT=1`, retains a single Electron release owner, and drains before destroying the source window.
