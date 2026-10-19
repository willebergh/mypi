# Persistent webcam preferences (source-only)

Main owns **one versioned `settings.json`**, under `app.getPath('userData')`. Normal dev and packaged apps pin the existing `pi-talk-webcam` identity before the instance lock: `appData/pi-talk-webcam/settings.json`. On macOS the usual location is **`~/Library/Application Support/pi-talk-webcam/settings.json`**; Linux normally uses `~/.config/pi-talk-webcam/settings.json`, Windows `%APPDATA%/pi-talk-webcam/settings.json`. The actual path appears in recovery warnings. No private config discovery or localStorage copy is used. Verification and synthetic fixtures neither read nor write this file.

## Control inventory

| Controls | Saved |
| --- | --- |
| Scene / Environment | Workshop or Desk setup; room lighting; warm/cool light balance |
| Character | Robot or Hoodie; eye color, glow and squint; casing tint/wear; hoodie color; idle motion intensity |
| Format | 16:9 or 9:16 (existing FaceTime observation can subsequently update it) |
| HUD | Show HUD (Dashboard/Off), hologram intensity, Session/Activity, Subagents, Todos and Weekly visibility; all four safe-area insets independently for landscape and portrait |
| Output framing | Fixed hero, Follow editor (last validated pose), or Use current view (saved position/target/FOV); animation is not frozen |
| Editor | Orbit/zoom/pan position/target/FOV; Editor/Output/Both workspace; Scene/Character/Overlay inspector section |
| Window | Normal window position/size, restored on an available display, with existing minimum size; no fullscreen/maximized/monitor identity state |
| Telemetry | Explicit Live/Demo selection, still visibly labeled; a deliberate `/talk facetime` launch/handoff retains its existing selection of Live |
| Start/Stop | A successful explicit Stop stays stopped on subsequent launches until explicit Start succeeds. Quit does not set/clear that preference; ordinary first-run startup stays as before. |

The whole current `SceneConfig` is saved, not a hand-picked subset of sliders. Reset settings and Reset padding use the same canonical mutations and persist their results. Reset camera persists the resulting editor pose; Fixed hero itself remains orientation-specific. Restoring a saved format does **not** replay studio aspect intent or send a FaceTime rotation command. Existing scene revisions, 33ms renderer edit coalescing, aspect-intent fences, output acknowledgements and serialized GPU resize/start/stop path remain in place.

## Not saved / no new authority

No call/caller/session/branch/provider IDs, auth, budgets, transcripts, terminal/tool history, real tasks/todos/subagents, pending requests, presentation contents/images/assets, live HUD snapshots, permissions, capture device IDs or audio levels. Demo agents/todos/context/weekly sliders/offline switch/reset scenarios remain **ephemeral authored fixtures**, never real Pi state; only the explicit Live/Demo selection is a preference. Diagnostics/dialog visibility, expanded details, busy/errors and transport counters are transient UI/runtime state, not configuration. Capture PNG is still an explicit save dialog/action, not a remembered asset/path.

Loading preferences never activates a camera extension, starts a Pi publisher/voice/call, changes routing/system defaults, or grants permission. The existing normal-app exact virtual-input mouth behavior is unchanged, including when output is stopped. No native/Swift/Talk/auth/allowlist or virtual UID policy changes are involved.

## Storage, startup and recovery

- Main loads before creating/loading either renderer, initializes scene/framing and output dimensions, and honors the explicit stop latch before automatic output start. The editor awaits a main bootstrap acknowledgement before mounting a scene or accepting edits. Output subscribes before getters and waits for both saved scene and framing before creating its scene. No mount effect writes default UI preferences.
- Schema **v1** validates known enums, booleans, RGB colors and existing camera poses. Missing known keys receive defaults; finite numeric scene settings clamp to existing scene ranges. Legacy v0/unversioned `sceneConfig` documents migrate to `scene`; `minimal` becomes Dashboard. Unknown fields are bounded by the 64 KiB file cap and ignored, never copied to the next saved document. Dangerous prototype keys, invalid known settings, malformed/oversize JSON and unknown versions fail closed. There was no prior app preferences file/localStorage store to discover or import.
- Rapid edits debounce for 250ms in main; a single asynchronous snapshot write queue serializes writes and drains newer accepted edits. Owner-only random exclusive temp files are synced, then atomically renamed in the same directory; directory entries are synced where supported. POSIX directory/file modes are 0700/0600. Windows chmod cannot guarantee POSIX-style privacy; ACL behavior remains unverified. Settings files/directories must be owned regular paths, not symlinks; hard-linked files are rejected. File-size and opened-file identity checks bound reads. Unexpected external file changes disable saving rather than overwrite the new file.
- Normal Quit fences new preference IPC, lets already accepted scene/output operations finish, drains GPU output asynchronously, then flushes pending successful preference commits before exiting. It never blocks the event loop with synchronous disk or GPU waits. UI edits still inside the renderer's existing 33ms debounce are not yet main-acknowledged; abrupt termination/power loss can lose uncommitted changes. Temp files left by a crash are not treated as settings or automatically replayed.
- **Corrupt/unsupported/unreadable/unsafe file:** it is not deleted, renamed or replaced. Main uses defaults, keeps output stopped for safety, disables saving for that run, and shows an actionable **Saved preferences · read only** warning outside the inspector. In-memory edits can still be previewed, but are not saved. To recover, explicitly Quit, repair the file (including owner permissions), or rename `settings.json` to keep a backup, then reopen. Do not follow/delete an unsafe symlink's target. Renaming/removing the file is a deliberate full reset; the existing inspector Reset settings is only its documented appearance/HUD reset, not file recovery.
- **Write I/O failure:** the editor warns; older durable settings remain available, and another edit or normal Quit retries. External edits/unsafe paths instead require the explicit recovery above. No warning includes JSON contents. No other private files are read. The app is single-instance under the pinned identity; this is not a cross-process settings merge service or a defense against a hostile same-user process racing filesystem operations.

## Loading / validation status

This implementation and `test/settings.test.mjs` are **source-only, untested and unbuilt**. No tests, typechecks/checks, builds/rebuilds, restarts, app launches, calls, permissions/capture probes or provider requests were performed. Existing running apps will not gain persistence from renderer HMR: a later authorized Electron JS build/package (for packaged copies) and full restart loading updated **main and preload**, plus renderer, are required. No native rebuild is required by these source changes. Current in-memory user settings have not been read/exported or retroactively saved; only preferences edited/loaded by the updated app can become durable.
