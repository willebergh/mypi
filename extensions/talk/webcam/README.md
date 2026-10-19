# Pi Talk Webcam

This app now lives at `extensions/talk/webcam/` in mypi. Run all commands below from this directory (or use `pnpm --dir extensions/talk/webcam …` from the repository root). It keeps its own pnpm package and lockfile for now. `/talk facetime` opens/reuses the prebuilt macOS app; regular `/talk` does not launch it.

The complete source includes the optional [VirtualCamera4Mac output adapter](native/macos/vc4m/README.md) and [FaceTime aspect synchronization](docs/facetime-aspect-sync.md), as well as the separate unsigned in-house camera prototype. Importing/building does not install or activate either camera. The milestone notes and measurements below describe the original project's history, not fresh live verification after relocation.

## Live Pi integration

Build the app explicitly with `pnpm --dir extensions/talk/webcam package` from the repository root, quit any older webcam/dev process once to load the updated main/preload code, then `/reload` Pi. `/talk facetime` starts a private read-only HUD publisher and opens the prebuilt app through LaunchServices. A single-instance handoff reuses an existing editor and selects the requesting Pi endpoint without stealing focus. No runtime build/install, camera activation, or automatic call is added. A missing build fails visibly and rolls back sharing acquired by that failed startup.

For the HUD without FaceTime, run `/talk webcam on` and open the app manually; `/talk webcam status` inspects sharing and `/talk webcam off` stops it. The app defaults to **Live**; **Demo** is an explicit UI selection, never a fallback for a missing/stale connection. Both preview and hidden camera-source renderer share the same data. Voice preparation/eyes follow structured Talk transitions, not a timer or parsed status text; voice-ready and audio-enabled are separate facts.

After sharing starts explicitly (`/talk webcam on` or `/talk facetime`), the feed includes model/context, subagent labels/tasks, todos, weekly usage, Talk state, and bounded **visible conversation and compact tool previews**. The HUD hides subagent task text and settled agents; the wire still includes consented task text. **Public conversation, tool previews and task/todo text can contain sensitive project content, visible in the live camera output.** Common credential patterns receive best-effort redaction, not arbitrary or perfect secret detection. Reasoning, raw tool arguments/results, separate cwd/session-name/path fields, and raw provider errors are not forwarded. Public rendered text can itself include paths, snippets or errors; this is not a promise that displayed text contains none of those.

**Todos** retain pending work first in canonical `state.items` order, never newest-first or by sorted ID. The publisher scans/validates the full current replacement before selecting at most 48 rows (pending first, then canonical-order completed rows if space remains); it does not change tool state. The HUD displays up to five rows with `#id text`, selecting pending tasks by ascending numeric ID. A spare display slot shows at most one completed task (highest ID); all displayed rows remain in ascending ID order. An amber empty checkbox means **next queued**, not in progress; only completed tasks have filled centers.

The additive v1 wire field is `todoCounts?: { total: number; pending: number; completed: number }`, alongside the unchanged `todos` array. Counts cover the full current validated list, before the 48-row transport limit. Each is a nonnegative safe integer (at most `Number.MAX_SAFE_INTEGER`); `total === pending + completed`, `total >= todos.length`, and each category must cover its transmitted rows. Exact-allowlist validation rejects malformed/inconsistent metadata, rather than inferring totals from IDs or silently dropping it. Malformed/duplicate producer todo records invalidate the replacement rather than generating partial “full” totals. Reconstruction uses the latest valid active-branch result for both rows and counts; authoritative clear, branch/session replacement and publisher stop clear both together. Existing frame/collection limits are unchanged.

The Todos header shows authoritative **completed/total done**; its reserved footer reports `+N pending` and/or `+N done hidden` relative to the visible rows, including transport omissions. Older frames without metadata show only **N received**, and any footer is explicitly `(received)`—full totals remain unknown. Offline/stale shows **N/A / no todo data**, not an empty completed list. Demo counts come from its actual demo todo array. Producer-authoritative three-second subagent outcome retention and HUD animations/layout remain unchanged.

The compact **Activity** card sits directly below Session in both orientations and follows the existing **Session** visibility checkbox. Weekly remains above Session; subagents remain independent. The status/timer header is unchanged. Activity shows actual public user/assistant text, the known-safe current `talk-history` body and compact rendered tool previews—no displayed role/time/type prefixes, metadata rows, generic “assistant finished” or “tool completed” replacements. Roles affect styling internally only. Paragraph breaks and code indentation are preserved (tabs display as four spaces); text wraps to card width. The newest wrapped text fills Activity's remaining available height in chronological order, without scrolling, so long blocks may show only their tail. Live mode never fabricates text from legacy events or demo fixtures. Offline/stale clears content; empty history is explicit. Demo remains separately selected and uses authored fixture text.

