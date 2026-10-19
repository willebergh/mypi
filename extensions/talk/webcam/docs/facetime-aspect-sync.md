# FaceTime ↔ studio aspect synchronization

## Run

Keep the existing Pi Talk / Swift FaceTime service running, then fully quit/restart the webcam app:

```sh
VC4M_OUTPUT=1 pnpm dev
```

On macOS, aspect sync starts automatically in normal app runs. It does **not** start FaceTime, Pi Talk, the Swift service, calls, audio, or virtual-device installation.

Default socket: `~/.local/share/pi-facetime/control.sock`. Override with `FACETIME_SOCKET_PATH=/absolute/path/control.sock`. Disable sync with `FACETIME_ASPECT_SYNC=0`; studio aspect controls then stay local. The existing `--verify` app workflow does not start the synchronizer, so its deterministic scene checks are unaffected.

## Behavior

- Read the initial service snapshot, then reconcile with fresh `video.status`.
- On `video.layout_changed`, reread current video status instead of trusting potentially delayed event dimensions.
- Follow the **local preview's observed geometry**: width > height means landscape; height > width means portrait. Near-square previews (within 5%) are ambiguous and do not trigger changes. Exact 16:9 proportions are not assumed: 150×100 and 150×69 both count as landscape.
- Poll `video.status` every three seconds as well. First appearance, disappearance, and replacement of a video window do not produce the upstream layout-change event. This also recovers missed observations.
- Apply the aspect through the existing serialized scene-state, offscreen-resize and GPU-drain flow. The editor and hidden renderer receive the same config/revision. Every other scene/HUD setting is preserved.
- A studio aspect edit changes the scene locally and requests at most **one** `video.rotate` if a freshly read FaceTime view has the opposite orientation. The request uses that exact status response's window ID and peer. Swift may briefly reveal the preview controls with a pointer hover, press Rotate Camera once, then restore the pointer.
- Require `attempted: true`, `verifiedChange: true`, and an `after` context matching both the target and requested orientation. An accepted AX press alone does not count as verified rotation.
- Automatic observations never send rotations. Echo events are read-only reconciliation. Rapid edits fence older intents, and a slow observation cannot override a newer studio choice already queued for application.
- Missing/ambiguous view: no rotate is sent. Timeout/disconnect/unknown outcome: **no mutation retry or replay**, including after reconnect. Local controls remain usable while disconnected. A later connection follows fresh FaceTime state, not an old offline studio request.
- Closing/hiding the editor does not stop observation or the independent hidden renderer. Quitting the app closes the socket, cancels pending work and drains the renderer.

**Camera format limitation:** VC4M still publishes its supported 1280×720 BGRA stream. Portrait sources are 720×1280 and GPU-fitted into a centered 405×720 image with black pillars. Sync selects source composition and FaceTime's local preview orientation; it does not add a true portrait format to the signed backend or rotate the remote phone.

## Actual upstream protocol inspected

Read-only inspection of `/Volumes/Samsung T5/development/mypi`:

- `extensions/talk/facetime/Sources/FaceTimeObserver/VideoLayout.swift`
- `.../main.swift` initial snapshot and video command handling
- `.../SocketServer.swift`
- `extensions/talk/facetime/README.md` video-layout/socket documentation
- `extensions/talk/facetime-client.ts`

Implemented protocol is UTF-8 NDJSON, v1, with correlated response IDs, per-service `serviceInstanceId`, and event/snapshot sequence watermarks. The new event is `video.layout_changed`, with `source: "local_preview_geometry"`, before/after geometry, window ID and peer. `remoteOrientation` remains `"unknown"`: this is **not a guaranteed remote-device orientation signal**. We deliberately classify the visible FaceTime layout rather than asserting phone orientation.

`video.status` reports a unique visible video context and `localPreview`. `video.rotate` requires `expectedWindowId` and `expectedPeer` from a fresh status. These controls do not depend on the call tracker's phase (which can be idle during video calls).

