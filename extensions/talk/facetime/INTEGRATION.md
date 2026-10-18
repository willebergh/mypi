# FaceTime mode in Talk

FaceTime is an alternative audio/call mode for the **same Pi session**. History, captions, voice delegation, questionnaires, and normal tool permissions use the existing Talk pipeline. FaceTime carries audio through virtual devices; its Unix socket carries control/status only.

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
/talk facetime call [--reason CALL_PURPOSE]
/talk facetime answer
/talk facetime hangup          End owned call; remain in standby
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

Only FaceTime mode exposes `facetime_status`, `facetime_call`, `facetime_answer`, and `facetime_hangup`. On leaving the mode they are hidden/deactivated; stale executions are rejected. Call tools do not change allowlists or audio profiles. FaceTime mode requires exactly one owner in `allowedRecipients`; `facetime_call` accepts only a required concise `reason` (known result/update/question, at most 300 UTF-8 bytes), and Pi resolves the owner locally. The model cannot select or override the recipient. That purpose stays in Talk context, not in the Swift dial command. Terminal calls can supply it with `--reason`; without it, no agenda is invented. Outgoing calls require a fresh explicit request or an already-authorized callback; merely enabling standby is not authorization to dial.

## Manual entire-screen sharing

`facetime_share_screen` takes the exact `display` name shown by macOS (for example, `LS32A600U`); `facetime_stop_sharing` takes no arguments. Both require an explicit user request and the current Pi-owned, verified connected call with audio enabled. They are unavailable in standby or outside FaceTime mode. There is no automatic sharing, fuzzy display matching, window selection, or remote-control granting.

The bridge opens Control Center's Audio and Video Controls, verifies the FaceTime panel's caller identity, opens its screen picker, and presses only the unique **Share DISPLAY** button. It verifies **Currently Sharing** and turns **Allow Control** off if macOS enabled it. **Important:** macOS can default Allow Control to on as sharing starts; it is disabled immediately afterward and success is reported only after off is observed. This is not a zero-time remote-control exclusion guarantee. If off cannot be verified, the bridge attempts to stop that share and reports failure. Do not use automated sharing if even that brief default-on interval is unacceptable. No remote-control request is accepted by this integration.

Sharing operations carry the expected call ID, are serialized, and recheck the call before delayed UI actions. They allow up to 12 seconds for picker/panel/start verification plus 3 seconds for safety cleanup; sharing IPC uses a separate 20-second deadline (ordinary commands remain at five seconds). Timeout errors include the phase and bounded control-state diagnostics, not UI trees. They never replay clicks after timeout/disconnect. The menu/picker can move focus; user interaction, multiple matching displays, localization, and OS UI changes can cause an unconfirmed result. Check FaceTime manually after errors—do not retry automatically. A successful start verifies the picker action and local sharing controls, not remote receipt of pixels or ongoing isolation from later manual changes. Stop/quit of the bridge does not promise to stop an already active share; use the sharing stop tool or FaceTime controls first.

Validation: the macOS 26.6 controls and their active/off values were inspected during manual entire-display sharing. The automated controller has synthetic sequencing, stale-call, duplicate-target, timeout, safety-stop, and remote-control-off tests; an end-to-end automated live start/stop remains to be validated. For a live check, use a harmless display, verify it is received remotely, confirm Allow Control is off, stop sharing, and verify both the local indicator and remote view stop. No sharing is started merely by installing, reloading, or enabling standby.

## Call lifecycle

- One Pi session holds a machine-wide controller lease beside the service socket. Other Pi sessions cannot take control. The Swift service also enforces a single service instance.
- An **allowlisted incoming event** prepares one Talk connection with both audio directions gated. Pi requests Answer once it is ready. No existing FaceTime call is adopted when enabling the mode.
- Both audio directions are enabled only after locally verified `call.connected` evidence (an advancing FaceTime duration). Command acceptance/Answer posting alone does not establish connection.
- For outgoing calls only, after audio is enabled, GPT-Live receives quiet connection/greeting instructions and the supplied purpose as reference context, followed by the speakable greeting **"Hello sir"**. The startup prompt instructs it to say only that phrase, wait for the first fresh user reply (even "hi"), then explain the purpose naturally. No timer advances the greeting, and the reply is audibility acknowledgement only—not task approval or an answer to a separate question. Substantive questions or hearing problems should be handled appropriately instead of assuming confirmation. Without a specific purpose, it asks what to discuss after the reply. The introduction request is sent once per owned call, not while ringing or after reconnecting; incoming and failed calls do not receive it. This conversation ordering is model-prompt guidance and requires live validation.
- End/failure cancels pending preparation and closes only the owned Talk connection, returning to standby. The ordinary ten-minute Talk limit ends the owned call and returns to standby too. Standby/unavailable status is shown in the existing dashboard Talk/mic slot.
- An observed end/failure of an owned call queues a hidden `talk-facetime-event` custom message with native follow-up delivery and `triggerTurn: true`. This can wake an idle agent or schedule a turn after current work/final output; it does not guarantee silent handling. The message explicitly grants no answer, approval, cancellation of work, or permission to retry a task. Unowned or duplicate terminal events do not wake the agent.
- Losing FaceTime voice returns a pending voice `ask_user` as cancelled/unanswered, preserving earlier confirmed answers but never its unconfirmed candidate. This releases the tool **without opening another blocking terminal dialog**, allowing the queued lifecycle message to be consumed. Regular Talk's existing terminal fallback is unchanged; new questions in standby use the terminal normally.
- Hanging up, leaving standby, or changing Pi sessions does **not abort coding work or clear Pi's queue**. Normal Talk provenance/history rules still apply; old spoken results are not replayed into a later call.
- A service disconnect immediately gates/closes voice. Reconnection reconciles a fresh snapshot. A previously owned, verified call may resume with a fresh Talk connection only when service instance/call identity still match. Unrelated calls are not adopted.
- Requests time out as unconfirmed and are never automatically replayed. A successful tool/terminal command is not proof of audible delivery or completed call state.

The call controls intentionally operate on the **current call**, with no expected-call token in the Swift commands. A delayed side effect can therefore affect a later call; that risk was explicitly accepted for this first version. Automatic retries are disabled, but this is not a race-free telephony API.

## Limits and testing

FaceTime control uses Accessibility/UI evidence, tested against English macOS UI. Caller display names are allowlist matches, not cryptographic authentication. Answering uses a dynamically located mouse click; a visible GUI session is required. One call is supported; no conferencing, voicemail, DTMF, or remote approval bypass is added. Device routing can still be changed outside this integration; do not treat it as an OS-wide audio isolation guarantee.

The model never receives full AX trees from this integration. Semantic FaceTime events can enter the existing opt-in diagnostic trace; they can contain private caller identities. Normal terminal voice transcripts keep their existing format and renderer.

Synthetic checks (no calls or live Accessibility actions):

```sh
npm run check
npm test
swift test --package-path extensions/talk/facetime
```

Live validation is manual: arm standby, call from an allowed device, check the virtual routing and connection gate, speak a harmless request, hang up, and confirm standby returns and Pi work continues. Test an unallowed caller and missing devices before relying on unattended answering.
