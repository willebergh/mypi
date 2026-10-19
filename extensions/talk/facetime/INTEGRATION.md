# FaceTime mode in Talk

FaceTime is an alternative audio/call mode for Pi. One **main session** owns FaceTime and audio; explicitly connected named sessions can supply the conversation backend. See [multi-session Talk](../MULTISESSION.md) for connection, metadata, handoff and webcam-sharing boundaries. History, captions, voice delegation and normal tool permissions use the existing Talk pipeline; remote voice questionnaires and remote voice Stop are initially unavailable. FaceTime carries audio through virtual devices; its Unix socket carries control/status only.

## One-time setup

1. Build the protocol-7 Rust and Swift helpers directly, following [`/skill:setup`](../../../.pi/skills/setup/SKILL.md) and its [native Talk](../../../.pi/skills/setup/references/native-talk.md) and [FaceTime app](../../../.pi/skills/setup/references/facetime-app.md) references for prerequisites and exact build/signing steps. Stop active calls and quit the helper before rebuilding. A protocol-6 helper is intentionally rejected because it cannot enforce UID-only hidden routing.

2. Build and install the GPLv3 Pi Talk driver as described in [the driver guide](../macos-audio-driver/README.md). Close audio clients before installation; the installer places `PiTalk.driver` under `/Library/Audio/Plug-Ins/HAL` and restarts Core Audio. Normal device menus should then show one visible **Pi Talk** device and must not show **Pi Talk Internal**.

3. In Pi, `/reload` then `/talk devices diagnostics` creates/migrates the shared **`~/.pi/agent/talk.json`** and verifies the hardcoded virtual route. Configure its `facetime` section as described in [configuration](../CONFIG.md): exact caller/recipient allowlists, owner-only permissions, and Accessibility access. Swift reads its `facetime` policy; there is no persisted auto-answer switch. Pi prepares Talk before requesting Answer. Keep FaceTime open in the logged-in GUI session. Do not run as root.

4. Install and open the independent app:

   Follow the manual build/install steps in [APP.md](APP.md), then open the installed app through LaunchServices:

   ```sh
   open "$HOME/Applications/Pi Talk.app"
   ```

   Use the app menu's explicit Accessibility controls and verify that macOS grants access to **Pi Talk**, not CMUX. Stop the old CLI service before opening the app; never run both. See [APP.md](APP.md) for local signing, rebuilds, and attribution testing. Pi still does not auto-launch the app or install a LaunchAgent. The optional developer CLI (`swift run --package-path extensions/talk/facetime facetime-observer watch`) remains available, but may require Accessibility on its terminal and must have its private diagnostic stdout drained.

5. In Pi, optionally select physical devices and verify the fixed virtual route:

   ```text
   /talk devices
   /talk devices diagnostics
   ```

   Swift requires shared schema **version 2**. `audio.physical` keeps the optional microphone/speaker device pair for regular Talk. `audio.virtual` contains exactly `visibleUid: "io.github.willebergh.pitalk.audio.visible"` and `internalUid: "io.github.willebergh.pitalk.audio.internal"`; missing, altered, or additional fields are rejected. The shared file remains `~/.pi/agent/talk.json` (under `getAgentDir()` for custom directories).

   FaceTime uses the driver's visible **Pi Talk** device for both microphone and output; Talk uses the internal endpoint. There is no inverse device pair or physical-device fallback. The Pi Talk driver must be installed.

   On `/talk facetime` enable, Pi requires the same config path, asks the idle Swift service to reload/apply **Pi Talk** in both directions, then verifies both routes before standby. Normally this requires both exact FaceTime menu marks. When FaceTime omits its entire Microphone section because Pi Talk is the sole/default input, the bridge instead requires Core Audio's current default-input UID to exactly equal the fixed Pi Talk visible UID and reports that verified route to Pi. A present selector or any UID mismatch still uses/fails the normal strict menu path. Pi does not issue a duplicate selection. For custom agent directories, use the app's **Choose Talk config…** menu and Stop/Start to select that exact file. Settings changes apply at the next mode start, never mid-call.