The additive v1 `transcript?: LiveHudTranscriptBlock[]` is an exact bounded display DTO: each block contains only `{ id, role, text }`, with an opaque `/^[a-zA-Z0-9_-]{1,128}$/` ID, role `user|assistant|tool|custom`, and non-whitespace text. At most ten blocks, 2,048 UTF-8 bytes per block and 32,768 text bytes total are allowed (the ten-block/per-block caps currently imply a tighter total). Newline/tab and valid astral characters are allowed; other controls, Unicode format controls (including bidi), isolated UTF-16 surrogates and ANSI/OSC escapes are rejected. Unknown fields, duplicate IDs and malformed text reject the frame. Existing version, events and optional todoCounts remain compatible; missing transcript means no displayed activity. Freshness/generation fences are unchanged.

History uses compaction-aware `buildContextEntries` when available, with a compaction-aware active-branch fallback; navigation replaces the bounded tail and rotates its opaque branch scope. Finalized messages are reconciled from persisted history at suitable post-message lifecycle boundaries or heartbeat, after later message handlers can finish transforming them. Only visible `talk-history` custom messages with the exact current `[talk:user]\nbody` or `[talk:assistant]\nbody` shape are included, reading strings or text blocks only. The bracketed source header is removed; its speaker becomes an internal styling role. Legacy/XML, unsupported shapes and all other custom types are omitted. Arbitrary `display: true` raw content need not match its custom renderer, which may hide a large underlying outcome. Raw message/result objects never reach Electron; nested/subagent history is not merged.

The installed Pi **1.3.0** host supports the public `registerToolRenderer` API; the pinned development SDK **0.87.1** lacks it. The integration feature-detects that API without importing newer runtime symbols; hosts without it omit tool previews honestly. Tool capture observes the effective returned component's actual compact `render(width)` output **after sharing starts**, with no second render/copy or replay. Previously rendered tools need a normal renderer invocation after enable; enabling does not render them again. The public renderer context cannot distinguish a matching compact HTML export render from terminal rendering; an export matching an active tool can also update its preview. Expanded output is excluded. This includes native bash/powershell output tails, edit diffs and read/write previews as Pi normally chooses to show them. A successful compact read often shows **only its header/path**, not the full file body. Missing effective renderers, unrendered tools and expanded-only output are omitted; raw arguments/results never synthesize fallback text. Conversation/live/finalized prose keeps the newest UTF-8-safe tail within its byte cap, after stripping/redacting the entire input, preserving paragraph breaks and indentation. Combined tool blocks keep a bounded call-title prefix plus the recent result tail; no lifecycle text is invented.

**Loading these source changes later:** Pi needs `/reload`, then `/talk webcam on` to re-enable sharing after reload closes the publisher. Electron needs an explicit rebuild/package and restart with the updated JS/validator; renderer HMR alone cannot update main-process validation. No new settings or native changes are required. Old bridge frames remain accepted as empty activity/unknown todo totals; old validators reject transcript and other newer optional fields. Update both sides. This Activity transcript integration is source-only, explicitly untested and unbuilt: no tests, checks, typechecks, builds, rebuilds, restarts, app launches or live probes were run.

Default socket: `<Pi agent directory>/webcam/hud.sock` (`~/.pi/agent` by default). Directory/socket permissions are owner-only. One Pi session owns the endpoint; another session fails rather than taking it over. The bridge never removes a preexisting/stale socket: after a crash, confirm no publisher is running before manually removing that socket. `PI_TALK_HUD_SOCKET` overrides the app's receive-only endpoint; `PI_CODING_AGENT_DIR` supports a custom agent directory. `/talk facetime` passes the exact endpoint even to an existing app. `/talk stop` stops voice/standby, not the editor or HUD publisher; `/talk webcam off`, session shutdown, or quitting Pi disconnects sharing.

