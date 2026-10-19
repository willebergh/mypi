# FaceTime control service

Native Swift executable for observing and controlling macOS FaceTime calls. Intended to provide FaceTime call control alongside Talk's existing voice pipeline.

This package remains an independent service exposing a local Unix socket. The TypeScript Talk extension now provides **FaceTime standby mode**, mode-scoped tools, and physical/virtual audio profiles; see [INTEGRATION.md](INTEGRATION.md). Swift does not start or stop `/talk` itself.

## Responsibilities

- Discover FaceTime, Notification Centre, and related processes.
- Observe their UI with public macOS Accessibility APIs.
- Identify incoming callers and enforce a local caller allowlist.
- Answer incoming calls manually or automatically when configured.
- Initiate explicitly requested FaceTime audio or video calls to the sole configured owner; audio is the default.
- Preserve audio's outgoing “Click to Call” banner path; confirm video only in the scoped standard-window structure correlated to a sole pending video request and exact recipient/alias.
- Observe ringing, verified connection, ending, and some failure conditions.
- Select FaceTime-specific microphone and output devices.
- Expose commands and events over a Unix domain socket.

This executable does **not** capture, stream, transcribe, or generate audio. It does not communicate with an AI service or hold AI credentials.

## Requirements

- macOS 13 or later as declared by the package; actual FaceTime UI behavior was tested on macOS 26.2 with English UI.
- Swift 6 tooling / Xcode command-line tools.
- A logged-in GUI session with FaceTime configured.
- Accessibility permission for the process hosting the executable or the installed executable itself, depending on how it is launched.
- Virtual audio drivers installed and the explicit pair selected in Pi's shared config for Talk over FaceTime.

There are no third-party Swift dependencies. UI labels and process ownership can differ across macOS versions or languages; the declared deployment target is not a guarantee of compatibility with every FaceTime version.

## Build and test

From this directory:

```sh
swift build -c release
swift test
```

Executable:

```text
.build/release/facetime-observer
```

Tests use synthetic call observations and temporary config files; they do not place real calls or open audio devices. They cover state transitions, timer-based connection verification, confirmation-banner detection, stale failure suppression, identity normalization, and configuration loading. AX actions and socket behavior still require additional coverage and live testing.

## Standalone app (recommended)

Follow [`/skill:setup`](../../../.pi/skills/setup/SKILL.md) and its [FaceTime app reference](../../../.pi/skills/setup/references/facetime-app.md) to build, locally ad-hoc-sign, and install **Pi Talk.app** under `~/Applications`. Open it through Finder/LaunchServices and use its menu to grant/check Accessibility. No developer account is needed; the app build never launches or requests permission by itself. Actual TCC attribution and grants need manual verification. See [APP.md](APP.md) for the full workflow; automatic startup from Pi remains deferred.

The CLI remains supported as a developer/debug option (`swift run facetime-observer watch`). Running it inside a terminal can attribute Accessibility to that terminal.

## Accessibility permission

```sh
swift run facetime-observer permission --prompt
```

Enable the terminal/app hosting the executable in **System Settings → Privacy & Security → Accessibility**, then restart it if necessary. A separately installed or differently launched binary may require its own permission entry.

Check without prompting:

```sh
swift run facetime-observer permission
```

Run in the user's GUI session, not as root or as a system LaunchDaemon. No LaunchAgent installer is included yet.

## Configuration

The app and Pi read **`~/.pi/agent/talk.json`**, or `talk.json` under `PI_CODING_AGENT_DIR` when that environment is available. See the [shared configuration reference](../CONFIG.md) for the complete schema and migration/backups.

Swift requires shared schema **version 2**: `audio.physical` retains the optional microphone/speaker pair, while `audio.virtual` contains exactly `visibleUid: "io.github.willebergh.pitalk.audio.visible"` and `internalUid: "io.github.willebergh.pitalk.audio.internal"`. Edit its `facetime` section to set `allowedCallers`, `allowedRecipients`, `recipientAliases`, `callStartTimeoutSeconds`, and `ringingTimeoutSeconds`. Keep the file owned by you with **`chmod 600 ~/.pi/agent/talk.json`**. There are no separate FaceTime device or auto-answer fields; Swift selects **Pi Talk** for both FaceTime microphone and output after validating the fixed virtual UIDs, while Pi coordinates answering after readiness.