## Commands and tools

```text
/talk                         Regular Talk with physical devices
/talk start virtual           Direct virtual Talk; call app is managed manually
/talk facetime                FaceTime standby; no GPT-Live connection while idle
/talk facetime status
/talk facetime call [--audio|--video] [--reason CALL_PURPOSE]
/talk facetime answer
/talk facetime hangup          Request End; standby only after terminal evidence
/talk facetime share DISPLAY   Share one entire display by its exact picker name
/talk facetime stop-sharing    Stop sharing without ending the call
/talk stop                    End owned call/voice; leave standby
/talk status
/talk devices                 Select physical microphone/output directly
/talk devices diagnostics     Verify the hardcoded virtual route
/talk devices physical reset  Reset physical profile only
/talk devices reset           Reset physical profile only; preserve call policy
```

`/talk devices` opens the physical microphone and output pickers directly. Virtual UIDs are hardcoded schema values and never appear in a picker; diagnostics are explicit. Changes never rewire an active call; restart the mode to apply changes. Regular Talk and FaceTime mode cannot run together.

Only FaceTime mode exposes `facetime_status`, `facetime_call`, `facetime_answer`, and `facetime_hangup`. On leaving the mode they are hidden/deactivated; stale executions are rejected. Call tools do not change allowlists or audio profiles. FaceTime mode requires exactly one owner in `allowedRecipients`; `facetime_call` accepts a required concise `reason` (known result/update/question, at most 300 UTF-8 bytes) and optional `media: "audio" | "video"`; omitted media means **audio**. Pi resolves the owner locally. The model cannot select or override the recipient. That purpose stays in Talk context, not in the Swift dial command. Terminal calls can supply it with `--reason`; without it, no agenda is invented. Outgoing calls require an explicit user request; merely enabling standby is not authorization to dial. Video additionally requires the user to explicitly request video. Never silently upgrade audio or fall back from video to audio.

Examples: `/talk facetime call` preserves audio; `/talk facetime call --video --reason Discuss the verified result.` requests video. `--audio` is also accepted. At most one media flag is allowed, **before** `--reason`; reason consumes the remaining plain text (no `--…` tokens). Duplicate, conflicting, unknown, misplaced flags, recipient arguments, empty reasons, and oversized/unsafe text are rejected before voice preparation/submission. The argument tail is bounded to 1024 UTF-8 bytes; purpose remains limited to 300 bytes. The greeting/purpose flow is unchanged for both media.

Video requires an updated native bridge advertising `configuration.callMedia: ["audio", "video"]`; older protocol-1 bridges may ignore unknown arguments, so Pi rejects video before submission when that capability is absent. The model tool name remains **`facetime_call`**. A later Pi `/reload` may be needed to expose its optional `media` parameter; the Swift app needs a later build/restart to advertise and implement video. These are manual follow-up steps, not performed by this change.

## Manual entire-screen sharing

`facetime_share_screen` takes the exact `display` name shown by macOS (for example, `LS32A600U`); `facetime_stop_sharing` takes no arguments. Both require an explicit user request and the current Pi-owned, verified connected call with audio enabled. They are unavailable in standby or outside FaceTime mode. There is no automatic sharing, fuzzy display matching, window selection, or remote-control granting.

The bridge opens Control Center's Audio and Video Controls, verifies the FaceTime panel's caller identity, opens its screen picker, and presses only the unique **Share DISPLAY** button. It verifies **Currently Sharing** and turns **Allow Control** off if macOS enabled it. **Important:** macOS can default Allow Control to on as sharing starts; it is disabled immediately afterward and success is reported only after off is observed. This is not a zero-time remote-control exclusion guarantee. If off cannot be verified, the bridge attempts to stop that share and reports failure. Do not use automated sharing if even that brief default-on interval is unacceptable. No remote-control request is accepted by this integration.