The mouth automatically meters the exact visible **Pi Talk virtual input** while the normal app runs. There are no listen toggles and no physical/default microphone fallback. Stalls/temporary absence of that exact device visibly retry at bounded 2/5/15/30/60-second delays, only with already-granted permission; other faults or exhausted retries remain unavailable. Levels stay zero during recovery; quit cancels it. This recovery change is source-only, not built/tested/live-verified; later deployment needs an Electron main-process restart, not a native-addon rebuild. `--verify` and `PI_TALK_SYNTHETIC_FIXTURE=1` never start the meter or connect the live Pi feed. Verification uses explicit demo telemetry. See [speech-mouth.md](docs/speech-mouth.md).

Camera transport remains separate: VC4M scene publishing is currently opt-in and development-only; the unsigned in-house extension remains a test-pattern prototype. Opening the prebuilt editor does not activate/install either camera or enable VC4M publishing.

## Live closed captions (source implementation)

Captions are **enabled by default** for this explicit request, within the existing webcam-sharing opt-in. They show **You** and **Agent** speech only while structured Talk state is `facetime / connected`, with a current voice-run ID, `voiceReady` and `audioEnabled`. FaceTime mode opens that local audio gate only for an **owned, verified connected call**; merely preparing voice, standby, a control-service connection or a ready peer does not qualify. Regular physical/default/virtual Talk does **not** publish camera captions. No audio device, microphone capture, metering, exact virtual-audio routing, native UI or call-control behavior changes.

The validated Codex transcript adapter has a separate read-only caption observer: actual text fragments **append within an identified utterance**; explicit authoritative full finals **replace** it (including corrections and empty finals). Provider item/turn aliases stay local, scoped to one voice run and speaker. `turn.created` binds its subsequent item fragments; an initial identified item can precede that announcement. Without a turn scope, distinct item IDs replace rather than concatenate. Unidentified fragments and ambiguous finals that would consume a different live utterance are omitted. Retired identities, callbacks from closed/other runs, pre-gate items/turns and late suffixes cannot revive old captions. Identity-fence capacity exhaustion fails closed for that run. Questionnaire/Stop approval and saved-history behavior are untouched; captions never become requests, confirmations or Activity messages.

The additive v1 `captions?: { runId, lines }` field is a **complete latest snapshot**, not a transcript: at most one line record per speaker (`user|assistant`), each exactly `{ id, speaker, text, final, updatedAt, expiresAt }`. IDs are opaque local caption IDs, not provider/caller identities. Text is sanitized with the existing display-text policy and best-effort credential redaction, capped to **1,024 UTF-8 bytes per speaker**. Unknown fields, duplicate speakers/IDs, wrong-run or non-call payloads, malformed text and excessive lifetimes reject the frame. There are no auth/credential metadata fields. As with other shared display text, spoken content can itself be sensitive; redaction is not a perfect secret detector. This camera disclosure is explicitly authorized for both speakers, under the unchanged private owner-only receive-only publisher.

Partials expire after **8 seconds without a fresh fragment**; finals remain for **4 seconds**. Absolute deadlines are not extended by heartbeats, reconnects, initial getters or new renderer subscriptions. Existing Talk refresh/bridge heartbeats and renderer frames service expiration—no new recurring timer or unbounded transcript queue. Call end, audio gate close, voice stop, branch/session change and sharing stop clear the projection; disconnect/stale clears the renderer, with an additional local five-second stale fence. Startup summaries, saved/private logs, mock/demo speech, reasoning, terminal/tool text and source-history reconstruction are never caption sources. No provider request, second transcription or extra audio capture is added.

`src/avatar/captions.ts` paints ordinary high-contrast white CC with a translucent black backing into a shared Three.js overlay pass in `scene.ts`, so it is burned into **both the editor preview and hidden camera-source output**, independent of holographic HUD visibility/opacity. Labels distinguish speakers; text wraps to at most two lines each and keeps the newest words. Viewport-relative portrait/landscape margins and a read-only HUD bottom-clearance measurement keep existing panels/animations/anchors unchanged. With the default portrait bottom cards, the 72px free band fits one line per speaker (two for a single speaker); clearer/wider layouts allow up to four total lines. An unusually obstructed bottom band hides CC rather than painting over panels. The fixed canvas/texture is reused, uploads only on changed text/layout, and is disposed with the scene.

**Loading implications, not actions performed:** Pi callback/publisher changes require a later Pi `/reload` and sharing re-enable. The Electron **main-process validator** also changes; renderer HMR alone cannot load that contract. A later explicit app rebuild/package and restart is needed for an older running/packaged app. Existing preload and subscribe-before-getter feed already carry complete snapshots to both renderers and need no new IPC, permissions or controls. Old publishers remain usable without captions; old validators reject the new optional field. Update both sides. Caption reducer/bridge/wire/projection/feed test **source** was added only: **no tests, checks, typechecks, builds/rebuilds, launches, restarts, calls or probes were run**. Visual placement and live behavior remain unverified.