- Missing config uses empty allowlists, no automatic answering/routing, and 15/60-second timeouts.
- Malformed, unsupported, non-private, or symlinked config is rejected rather than silently falling back.
- Start reads the file; `config.reload` reloads that same selected path only while idle and applies routing. Pi requests this automatically on FaceTime mode enable. Changes do not rewire an active call.
- `allowedCallers` matches the identity actually exposed by the incoming banner.
- `allowedRecipients` must contain exactly one owner: an exact international phone number or FaceTime email address, not an ambiguous contact name. Pi resolves this address locally; the model never selects a recipient.
- `recipientAliases` explicitly maps that owner address to the contact names FaceTime may display in its confirmation and call banners. These aliases authorize UI matching, not alternate outgoing dial targets.
- Matching normalizes casing, surrounding whitespace, phone punctuation, and selected bidirectional formatting characters. It does not resolve Contacts or infer country codes.
- A contact display name match is **not** cryptographic verification of a caller's phone/email identity. Configure names only if that trust level is acceptable.

For a custom Pi agent directory, use the app's **Choose Talk config…** menu, then Stop/Start (or Retry). macOS preferences store the selected location plus separately scoped, non-authorizing video-follow preferences; they never copy audio routing or caller policy. Pi checks the reported path so a GUI app that lacks the terminal environment cannot silently use different policy. An explicit CLI `--config PATH` still wins; developer CLI flags remain available for debugging, not as another persisted configuration. See `--help`.

## Audio routing with Talk

FaceTime uses the driver's visible **Pi Talk** device for both microphone and output. Talk uses the internal endpoint; there is no configurable inverse device pair.

```text
Remote caller → FaceTime output → Pi Talk → Talk capture
Remote caller ← FaceTime microphone ← Pi Talk ← Talk playback
```

Both applications read `audio.virtual` in `talk.json`. Swift strictly validates the fixed visible/internal UIDs, then selects the **Pi Talk** menu entry in each direction. The Pi Talk driver must be installed on each Mac.

Selection normally uses the hidden Accessibility children of FaceTime's **Video → Microphone / Output** menu and `AXPick`. It does **not** open the menu or change global macOS sound settings. Opening the menu programmatically previously captured desktop keyboard focus, so the service deliberately avoids that approach.

FaceTime 36 on macOS 26.6 can omit the entire **Microphone** section when Pi Talk is the machine's sole/default input. In that narrow case only, the bridge accepts the route without `AXPick` after Core Audio independently reports the current default input's exact fixed UID as `io.github.willebergh.pitalk.audio.visible`; `audio.devices` reports that verified default as the selected Pi Talk input. A present microphone selector, a different/unresolved default UID, or any ambiguity still fails closed. The default is rechecked on every routing verification, including before outgoing calls; like menu routing, it is not an OS-wide lock against later external device changes.

Configured routing is attempted when a FaceTime PID is first observed and before outgoing call initiation. A failed startup routing attempt may be retried on later reconciliations. Incoming answering does not depend on reapplying routing because FaceTime's menu may be unavailable while the incoming banner is shown. `audio.select` is an immediate selection; it does not rewrite the configuration.

## Run and monitor

Start exactly **one** service instance:

```sh
swift run facetime-observer watch > observer.ndjson
```

In another terminal:

```sh
swift run facetime-observer monitor
```

Typical output:

```text
READY

14:32:52  CONFIRMING CALL — Expected Recipient
14:32:56  CALLING — Expected Recipient, audio
14:33:00  CONNECTING — Expected Recipient, audio
14:33:02  CONNECTED — Expected Recipient, audio, verified
14:33:10  ENDED — Expected Recipient, audio, participant left
```

`monitor --verbose` includes AX and process diagnostics. Stop with Ctrl-C.

The service is a foreground process. It holds an adjacent `.lock` file with a lifetime advisory lock before binding/unlinking the socket, rejects a second cooperating instance, and removes only its own socket on stop. Stop any older, pre-locking instance before starting this version. Talk also uses a separate controller lease so two Pi sessions cannot control the service concurrently.

## Unix socket protocol

Default socket:

```text
~/.local/share/pi-facetime/control.sock
```

The socket is created with mode `0600`; a newly created containing directory uses `0700`. An existing directory's permissions are not automatically repaired. Access is local to this Mac; no TCP server is created.

Protocol is UTF-8 **newline-delimited JSON**. A persistent connection carries responses and asynchronous events together. Every client receives an initial `snapshot` containing current call state, configuration summary, permission status, and process summaries.

Interactive access:

```sh
nc -U ~/.local/share/pi-facetime/control.sock
```