Sharing operations carry the expected call ID, are serialized, and recheck the call before delayed UI actions. They allow up to 12 seconds for picker/panel/start verification plus 3 seconds for safety cleanup; sharing IPC uses a separate 20-second deadline (ordinary commands remain at five seconds). Timeout errors include the phase and bounded control-state diagnostics, not UI trees. They never replay clicks after timeout/disconnect. The menu/picker can move focus; user interaction, multiple matching displays, localization, and OS UI changes can cause an unconfirmed result. Check FaceTime manually after errors—do not retry automatically. A successful start verifies the picker action and local sharing controls, not remote receipt of pixels or ongoing isolation from later manual changes. Stop/quit of the bridge does not promise to stop an already active share; use the sharing stop tool or FaceTime controls first.

Validation: the macOS 26.6 controls and their active/off values were inspected during manual entire-display sharing. The automated controller has synthetic sequencing, stale-call, duplicate-target, timeout, safety-stop, and remote-control-off tests; an end-to-end automated live start/stop remains to be validated. For a live check, use a harmless display, verify it is received remotely, confirm Allow Control is off, stop sharing, and verify both the local indicator and remote view stop. No sharing is started merely by installing, reloading, or enabling standby.

## Call lifecycle

- One main Pi session holds a machine-wide controller lease beside the service socket. Other Pi sessions cannot take control; explicitly connected destinations execute selected voice requests through private local IPC, without opening another audio endpoint or obtaining call controls. The Swift service also enforces a single service instance.
- An **allowlisted incoming event** prepares one Talk connection with both audio directions gated. Pi requests Answer once it is ready. No existing FaceTime call is adopted when enabling the mode.
- Both audio directions are enabled only after locally verified `call.connected` evidence: advancing duration for audio; two consecutive complete, same-window/peer participant scenes for outgoing video. Command acceptance/Answer posting alone does not establish connection. Known observed media that conflicts with the requested medium keeps/closes the audio gate and reports an error, without redialing or changing media.
- Outgoing intent is reported as `requestedMedia`, separately from the native tracker's observed `media` (Pi status: `observedMedia`). Before media is observed, it is unknown—not copied from the request. Neither URL launch, confirmation, an observed video label, nor an advancing duration proves an active video stream or the remote camera is on.
- For outgoing calls only, after audio is enabled, GPT-Live receives quiet connection/greeting instructions and the supplied purpose as reference context, followed by the speakable greeting **"Hello sir"**. The startup prompt instructs it to say only that phrase, wait for the first fresh user reply (even "hi"), then explain the purpose naturally. No timer advances the greeting, and the reply is audibility acknowledgement only—not task approval or an answer to a separate question. Substantive questions or hearing problems should be handled appropriately instead of assuming confirmation. Without a specific purpose, it asks what to discuss after the reply. The introduction request is sent once per owned call, not while ringing or after reconnecting; incoming and failed calls do not receive it. This conversation ordering is model-prompt guidance and requires live validation.
- Terminal end/failure cancels pending preparation and closes only the owned Talk connection, returning to standby. A nonterminal video `call.failed` with `status: "retained"` instead closes voice while retaining the owned target in **unconfirmed** (busy, not standby). New audio/video calls fail before voice preparation. One explicit user hangup request is still permitted; acceptance or failure is not terminal evidence, and neither Pi nor native retries End. The ordinary ten-minute Talk limit ends the owned call and returns to standby after terminal evidence. Call status is shown in the existing dashboard Talk/mic slot.
- An observed **terminal** end/failure of an owned call queues a hidden `talk-facetime-event` custom message with native follow-up delivery and `triggerTurn: true`. This can wake an idle agent or schedule a turn after current work/final output; it does not guarantee silent handling. The message explicitly grants no answer, approval, cancellation of work, or permission to retry a task. Unowned or duplicate terminal events do not wake the agent.
- Losing FaceTime voice returns a pending voice `ask_user` as cancelled/unanswered, preserving earlier confirmed answers but never its unconfirmed candidate. This releases the tool **without opening another blocking terminal dialog**, allowing the queued lifecycle message to be consumed. Regular Talk's existing terminal fallback is unchanged; new questions in standby use the terminal normally.
- Hanging up, leaving standby, or changing Pi sessions does **not abort coding work or clear Pi's queue**. Normal Talk provenance/history rules still apply; old spoken results are not replayed into a later call.
- A service disconnect immediately gates/closes voice. Reconnection reconciles a fresh snapshot. A previously owned, verified call may resume with a fresh Talk connection only when service instance/call identity still match. A retained failure or same-owned `phase: "unconfirmed"` snapshot permanently prevents voice resumption for that call, even after late connected evidence. Unrelated calls (including unconfirmed snapshots or a restarted service reusing the ID) are not adopted or hung up. An idle snapshot clears a retained call whose terminal event was missed, without fabricating an ended notification.
- Requests time out as unconfirmed and are never automatically replayed. A successful tool/terminal command is not proof of audible delivery or completed call state.