## Explicit webcam presentation

**`present_to_webcam`** shows public text/local PNG/JPEG using only this Pi session's already opted-in, ready webcam/HUD publisher. Talk can be inactive and FaceTime can be in standby. `{"action":"show","text":"Short explanation"}` replaces the panel; `{"action":"show","imagePath":"/absolute/canonical/path/diagram.png"}` selects an image; `{"action":"clear"}` removes it. The tool never enables sharing, launches apps, starts calls or controls audio/providers. Success says **published to active webcam feed**, not that anyone sees it; a ready publisher can store a panel before a consumer connects.

Call end/voice stop/standby alone do not clear a standalone panel. Explicit replace/clear, session/branch change, sharing off, disconnect/stale, endpoint retarget, demo or app quit do. **`present_to_call` remains strict verified-call-only** with its original call-scoped lifetime. Both share one slot/controller/cache. Captions remain independently call-scoped. **Off HUD does not hide presentations.** Preview/output share the same overlay; overlap masking preserves saved HUD settings and CC stays on top with its 120px band. V2 metadata has no voice run ID: its scope must match the live publisher's opaque `displayScopeId`; v1 call metadata retains its run gate. Images still use bounded private assets and existing allowlisted IPC, not paths/base64 in heartbeats. See [usage, schema migration, privacy and limits](docs/call-presentations.md).

**Source-only, untested/unbuilt.** Later Pi `/reload` exposes the new tool, then sharing requires explicit re-enable. Updated Electron JS/main/validator bundles need a full restart; an older prebuilt app needs a later authorized rebuild/package to incorporate these sources. Renderer HMR alone is insufficient. Preload/IPC names stay unchanged; no Swift/native rebuild is required.

## Standalone hoodie asset (unused)

`src/avatar/hoodie-character.ts` exports `createHoodieCharacter(resources, config, getTalk): Robot` (`group` / `update`). It builds only a closed fabric hoodie and recessed animated face—no exposed robot machinery. The existing face implementation is shared without changing the original robot's geometry/behavior. **Neither scene uses this asset; no selection UI or activation was added.** See [factory contract, tests and isolated hidden preview](docs/hoodie-character.md).

## Interactive Demo HUD (source-only)

In **Overlay**, select **Telemetry → Demo**, then use **Demo / not live Pi data**. Main owns one bounded fixture snapshot for both Editor preview and hidden Output: main/agent context sliders use a fixed 128k token window, weekly used/remaining percentages complement each other, and agent statuses/todos stay under your control until Reset demo. Add/remove/empty agents (12 max), move agents up, complete/reopen them, and add/complete/reopen/remove/empty todos (48 max) to exercise entries/exits, reordering, full counts and empty states. Todo selection stays ascending-ID, pending-first, with at most one completed HUD row. Demo offline exercises unavailable data without disconnecting the real feed. All labels/models/tasks are authored fictional fixtures.

Complete publishes a terminal fake-agent outcome plus `endedAt`, retains it for three seconds, then removes it; existing animation handles green pulse/fade. Reopen creates a new numeric run ID. One main deadline timer is canceled on Live/quit; no random telemetry timer overrides choices. Reset restores three agents/six todos with fresh IDs. Live ignores Demo state, stays read-only, and never falls back to fixtures. No Pi tools/agents/state, private history, audio/calls, CC, mouth, or presentation authority is added; existing mock preflight remains mock-only/audio-off.

**Loading later:** renderer UI/style/HUD changes can HMR, but shared Demo controls need the updated Electron main **and preload** loaded by a later main-process restart (packaged copies also need a later JS build/package). Missing API/versioned state disables the controls and says **Backend restart required**, rather than sending to a missing handler or pretending edits applied. No native rebuild is required. Source tests were added/updated but **not run**; no checks, builds/rebuilds, restarts, apps, calls, probes or provider requests were performed for this change. These controls are not claimed running in an old main.

## Editor layout (source-only first pass)

**Webcam Studio** has one compact output toolbar: status, resolution/FPS, Start/Stop, Capture output PNG, Diagnostics and Quit. The workspace defaults to **Editor**, the orbit preview rather than the camera feed; **Output** and **Both** are explicit selections. Format and output framing sit beside the preview. The inspector groups controls into **Scene**, **Character** and **Overlay**, with persistent Pi-feed/speech health below. Detailed render/bridge/revision counters live in Diagnostics; independent errors remain visible outside the inspector sections.