Paste one command per line and press Enter:

```json
{"type":"command","id":"status-1","command":"status"}
{"type":"command","id":"call-1","command":"call","to":"+46000000000"}
{"type":"command","id":"video-call-1","command":"call","to":"+46000000000","media":"video"}
{"type":"command","id":"answer-1","command":"answer"}
{"type":"command","id":"hangup-1","command":"hangup"}
{"type":"command","id":"devices-1","command":"audio.devices"}
{"type":"command","id":"screen-status-1","command":"screen.status"}
{"type":"command","id":"audio-1","command":"audio.select","input":"Pi Talk","output":"Pi Talk"}
{"type":"command","id":"inspect-1","command":"inspect"}
{"type":"command","id":"snapshot-1","command":"snapshot"}
{"type":"command","id":"discover-1","command":"discover"}
```

Use a real configured recipient only when intentionally placing a call. Commands have side effects; do not automatically replay call/answer/hangup/sharing commands after a timeout or disconnect. Only after an explicit sharing request, send `screen.share` with `display` equal to an exact picker display name and `expectedCallId` equal to the verified connected call ID. `screen.stop` likewise requires that current call ID. Never guess or reuse an earlier call ID.

### Commands

| Command | Behavior |
|---|---|
| `status` | Return cached call state and compact service diagnostics, including fixed-code `videoCallDiagnostics`; no reconciliation or call actions. |
| `call` | Optional `media: "audio" | "video"` (omitted = audio); enforce sole-owner recipient allowlist, apply routing, launch the corresponding FaceTime URL once, track outgoing intent separately from observed media. Null/unknown media and unknown arguments are rejected. |
| `answer` | Require an identified allowlisted incoming caller and attempt answering. |
| `hangup` | Attempt pressing the accessible `End` control. |
| `video.status` | Read the unique FaceTime video window, peer and local-preview/remote-view dimensions; returns `available: false` if missing or ambiguous. |
| `video.rotate` | Require `expectedWindowId` and `expectedPeer` from `video.status`; reveal and press the local preview's exact **Rotate Camera** control once. |
| `video.follow.status` | Read persistent follow enablement and current phase. |
| `video.follow.calibrate` | Record current preview shape as phone `portrait` or `landscape`, with `expectedWindowId`/`expectedPeer`; allowlisted views only, pauses follow. |
| `video.follow.set` | Persist boolean `enabled`; enabling requires a distinct calibrated pair. |
| `screen.share` | Require verified connected `expectedCallId` and exact `display`; share that entire display and verify Allow Control off. |
| `screen.stop` | Require verified connected `expectedCallId`; stop sharing and verify local controls. |
| `screen.status` | Read currently exposed sharing controls without opening UI; absent controls are unverified/unknown, not proof sharing stopped. |
| `audio.devices` | Read FaceTime's input/output menu entries and selection marks. |
| `audio.select` | Select supplied `input` and/or `output` exact device names. |
| `inspect` | Force reconciliation and return full current AX trees. |
| `snapshot` | Save cached process snapshots to `--snapshot-dir` or `./snapshots`. |
| `discover` | List likely FaceTime/call-related process candidates. |

Successful response example:

```json
{"type":"response","id":"hangup-1","ok":true,"result":{}}
```

Structured error example:

```json
{"type":"response","id":"call-1","ok":false,"error":{"code":"recipient_not_allowed","message":"Recipient must exactly match the Swift recipient allowlist"}}
```

A successful command response means the request/action was accepted or attempted—not that the call connected or the action's intended outcome occurred. A call response contains `callId`, `to`, and `requestedMedia`; it does not certify active video or the remote camera. If video URL launch fails but native retains the request, the response is an accepted/tracked result with `status: "retained"`, its call ID, and `error`, not an ID-less terminal rejection. Pi treats that result as an unconfirmed call error and never claims launch success. Only a call response can establish Pi's outgoing hangup target; events or snapshots alone cannot. Wait for lifecycle evidence. Snapshots advertise supported outgoing media in `configuration.callMedia: ["audio", "video"]`; protocol remains 1. Pi refuses video against older services without that capability so an ignored media argument can never silently select audio.

### Events

Semantic events include:

- `call.incoming`
- `call.confirmation_attempted`
- `call.answer_attempted`
- `call.dialing`
- `call.unknown`
- `call.connected`
- `call.ended`
- `call.failed`