The call controls still have no expected-call token in the Swift commands. Audio retains its existing current-banner behavior and accepted stale-command limitation. For owned outgoing video, the service additionally scopes End to the tracked window and displayed identity, requires a unique enabled AXPress control, and permits at most one End attempt per request. Fresh reacquisition reduces stale-target risk but Accessibility reads/actions are not atomic or a race-free telephony API. Automatic mutation retries remain disabled.

## Limits and testing

FaceTime control uses Accessibility/UI evidence against English macOS UI. Apple documents `facetime://…` for native video calls; audio retains `facetime-audio://…` and its existing Notification Centre confirmation/observation/End path. The video participant-scene correction is based on paired manual ringing/answered AX captures, with synthetic regression coverage; automated end-to-end success is not yet claimed.

The supplied read-only video observation showed an unlabelled FaceTime **AXStandardWindow**, a two-static-text group, enabled **Cancel**/**Call** AXPress buttons and separate Cancel/Call static labels—not a `FACETIME_NOTIFICATION` banner. Only a sole pending explicit video request after a complete idle-UI preflight may match that scoped structure. Exactly one configured owner is required; the first static-text field must exactly normalize to the whole recipient or a configured alias; the secondary content field cannot supply a substitute identity. Multiple windows/controls, conflicting identities, disabled/non-pressable buttons or explicit opposite/unresolved media choices fail closed. The target is freshly reacquired before one AXPress; no guessed labels, coordinate click, fallback medium or retry is added. Confirmation has unknown observed media, even when correlated to video intent.

**Evidence limitation:** the redacted confirmation values do not establish that the UI contains a standalone identity value. If the first field does not exactly match the configured address/alias (including identity present only in secondary content), automatic confirmation is deliberately unavailable. No prose template/substring/unknown identifier is invented. This needs later user-authorized validation; a manual Call click in the supplied observation is not evidence that automation succeeded.

The outgoing video observer is independent of `VideoLayout.swift`'s fullscreen-action requirement. Paired captures showed End/Camera/Microphone while ringing, with no participant grid/local preview; after answer, `ParticipantGridView`, one grid-sized remote peer button and `LocalParticipantView` appeared. Connection requires that complete unique scene, whole-field recipient/alias matching and the same window/peer across two consecutive observations. The first scene is unverified; an uncertain/ringing read or context change breaks stability. Hover-hidden controls are not required. `call.connected` reports `evidence: "stable_identity_matched_video_participants"`; no duration is invented. The auxiliary duration-like text was not validated as an elapsed video timer and is no longer parsed. Generic controls, URL launch, a window or one scene sample cannot connect. This empirical UI gate does not prove remote receipt, camera-on or cryptographic peer identity. Audio keeps its existing advancing-duration behavior.

For future diagnosis, native read-only socket `status` exposes cached `videoCallDiagnostics.observation` and `.connectionGate` fixed codes (also in initial snapshots). These distinguish ringing, participant/identity/window rejection, awaiting a second stable participant scene and retained failure without identities, UI text, raw values or paths in the diagnostic object. Other ordinary status fields remain private. This is one last observation, not a history or a fresh UI read; it adds no reconciliation, mutation or retry. Pi's `facetime_status` coordinator summary is unchanged and does not forward these extra native codes. **Use native `status`, not `inspect`: `inspect` forces reconciliation (which can act) and returns private UI trees.**

A video startup/ringing timeout attempts only the unique current identity/window-scoped End, once. Missing confirmation Cancel semantics are not guessed. Launch errors, timeouts or changed window/identity emit one unverified `call.failed` with `status: "retained"` while retaining `callId` in `phase: "unconfirmed"`; late participant scenes cannot connect it and new calls/reloads remain blocked. Pi retains only a target it already owns. If video launch fails, native returns an accepted/tracked result with `status: "retained"`, its call ID and `error`; Pi reports unconfirmed failure, not launch success. An early retained event closes pending voice, but only the submission response establishes its outgoing hangup target. A rejected/lost response, unrelated event or snapshot never authorizes adopting a target. Ownership clears after two complete UI-disappearance observations, with one same-ID `call.ended`, `status: "terminal"`, `evidence: "unconfirmed_video_ui_disappeared"` emitted before reset so cached busy state clears. Unreadable/ambiguous reads are not disappearance. Ordinary audio failures and failures without retained metadata remain terminal; only terminal owned events queue the call-ended follow-up. Review/end/cancel surviving UI manually—never automatically replay the command. Incoming answering, camera enablement, orientation/follow, screen sharing and routing remain unchanged.

FaceTime control uses display-name matching, not remote camera/stream verification. Caller display names are allowlist matches, not cryptographic authentication. Answering uses a dynamically located mouse click; a visible GUI session is required. One call is supported; no conferencing, voicemail, DTMF, or remote approval bypass is added. Device routing can still be changed outside this integration; do not treat it as an OS-wide audio isolation guarantee.

The model never receives full AX trees from this integration. Semantic FaceTime events can enter the existing opt-in diagnostic trace; they can contain private caller identities. Normal terminal voice transcripts keep their existing format and renderer.

Synthetic checks (no calls or live Accessibility actions):

```sh
npm run check
npm test
swift test --package-path extensions/talk/facetime
```

Synthetic Swift fixtures mirror the paired ringing/answered structures using invented identities, no fullscreen actions and no timer. Regressions cover two-sample participant gating, hidden controls, ambiguous/missing views, changed identity/window, strict whole-field phone/email/name matching, confirmation safeguards, scoped one-shot End, retained failure/disappearance and unchanged audio-duration behavior. Focused TypeScript regressions separately cover retained ownership, voice gating, blocked redial, hangup and reconnect behavior. Broader root checks have known unrelated failures and are not a passing claim. Live paired AX inspection established the observed transition but does not establish automated end-to-end success.

Manual validation after an authorized build/install/restart: on a fresh explicit video request, check confirmation targeting, ringing remaining gated, stable identity-matched participant scenes enabling audio, greeting ordering, cancellation/timeouts and scoped End. Use cached native `status` diagnostics, not `inspect` or raw private UI dumps. Verify remote receipt/camera state independently and compare omitted/explicit audio for regressions. Missing or ambiguous participant/identity evidence must remain gated; never replay a call automatically.

Existing incoming live validation is manual: arm standby, call from an allowed device, check the virtual routing and connection gate, speak a harmless request, hang up, and confirm standby returns and Pi work continues. Test an unallowed caller and missing devices before relying on unattended answering.