**Reset settings** resets lighting, character appearance/motion and HUD settings (including both padding profiles), while preserving scene, character model, format and output framing. Closing the editor still only hides it; Quit stops the app. This UI refactor changes no backend, native code, camera integration or config/framing semantics. Source edits only: no tests, checks, builds, launches, restarts, calls or probes were run; visual review of renderer HMR is pending.

## Coded scenes

Choose **Scene → Environment → Scene**: **Workshop** (`workshop`, unchanged default) or **Desk setup** (`desk`, a distinct natural-oak workstation). This is a predefined scene selector, not an editor. Selection updates preview and hidden output through the existing config/revision flow; robot, HUD, live/audio feeds and output framing controls remain intact. Reset settings preserves the scene. Missing scene IDs in legacy configs migrate to Workshop; config remains in-memory only, as before.

Desk has one large landscape monitor on the left, two smaller landscape monitors stacked on the right, a rounded silver Mac mini and an open silver laptop with modeled keys, trackpad and hinge. Procedural oak grain, steel trestles and tidy cabling sit in a restrained dark room. Four deterministic animated screen canvases reuse the terminal utilities; three screen-spill lights and a feathered behind-camera robot spotlight replace general room lighting. The workshop is untouched. See **[docs/coded-scenes.md](docs/coded-scenes.md)** for the factory/resource contract and hidden capture command. An older loaded main process needs the updated bundle in a later explicit launch; renderer HMR alone cannot add its validator schema.

## Milestone 4: Low Signal (historical)


A live procedural 3D editor: hooded CRT robot, amber/cool underground workstation, orbit/zoom camera and nine live appearance controls. **One shared Three.js world implementation** powers the preview and the independent 720p/30 hidden renderer; the existing IOSurface → Metal path remains intact.

```sh
pnpm install
pnpm dev
```

Drag the preview to orbit, scroll to zoom, and use **Reset camera** for the hero shot. Settings update both renderers live; orbit is preview-only. **Capture output** saves PNG; stopping output does not stop editing. Closing the window hides only the editor; **Quit** exits both renderers. **Diagnostics** shows the native bridge counters/timings.

Choose **16:9 Landscape (1280×720)** or **9:16 Portrait (720×1280)** above the viewport; both preview and hidden output follow the selection. Portrait uses a recentered hero camera. Switching drains/reinitializes the fixed-size Metal destination without replacing the output window. Room lighting comes from three screen spill lights positioned at the workstation (green logs, amber dashboard, blue code), with the frontal spotlight behind the camera retained to light the robot. Hemisphere ambient and the warm directional key are removed; the ceiling fixture is unlit. Screens and 104 animated self-lit LEDs across two adjacent server racks remain practical sources, and room intensity/warm–cool controls still affect screens and frontal fill. No lights cast shadows. The workstation/lighting arrangement was checked in hidden Electron landscape and portrait captures; it has not been re-benchmarked.

The background workstation now has **three equal-size monitors in one aligned row**, with matching bottom edges, desk-supported feet, a straight center panel and side panels angled inward by 12°. One centered keyboard/mouse replaces the scattered multi-station layout. The screens have distinct animated content: **green scrolling event logs**, **amber system meters with a moving history trace/sweep**, and **blue/violet code with a stepping line highlight, build progress and blinking cursor**. Restrained scanlines, edge falloff and worn housings retain the workshop CRT aesthetic. Content is decorative and deterministic: no commands run, no live telemetry/secrets are read, and no network is used. Three 512×320 canvases update at at most 8 Hz each, without cached base textures or mipmap regeneration. The three existing spill lights follow the new panel placement; the robot face/HUD, behind-camera spotlight, unlit ceiling and blinking rack LEDs are preserved. Two matching adjacent server racks each have 52 independently animated link/activity LEDs.

Validation: `pnpm typecheck`, `pnpm test` (123 tests), and `node test/artifact-checks/run.mjs hud-capture` passed. Hidden captures under `artifacts/hud-preview/` were visually inspected: landscape shows the aligned triple setup with distinct screen palettes/layouts, though the robot overlaps the left panel; portrait preserves the tight hero framing and only exposes part of the log screen at the right edge (the other two are outside the crop). Background text is not guaranteed legible at hero-shot scale or under HUD overlays. No running user app was restarted/stopped, no real audio/camera was activated, and no fresh GPU performance benchmark or live FaceTime check was performed.