Additional events include `bridge.status`, `audio.routing`, `video.layout_changed`, process starts/stops, and AX diagnostics. Consumers should filter for the event types they need and tolerate additional fields/types. `video.layout_changed` reports observed local-preview geometry, not a verified remote orientation.

Example:

```json
{"type":"event","protocolVersion":1,"seq":42,"timestamp":"2026-10-17T14:33:02.000Z","event":"call.connected","callId":"local-1","direction":"outgoing","identity":"Expected Recipient","media":"audio","durationSeconds":2,"verified":true,"evidence":"advancing_duration"}
```

Events, initial snapshots, and responses carry `protocolVersion: 1`. Events/snapshots include a per-process `serviceInstanceId`, and snapshots include the current `seq` watermark. Incoming events and incoming snapshot call state include an `allowed` boolean computed from the local caller allowlist. Call IDs/sequences remain local to one service instance; no event replay is provided.

For `call.failed`, `status: "retained"` explicitly means **nonterminal**: native keeps the call ID in `phase: "unconfirmed"` and blocks new calls/config reloads. Consumers must gate/close voice but retain any already-owned target; do not report standby or infer connection from late timers. `status: "terminal"` (or an omitted status on older services) keeps the ordinary terminal failure meaning. `status` uses an existing protocol-1 semantic field, so it survives Pi's event filtering. Retained UI disappearance emits one `call.ended` with the same call ID, `status: "terminal"`, and `evidence: "unconfirmed_video_ui_disappeared"` before native resets; disappearance alone remains unverified. Snapshots expose retained state as `call.phase: "unconfirmed"`; reconcile it without adopting unrelated calls.

`verified` describes an event's local evidence; it is not a universal delivery/success/authentication guarantee. In particular, `call.answer_attempted` currently reports successful event creation/posting, not confirmation that FaceTime accepted the call. Audio uses an advancing timer; outgoing video uses the stable identity-matched participant scene described below.

A client should correlate responses by `id`, parse complete newline-delimited records across arbitrary socket chunks, impose request timeouts, reconnect, and reconcile the new initial snapshot. Do not assume one socket read equals one JSON record. The server bounds input frames to 64 KiB and queued output per client to 1 MiB; stalled output is disconnected after a five-second drain deadline. Oversized inspection output can disconnect a client.

## Video preview rotation and aspect changes (socket only)

The circular-arrow control in the local preview is exposed as **Rotate Camera**. It changes the Mac's local camera orientation/aspect, not the remote phone's camera state. No Pi tools are added. Rotation is manual unless calibrated follow mode is explicitly enabled.

Read the current visible video context first:

```json
{"type":"command","id":"video-1","command":"video.status"}
```

When `available: true`, the response includes `windowId`, `peer`, `pid`, `window`, `localPreview`, `remoteView` and `rotationAvailable`. Dimensions include `width`, `height`, and `aspectRatio`. Use the returned target values verbatim for one explicit rotation request:

```json
{"type":"command","id":"rotate-1","command":"video.rotate","expectedWindowId":"PID:SceneWindow","expectedPeer":"Exact displayed peer"}
```

`video.rotate` scopes the unique enabled **Rotate Camera** AX button to that same FaceTime window and peer. If hidden, it briefly moves the pointer to the dynamically located local-preview center, waits for the button, then restores the pointer. It never uses a fixed-coordinate click, changes either camera's enabled state, or retries a press. Its result distinguishes `attempted` from `verifiedChange`: AXPress acceptance alone is not proof of a visible geometry change. Window/peer changes, missing controls, and ambiguity fail closed.

Video-window commands intentionally do not depend on the call tracker, which can report `call.phase: idle` during an unowned/manual full video call. Their target guard is **visible video context**, not verified telephony connection or cryptographic peer identity. A window identifier can be reused by FaceTime; do not reuse target values across calls or automatically replay rotations. A `video` summary is also included in ordinary snapshots.

Socket watchers receive `video.layout_changed` when the local preview's aspect ratio changes by more than 2%, with `before`/`after` dimensions, `windowId`, `peer`, `source: "local_preview_geometry"`, and `remoteOrientation: "unknown"`. Initial observation, ordinary proportional resizing, and a replacement/disappearing context do not create a rotation event. Observation uses normal reconciliation (default two seconds), so very brief changes may be missed. A layout change can come from remote device rotation, the local Rotate Camera button, or other FaceTime layout changes—it is not a definitive phone-orientation signal. The event itself is not an action request. Optional calibrated follow mode below samples the same geometry independently; Pi's semantic event filter remains unchanged.