The existing Talk TypeScript client's semantic filter excludes this new event. The webcam app therefore has its own small video-only client, not a cross-repository import or modification of Talk. **No files under `mypi` were changed.** The socket client cannot send call/answer/hangup/audio/sharing commands at runtime.

## State and diagnostics

`window.webcam.getStatus()` includes `faceTimeAspect`:

```js
{
  enabled: true,
  connected: true,
  available: true,
  observedAspect: '9:16',
  desiredAspect: '9:16',
  state: 'following', // disabled/offline/unavailable/rotating/error also possible
  error: null
}
```

Errors are also printed as `[FaceTime aspect] ...` in the app terminal, without logging call snapshots or peer identities. No editor-layout redesign was made.

The scene setter now accepts explicit edited-field intent:

```js
// Explicit aspect request: local composition plus one guarded FaceTime action.
await window.webcam.setSceneConfig(config, { aspectChange: true });
// Appearance edit: preserve the latest canonical aspect, even if config is stale.
await window.webcam.setSceneConfig(config, { aspectChange: false });
```

The studio hook carries this intent across its existing 33 ms debounce. Every explicit aspect request fences the previous one even if it equals the still-committed scene. This avoids two races: rapid portrait→landscape while resizing, and an appearance edit queued before an automatic aspect change. Legacy one-argument callers still apply a complete local config but **cannot initiate FaceTime rotation**. The API/preload and main process require an app restart together.

Transport bounds: incoming records 256 KiB, outgoing commands 64 KiB, at most eight pending commands, five-second request/snapshot deadlines, 0.2–5 second reconnect backoff. Malformed UTF-8/JSON, invalid versions, wrong service instances, and sequence regressions fail closed. Duplicate event sequences are ignored. Pending commands are rejected on disconnect; none are queued for reconnection. All socket/reconnect timers are unrefed.

## Verification

```sh
pnpm typecheck
node --test test/facetime-aspect.test.mjs test/facetime-transport.test.mjs
```

**41 tests passed:** geometry classification, event following, rotation echo suppression, fresh target guards, ambiguous/missing contexts, no offline replay, late observations, serialized mutation fencing, shutdown, fragmented UTF-8/NDJSON, bounds, event ordering and reconnect behavior. Current Node can run these TypeScript imports directly; its package-type warning is harmless and does not require changing the Electron package type.

Full-app integration (requires the existing dev renderer server from `pnpm dev`):

```sh
node test/facetime-app-integration.mjs
```

This starts a **separate Electron instance with native camera output disabled**, its own temporary user-data location, and a **private fake FaceTime socket**. It never connects to the real service or touches the running camera producer. Passed:

1. Initial portrait snapshot → editor and hidden renderer 720×1280.
2. Layout event → both landscape 1280×720, no rotation.
3. Actual studio portrait button → exactly one guarded fake rotation.
4. Delayed appearance edit with stale landscape → stays portrait, preserves appearance, no rotation.
5. Rapid opposite studio edits while a status response is delayed → latest intent wins, no unwanted rotation.
6. Editor closed/hidden → next geometry event still resizes output.
7. Offline studio choice → reconnect follows fresh state without replaying that choice.

Report: `native/macos/vc4m/results/facetime-app-integration.json`.

A separate **read-only live probe** using the actual socket and new client/coordinator successfully observed portrait and issued only `video.status`; its apply callback updated only a local test variable. Report: `native/macos/vc4m/results/facetime-readonly-probe.json`. No real rotation, call, audio or security changes were performed for testing. Independent review confirmed the explicit-intent race fixes.

### Manual live check

1. Restart the webcam app with the normal command above; keep the Swift service running.
2. During a FaceTime video context, change FaceTime's local orientation. Confirm the studio selection, composition and camera content follow within the observer/poll interval (typically a few seconds).
3. Select the opposite aspect in the studio. Confirm FaceTime rotates once, then remains stable (the pointer may briefly move to reveal the control).
4. Close the editor and change FaceTime orientation again; output should still follow. Restore the editor from the tray.
5. If Swift cannot uniquely find the Rotate Camera control, inspect the terminal/status error rather than repeatedly toggling. Real end-to-end FaceTime rotation is pending this user check.