The **holographic telemetry HUD** has a **Show HUD** checkbox: on is Dashboard, off closes/removes only HUD panels. Legacy `minimal` configs are accepted and normalized/rendered as Dashboard. Intensity, panel visibility checkboxes, and independent landscape/portrait top/right/bottom/left padding profiles remain (no text scaling). Panels open with a line → traced frame → glass → content scan, not text scaling or a simple fade. The current layout is compact Weekly → Session/context → Activity, with separate natural-height active-only subagents (model names beside tokens, no task text) and Todos. Mock Talk preflight plays on the robot's CRT instead of eyes, then the eyes open as boot completes. Showing one HUD panel animates only that panel; the top-right demo bar has been removed. It renders into both preview and output. Live telemetry is now the default; the original schema-aligned mock data remains available only in explicit Demo mode. Historical captures below are not evidence of this activity-panel change. See **[docs/hud-telemetry.md](docs/hud-telemetry.md)** for the real data-shape mapping and captures. Restart Electron once for the shared HUD controls; visual edits can hot-reload.

The robot has a **12-band speech mouth** on its curved CRT. It automatically meters the exact **Pi Talk virtual input**, which carries agent playback from Pi Talk Internal output. It never falls back to a physical/default microphone. Restart/rebuild the app after backend changes. See **[docs/speech-mouth.md](docs/speech-mouth.md)** for routing, permissions and verification.

**Editor + Output** views now show the interactive editor beside a sampled image from the actual hidden camera-source renderer. **Output framing** offers Fixed hero, Follow editor, or Use current view (save framing while animation continues). The source monitor is 4 FPS; camera transport remains at its existing 30 FPS target. This is before any FaceTime cropping. See **[docs/output-monitor.md](docs/output-monitor.md)**.

See **[docs/milestone4.md](docs/milestone4.md)** for the pre-HUD baseline architecture, verification, screenshots, performance and visual limitations. Local references are in `references/` and were inspected directly. No camera-extension/signing code was changed for this pass; no camera integration or FaceTime work was attempted.

## Earlier camera milestone — unchanged / blocked

**Camera Extension source and unsigned packaging are implemented; it is NOT installed or active, and FaceTime is NOT verified.**

See **[native/macos/camera/README.md](native/macos/camera/README.md)** for the signing/provisioning checkpoint, activation/removal workflow, exact macOS 26 approval steps and FaceTime test. The new Swift camera independently generates an animated 720p/30 test pattern. It is **not connected to Three.js**. No camera installation/activation was performed. An actual Personal Team signing test subsequently signed the camera extension, but Xcode rejected the host's System Extension provisioning; see [the test evidence](native/macos/camera/PERSONAL_TEAM_RESULTS.md). No keys were exported or security-setting commands issued.

```sh
pnpm camera:build
pnpm camera:test
pnpm package          # includes camera, still unsigned and not installable
```

A valid local Apple Development identity was found, but no provisioning profiles. Xcode automatic provisioning was tested and explicitly rejected the Personal Team's **System Extension** capability. The host therefore cannot obtain `com.apple.developer.system-extension.install` authorization with this team; the camera extension's own signing/App Group succeeded. See the camera README. Stop here for that manual configuration—do not proceed to Milestone 3B before the FaceTime test succeeds.

## Existing verified renderer / GPU bridge (Milestones 1–2)

**Three.js → Electron offscreen capture → IOSurface → Metal.** Electron + Forge + Vite + React + TypeScript and a small macOS Node-API addon. Existing renderer and Metal functionality remain independent of the new camera.

## Run

```sh
pnpm install
pnpm dev
```

On macOS, install Xcode/Command Line Tools and Python 3 first. Forge compiles the addon automatically before development and packaging. First native build may download Node headers. Tested with Node 25.9.0, pnpm 10.33.0, Electron **44.9.0**, macOS ARM64 / Apple M4. Use a Forge-compatible Node release (22.12+ or 24 LTS recommended).

The existing invisible renderer still targets **1280×720 at 30 FPS**. Start/Stop controls its lifecycle; closing the editor only hides it. Reopen through the app menu/Dock/tray. **Quit** drains GPU work and exits. Capture Frame retains the existing PNG save workflow.

The Milestone 4 editor replaces the old controls page. Native counters, GPU identity and submission/blit/completion timings remain in **Diagnostics**; FPS/output status stay visible in the workspace. The old camera component and its IPC/signing implementation are preserved but are not part of this visual editor. Status updates once a second; no frame pixels are sent to the UI.