Live probe on English macOS 26.6 / FaceTime 36: rotating the phone **with its camera off** produced `VCSessionMessageTopicDeviceOrientation` in macOS logs and changed the Mac's local preview from **150×100** to **150×69**, while the main window stayed fixed. Manually pressing Rotate Camera also changed the preview to **84×150**. Thus remote camera-on is not required for this observed signal in that configuration. The controller does not scrape private system logs or depend on their undocumented payloads; those logs were used only for the probe. The installed socket command was also live-tested: one `video.rotate` press changed **150×84 → 84×150** and returned `verifiedChange: true`; a camera-off phone rotation was subsequently received as `video.layout_changed` over the socket. Behavior on other devices/OS versions remains a compatibility assumption, not a guarantee.

### Persistent automatic matching for allowlisted video calls

Follow mode is initially disabled and requires **four measured cases**, not a reciprocal/shared ratio model:

| Mac preview axis | Phone pose to record |
| --- | --- |
| Horizontal (`landscape`) | Portrait, then landscape |
| Vertical (`portrait`) | Portrait, then landscape |

Disable follow during calibration. Keep the phone/camera/layout settings you will use normally, hold each phone pose still for several seconds, and use fresh `video.status` target values. Do not press Rotate Camera between the two phone samples for a given Mac axis; press it once manually (or use guarded `video.rotate`) only when switching to the other Mac-axis profile. `expectedLocalAxis` is recommended: it prevents accidentally overwriting the wrong profile if FaceTime changes the preview axis. After recording the second phone pose, return to the first and refresh that sample: Rotate Camera can leave a temporary 16:9 crop even while the phone is held in the correct pose. Wait several seconds in each intervening phone pose so FaceTime receives a fresh orientation change.

```json
{"type":"command","id":"cal-h-p","command":"video.follow.calibrate","orientation":"portrait","expectedLocalAxis":"landscape","expectedWindowId":"PID:SceneWindow","expectedPeer":"Exact displayed peer"}
{"type":"command","id":"cal-h-l","command":"video.follow.calibrate","orientation":"landscape","expectedLocalAxis":"landscape","expectedWindowId":"PID:SceneWindow","expectedPeer":"Exact displayed peer"}
{"type":"command","id":"cal-v-p","command":"video.follow.calibrate","orientation":"portrait","expectedLocalAxis":"portrait","expectedWindowId":"PID:SceneWindow","expectedPeer":"Exact displayed peer"}
{"type":"command","id":"cal-v-l","command":"video.follow.calibrate","orientation":"landscape","expectedLocalAxis":"portrait","expectedWindowId":"PID:SceneWindow","expectedPeer":"Exact displayed peer"}
{"type":"command","id":"follow-on","command":"video.follow.set","enabled":true}
{"type":"command","id":"follow-status","command":"video.follow.status"}
{"type":"command","id":"follow-off","command":"video.follow.set","enabled":false}
```

Calibration stores **raw width/height ratios** in two independent per-peer profiles, `macLandscape` and `macPortrait`, each with phone `portrait` and `landscape` samples. Classification first chooses the currently observed Mac axis, then compares only against that profile's measured phone samples. It never inverts horizontal ratios to invent vertical samples or swaps their meanings. Both profiles must have distinguishable samples before any automatic rotation is allowed; unknown/ambiguous shapes cause no action. Follow status and calibration responses include per-profile progress.

Preferences version 2 migrates old samples only into the Mac axis explicitly recorded with each sample, converts their stored magnitude back to the measured raw ratio, and forces follow off. Unrecorded axes remain empty; complete the missing measurements and explicitly re-enable. Migration does not authorize callers. With enablement persisted, future video views for a calibrated peer run automatically **only while that peer still matches the currently loaded shared caller allowlist**. Display-name matching is not cryptographic caller authentication. The same video-window targeting limitations as `video.rotate` apply.

Two stable samples spanning at least one second are required (normally about 2–4 seconds with the reconciliation interval). Follow clicks Rotate Camera once only when the preview axis disagrees with the calibrated phone state. It rechecks enablement, peer/window, allowlist and target before each delayed action, verifies the resulting axis, and waits five seconds after an attempt. Separate per-axis lookup handles the different layouts seen before and after a camera-axis flip. Because Rotate Camera can also reset crop to another ratio, the follower verifies the requested axis and quarantines its own post-click shape until a fresh, different shape arrives; it never interprets that self-caused crop as a new phone state. Failed/unverified actions latch a pause for that phone state rather than retrying; a genuinely different recognized phone state, new video context, or explicit disable/re-enable releases the latch. `video.follow` events report `rotating`, `matched`, or `paused_after_failure`; snapshots include `videoFollow` status.

This is an **empirical geometry heuristic**, not an authoritative device-orientation API. If a genuine phone rotation produces exactly the same shape as the quarantined self-caused crop, geometry alone cannot distinguish it and follow waits instead of risking a toggle loop. Camera/crop/layout changes can invalidate calibration. Transient missing views pause observation without clearing a failed-click latch for the same window/peer. Disable and recalibrate if behavior changes. Follow never enables a camera, shares a screen, initiates/answers a call, or changes device routing. It may briefly move/restore the pointer to reveal Rotate Camera. Disable follow before using manual rotation if you do not want it corrected back.

Regression tests use deliberately non-reciprocal horizontal/vertical profiles, the live-measured four-case ratios, and repeated vertical→horizontal→vertical transitions. Live validation confirmed automatic vertical→horizontal and horizontal→vertical corrections; both produced `video.follow` events with `status: "matched"` and `verified: true`, and the user confirmed both results. Follow remained enabled with both profiles complete. Other phone/layout combinations need their own four-case calibration.

Enablement and calibration persist in the app's `dev.mypi.facetime-bridge` preferences domain under a key scoped to the selected absolute `talk.json` path. They are UI preferences, not another authorization/audio config. Invalid preferences disable automation. Each calibration action persistently disables follow until explicitly re-enabled; service stop cancels pending actions but does not erase preferences.

## Entire-screen sharing

Sharing is manual-only and uses Control Center's FaceTime controls and exact **Share DISPLAY** picker button through Accessibility; it never clicks fixed coordinates. `screen.share` requires `display` plus `expectedCallId`; `screen.stop` requires `expectedCallId`. The call must still be verified connected before each delayed action. Pi additionally requires ownership of that call. The service serializes sharing actions and does not retry mutations.

Success requires observing active sharing and **Allow Control = off**. macOS may default Allow Control to on when sharing starts; the bridge turns it off immediately afterward, so this is **not** a guarantee that it was never briefly enabled. It never accepts a remote-control request. A failure to establish viewing-only triggers a best-effort stop of that share, not a success claim. UI errors/timeouts require manual review. No background sharing or window-selection support is included. See [INTEGRATION.md](INTEGRATION.md) for limitations and manual commands.

## How call detection and control work

### Observation

`NSWorkspace` discovers candidate processes. AX observers subscribe to available notifications. Full tree reconciliation runs periodically (default two seconds), updating the semantic state machine. Currently AX callbacks emit diagnostics; semantic state transitions are primarily driven by reconciliation, not immediate notification-triggered reads.

For audio/incoming banner observation, the important banner belongs to **Notification Centre**, not FaceTime.app, and exposes `FACETIME_NOTIFICATION`. Outgoing video uses a separate FaceTime standard-window path; it does not borrow audio's banner selectors.

### Incoming

An incoming banner exposes caller text and `Answer`/`Decline`. The service extracts the identity and requires a normalized allowlist match before answering. Auto-answer is opt-in and schedules one attempt per tracked call after a short 600 ms stabilization delay.

**Incoming Answer is the deliberate coordinate fallback:** `AXPress` returned success but caused the call to fail on the tested macOS. The service instead reacquires the caller-verified banner and its exact Answer element, reads its live AX position/size, posts a mouse click at the dynamic center, then restores the pointer. No fixed coordinates are stored. This requires a visible GUI session and can briefly move the pointer; occlusion, animation, or concurrent user interaction remain limitations.

### Outgoing