```sh
NATIVE_BRIDGE=0 pnpm dev       # Shared-texture renderer, no native work (baseline)
CAPTURE_MODE=bitmap pnpm dev   # Existing bitmap fallback, native bridge disabled
```

If shared texture production is unavailable, the renderer retains its four-second probe and bitmap fallback. Native import/Metal errors are displayed as errors, **not silently replaced by per-frame CPU copies**. Non-macOS builds skip the Metal addon; other platform behavior is unverified.

## Build and test

```sh
pnpm native:build   # Standalone native build; also automatic in Forge
pnpm native:test    # macOS-only known-pattern IOSurface / validation / teardown tests
pnpm typecheck
pnpm verify         # Real Electron + Three.js + Metal end-to-end tests
pnpm package
```

`pnpm package` creates `out/pi-talk-webcam-darwin-arm64/pi-talk-webcam.app` on this host. The Node-API binary is copied to `Contents/Resources/bridge.node`, outside ASAR. Cross-compilation and installer creation are not configured. Camera signing/notarization scripts are provided separately but await user-supplied signing/provisioning configuration; ordinary `pnpm package` remains unsigned.

Run the same verification without Vite against the production app:

```sh
VERIFY_SOAK_SECONDS=60 \
  "out/pi-talk-webcam-darwin-arm64/pi-talk-webcam.app/Contents/MacOS/pi-talk-webcam" --verify
```

Historical evidence is preserved in [docs/evidence](docs/evidence/README.md); runnable source helpers and build-only commands are documented in [test/artifact-checks](test/artifact-checks/README.md). These are imported results, not a fresh validation of this checkout.

Verification writes `artifacts/verification.json`, `native-metal-1.png`, `native-metal-2.png`, normal Electron/bitmap captures and `editor.png`. Default continuous-soak portion is 30 seconds; increase `VERIFY_SOAK_SECONDS` for longer runs. A failed assertion produces a nonzero exit and `artifacts/failure.txt`.

Checks include:
- Matched shared-renderer baseline and bridge-enabled intervals, with **no debug readbacks during timing**.
- Actual GPU destination pixels: two native PNGs, exact same-frame source/destination byte comparison, distinct sequence numbers/pixel hashes, scene luminance range.
- Visible/minimized/hidden/closed editor; native processed FPS and ordering.
- Continuous operation with a constant readback counter, source retain bound and one destination texture.
- Native rejection of a second real-handle submission while busy.
- Eight shared/native start/stop cycles; zero retained source/destination resources after drain; every Electron texture released; no extra windows.
- Existing bitmap capture, hidden/closed rendering, idempotent controls, sandboxed preload IPC and explicit Quit.
- Independent native smoke tests also cover malformed metadata, BGRA/RGBA, nonaligned debug row widths, busy shutdown, async-hook reentry and worker-environment teardown.

## Pipeline / ownership

`src/main/native-bridge.ts` admits **one in-flight job and zero queued frames**. Busy frames are counted as dropped and immediately released. `native/macos/bridge.mm` synchronously retains the IOSurface and imports it into Metal, then performs a real GPU blit into one bridge-owned private texture. A libuv worker waits for GPU completion; the Electron event loop is not blocked waiting. Native and JS source ownership are released only after the GPU has finished. Stop drains before destroying the output window.

The normal pipeline does **not** lock/map pixels, use `getBytes`, return full-frame JS buffers, or call `capturePage` each frame. Explicit PNG capture and the verifier's two debug submissions are intentional exceptions. This is a GPU→GPU copy, **not a claim of zero GPU copies**. Electron/Chromium also performs capture work upstream.

See **[native/macos/README.md](native/macos/README.md)** for the exact API, ownership/error paths, timing definitions, Apple/Electron API references and future IPC design.

## Historical Milestone 2 measurements

Current Milestone 4 scene measurements are documented in [docs/milestone4.md](docs/milestone4.md). The table below is the earlier cube/native-bridge baseline, not the new robot scene.

Both development and packaged verification passed on the Apple M4. Preserved production results (`docs/evidence/packaged-verification.json`; development results in `docs/evidence/development-verification.json`):