The service opens `facetime-audio://…` for audio (the backward-compatible default), or `facetime://…` for explicitly requested video, explicitly with FaceTime via `NSWorkspace`. [Apple's FaceTime Links reference](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/FacetimeLinks/FacetimeLinks.html) documents the native video scheme; its archived audio examples are marked iOS-only, while this service retains its existing macOS audio behavior. There is no fallback between schemes/media.

Audio retains its **Click to Call** Notification Centre path, exact requested-address/configured-alias matching, unique banner/Call control, and explicit-media mismatch/ambiguity vetoes. Generic audio confirmations remain supported. Video never falls back to that path.

The supplied read-only video observation instead showed a **FaceTime AXStandardWindow** (1024×640) containing a two-static-text group, enabled AXPress **Cancel**/**Call** buttons, and separate Cancel/Call static labels. There was no established **FaceTime Video** label or `FACETIME_NOTIFICATION`. Video therefore requires a complete idle FaceTime preflight (no existing call/confirmation UI), exactly one configured owner and one pending newly launched video request, that scoped structural layout, and the first static-text field exactly matching the whole requested address or an explicitly configured alias after normalization (the secondary content field cannot substitute). Multiple candidate windows/controls, disabled/non-pressable controls, conflicting identities or explicit opposite/unresolved media choices fail closed. Window dimensions are descriptive, not selectors. Identity/control structure is freshly reacquired before one AXPress; no retry or coordinate fallback is used. Request correlation is not independent evidence of observed media: confirmation events report `media: null`.

**Unresolved evidence:** the redacted confirmation text has not established whether either static text is a standalone recipient/alias. If the first field is embedded prose, the identity appears only in secondary content, or it differs from configured identities, automatic confirmation remains unavailable; no guessed phrase, identifier, substring extraction or Contacts lookup is added. Cancel has not been automated; review/cancel manually after an unconfirmed result.

The confirmation is not treated as ringing or connection. The requested address is stable, but any friendly-name alias is an explicitly configured trust mapping, not independent proof of the underlying remote handle. `requestedMedia` is separate from observed `media` in call state/events; until observed, media is null. Neither label nor connection verification proves an active video stream or remote camera-on state.

**Outgoing video connection evidence:** paired manual ringing/answered captures established that End/Camera/Microphone exist while ringing, but `ParticipantGridView`, the remote participant button and `LocalParticipantView` appear after answer. Video call tracking now uses those measured structures independently of `VideoLayout.swift`'s rotation-specific fullscreen action. It requires one complete window, one grid/local preview pair and one grid-sized sibling remote participant whose whole description matches the configured recipient/alias. Two consecutive complete observations of the same window and peer establish `call.connected` with `evidence: "stable_identity_matched_video_participants"`. An uncertain read, ringing layout or changed context breaks preconnection stability. The auxiliary duration-like text was never validated as an elapsed call timer and is no longer parsed or required for video. Audio retains its advancing-duration gate.

This is empirical local UI evidence, not a native telephony API or proof that the remote camera is on. Neither URL launch, generic controls, a lone window nor one participant observation is sufficient. Unsupported/ambiguous layouts remain gated. The call tracker does not activate, hover or reveal controls to observe connection.

Native read-only `status` and initial snapshots include `videoCallDiagnostics: {observation, connectionGate}`: one cached fixed-code observation, not a history or a fresh AX probe. Codes distinguish ringing, identity-matched participants, layout/peer/window rejection, waiting for a second stable participant observation, verified video state and retained failure. The diagnostic object contains no identities, UI text, raw values, window IDs or paths; ordinary status fields still contain their existing private call details. **Do not use `inspect` to obtain these diagnostics:** it forces reconciliation and returns private AX trees, and reconciliation can perform routing/call actions. Pi's existing `facetime_status` tool remains its coordinator summary; these extra codes are in the native socket `status` result, not newly forwarded to the model.

Synthetic regression fixtures now mirror the paired ringing/answered captures without timer text or fullscreen actions. They cover stable participant gating, hover-hidden controls, ambiguity, identity/window changes, retained failures and audio regressions. No incoming-answer, camera, rotation/follow, sharing or routing behavior is changed. Automated end-to-end behavior still requires manual validation after installation.

### Connected

The tested outgoing ringing description looks like `FaceTime Audio…`. After answer, a duration appears (`0:00`, `0:02`, ...).

For audio, the service emits `call.unknown` on the first duration observation and verified `call.connected` only after the duration advances. Outgoing video emits `call.unknown` on the first complete identity-matched participant scene and connects only after the same scene is observed again. A hangup/mute/keypad control can already exist while ringing and is never sufficient connection evidence.

### Ended and failed

The state machine observes panel disappearance and participant-left notifications. Disappearance requires two missing reconciliations unless a participant-left notification is present. A successful local `End` action marks a requested local hangup; actual UI disappearance supplies subsequent ending evidence.

Failure handling includes call UI startup timeout, ringing timeout, observed unapproved recipient identity, and some failure text exposed inside the call banner. Audio timeout/End handling is unchanged. Outgoing video End requires the unique current video window and tracked displayed identity, with one enabled AXPress End control freshly reacquired; it is attempted at most once per request, including timeout handling. A changed peer/window is never ended automatically. Video launch errors, connection timeouts and changed contexts emit one unverified `call.failed` with `status: "retained"` and retain `callId` in `phase: "unconfirmed"`, keeping new requests/config reload blocked until two complete observations establish UI disappearance. Disappearance then emits terminal `call.ended` before releasing ownership, so connected consumers do not stay busy on a silently discarded call. Pi closes voice but retains its owned target, reports unconfirmed/busy, rejects new calls before voice preparation, and permits one explicit hangup request (native video End is independently one-shot). A same-instance/same-ID reconnect keeps that latch; unrelated snapshots are never adopted, and an idle snapshot clears missed terminal state without inventing an event. Unreadable/ambiguous trees do not count as disappearance; they break the missing-observation streak. A surviving confirmation is not silently cancelled and late timer advancement cannot reconnect a failed request. Manual UI review may be necessary. The service never kills FaceTime as a workaround. Remote decline versus early cancellation, network failure, and unknown disappearance cannot always be distinguished reliably. Account/network errors outside the observed banner are not comprehensively classified.

Persistent `Call Failed` banners do not create repeated new calls. Only one call is tracked; multi-call/conference scenarios and localization need further work.

## Inspection and snapshots

```sh
swift run facetime-observer discover
swift run facetime-observer dump --bundle com.apple.FaceTime
swift run facetime-observer dump --process Notification --keyword Answer
swift run facetime-observer snapshot --snapshot-dir ./snapshots
swift run facetime-observer watch --snapshot-dir ./snapshots > observer.ndjson
swift run facetime-observer --help
```

With `--snapshot-dir`, snapshots are saved at semantic call transitions, not every timer tick. Dumps support role/title/description/value/identifier/action inspection and depth/node limits.

**Logs and snapshots contain private caller details, emails, phone numbers, and potentially unrelated accessible UI text.** Do not commit them or personal configuration. Build output, logs, and snapshots are machine-local artifacts, not source to distribute.

## Source map

| File | Responsibility |
|---|---|
| `main.swift` | CLI/app entry dispatch, configuration application, service lifecycle, commands, routing, and timeouts. |
| `Application.swift` | Standalone menu-bar app and explicit Accessibility/service controls. |
| `Configuration.swift` | JSON configuration and permission checks. |
| `Processes.swift` | Candidate process discovery. |
| `AXInspector.swift` | Tree reading and AX observation. |
| `AXActions.swift` | Answer, confirmation, and end-control actions. |
| `AudioRouting.swift` | FaceTime's hidden device menu and `AXPick` selection. |
| `ScreenSharing.swift` | Call-guarded entire-display sharing through Control Center, state verification, and Allow Control disabling. |
| `VideoLayout.swift` | Socket-only local-preview rotation, video-context guards, and observed aspect-ratio events. |
| `VideoFollow.swift` | Per-peer calibration preferences and allowlist-gated automatic matching with debounce, feedback suppression, and failure latch. |
| `FaceTimeCalling.swift` | Strict outgoing media validation and explicit audio/video URL selection/launch. |
| `CallState.swift` | Audio/banner advancing-duration tracking, stable video participant gating and retained unconfirmed ownership. |
| `VideoCallUI.swift` | Pure scoped video confirmation, ringing/participant observation and End selectors. |
| `SocketServer.swift` | Single-instance Unix socket, bounded NDJSON framing, and nonblocking client output. |
| `ServiceMetadata.swift` | Service instance/sequence metadata and incoming allowlist flags. |
| `ServiceRun.swift` | Per-start lifecycle token that prevents stopped services from executing stale callbacks. |
| `HumanMonitor.swift` | Human-readable socket client. |
| `JSON.swift` | JSON, timestamps, and AX value/error formatting. |

## Talk integration boundary

The Swift executable stays independent at runtime. Talk's TypeScript coordinator connects to this socket, prepares gated virtual audio before answering, exposes tools only in FaceTime mode, and returns to standby after owned calls end. The shared file has no auto-answer flag: Swift observes/enforces policy, while Pi prepares Talk and requests Answer. A debug CLI service with standalone auto-answer enabled is rejected by the coordinator.

Regular Talk and FaceTime mode are mutually exclusive. Hangup, service disconnects, Pi-session changes, and the ten-minute limit close only owned voice resources; they do not abort queued/running Pi work. Audio remains on existing virtual devices, never on the control socket. Detailed setup and limitations are in [INTEGRATION.md](INTEGRATION.md).