| Measurement | Packaged result |
| --- | --- |
| Shared renderer, native disabled | 29.99 FPS |
| Native visible / minimized / hidden / editor closed | 30.00 / 29.98 / 29.99 / 30.19 processed FPS |
| CPU submission, visible interval | 0.426 ms/frame average |
| GPU blit, visible interval | 0.081 ms/frame average |
| Paint→native completion, visible interval | 1.199 ms/frame average |
| Main-process CPU, baseline → enabled | 0.93% → 3.43% of one core (+2.50 percentage points) |
| Main-process RSS, baseline → enabled | 144.0 → 146.1 MiB (sequential snapshots) |
| 60-second closed-editor soak | 29.99–30.00 processed FPS; no additional drops, failures, or readbacks |
| Main RSS across six soak samples | 132.7–150.6 MiB; last sample 135.5 MiB |
| Bitmap visible / hidden / editor closed | 29.99 / 29.99 / 29.98 FPS |

The shared/native session received 2,866 frames, processed 2,845 and dropped **21** under the one-job policy, with zero native failures or ordering errors. Drops occurred before the steady closed-editor soak, around startup/debug/editor-transition phases; the 60-second soak added none. Do not interpret the full run as lossless delivery. All eight native restart cycles drained to zero owned source/destination resources and one editor window. Stop issued in the same paint turn as native submission also drained correctly. A separate packaged run with **Metal API Validation enabled** passed all checks with no Metal validation errors (`docs/evidence/metal-validation-verification.json`); those validation-run timings are separate from the benchmark above. Exact native GPU output matched its same-frame source in both debug captures, while sequences **334 / 355** and pixel hashes differed across the two images.

These are wall-clock measurements from main-process paint delivery and completed native commands, not the configured target FPS. Short frame-count intervals can straddle a frame boundary (hence 30.19 FPS). RSS differences are not a measurement of total GPU allocation or a leak proof. The native timing fields distinguish:

- CPU import/validation/encode/commit wall time.
- Actual GPU command start/end duration (`null` if timestamps unavailable).
- Native-entry and JS paint-handler→completion latency, including scheduling.

No Three.js render→native/camera end-to-end latency is claimed: the renderer/capture/native clocks are not assumed to be aligned. `process.cpuUsage()` is measured over wall time for Electron's main process (100% = one logical core, includes addon worker CPU); renderer and GPU-service metrics are saved separately. Sequential baseline comparisons are indicative, not statistically controlled benchmarks. Debug readback frames are excluded from benchmark intervals.

## Scope / limitations

- Camera signing/activation and FaceTime compatibility are blocked on manual signing/provisioning and user approval. No virtual camera is installed yet.
- macOS ARM64 is the tested native platform. Intel builds, other GPUs and other OSes are unverified.
- Packed BGRA/RGBA only, fixed dimensions/format per native session. No HDR/YUV, scaling, camera color negotiation or encoding.
- A short soak plus explicit resource counters and restart tests is not a complete leak audit. Driver caches and Electron/V8 bitmap GC are outside those counters; no Instruments allocation trace or multi-hour/sleep/suspend test has been performed.
- GPU completion uses a libuv worker per job; unrelated saturated threadpool work can increase callback latency and cause bounded frame drops.
- Native handle bytes are trusted, process-local Electron pointers. The addon is loaded only in main; renderer IPC cannot submit pointers. Both existing renderers retain sandboxing/context isolation/no Node integration, navigation guards and CSP.
- The save-dialog UI itself is not click-automated; native/bitmap image generation and filesystem PNG writes are verified programmatically.
- Vite source edits may reload pages and interrupt a development session; use packaged verification for stable measurements.

## Recommended next step / CoreMediaIO boundary

Only after the Milestone 3A test-pattern camera is confirmed in FaceTime, a later renderer-to-camera milestone can add a small **bridge-owned IOSurface output pool** and a separate authenticated receiver test process. Export surfaces through **`IOSurfaceCreateXPCObject` / `IOSurfaceLookupFromXPCObject`** (or properly transferred Mach send rights), never pointer bytes or a numeric port name in ordinary IPC. Signal ready after GPU completion; use sequence/generation IDs and completion/release acknowledgements before reuse. The receiving extension can wrap a local IOSurface reference in `CVPixelBufferCreateWithIOSurface` and construct timed `CMSampleBuffer`s. Actual downstream buffer ownership must govern reuse—not merely message receipt or return from a send call.

Do not keep Electron's source-pool frames pinned by a slow external camera consumer. Copy GPU→GPU into a bounded owned export pool, then release Electron promptly. The current private Metal destination is deliberately in-process and must be replaced with IOSurface-backed output storage for that future milestone. Details, rights cleanup, security and compatibility caveats are in the native README.
