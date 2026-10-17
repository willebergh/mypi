# FaceTime mode in Talk

FaceTime is an alternative audio/call mode for the **same Pi session**. History, captions, voice delegation, questionnaires, and normal tool permissions use the existing Talk pipeline. FaceTime carries audio through virtual devices; its Unix socket carries control/status only.

## One-time setup

1. Build the local Rust and Swift helpers directly, following [`/skill:setup`](../../../.pi/skills/setup/SKILL.md) and its [native Talk](../../../.pi/skills/setup/references/native-talk.md) and [FaceTime app](../../../.pi/skills/setup/references/facetime-app.md) references for prerequisites and exact build/signing steps. Stop active calls and quit the helper before rebuilding. Existing native Talk builds already supporting protocol 6 need no Rust source change for audio gating; the updated Swift service is required for instance/sequence and allowlist metadata.

2. In Pi, `/reload` then `/talk devices virtual` creates/migrates the shared **`~/.pi/agent/talk.json`**. Configure its `facetime` section as described in [configuration](../CONFIG.md): exact caller/recipient allowlists, owner-only permissions, and Accessibility access. Swift reads its `facetime` policy; there is no persisted auto-answer switch. Pi prepares Talk before requesting Answer. Keep FaceTime open in the logged-in GUI session. Do not run as root.

3. Install and open the independent app:

   Follow the manual build/install steps in [APP.md](APP.md), then open the installed app through LaunchServices:

   ```sh
   open "$HOME/Applications/Pi FaceTime Bridge.app"
   ```

   Use the app menu's explicit Accessibility controls and verify that macOS grants access to **Pi FaceTime Bridge**, not CMUX. Stop the old CLI service before opening the app; never run both. See [APP.md](APP.md) for local signing, rebuilds, and attribution testing. Pi still does not auto-launch the app or install a LaunchAgent. The developer CLI (`swift run facetime-observer watch`) remains available, but may require Accessibility on its terminal and its diagnostic stdout should be drained.

4. In Pi, verify/select the profiles (physical is optional):

   ```text
   /talk devices physical
   /talk devices virtual
   ```

   `physical` is for regular Talk. Existing v1 selections migrate to that profile. `virtual` requires an explicit microphone and output—no system-default fallback. Both profiles live under `audio` in shared `~/.pi/agent/talk.json` (under `getAgentDir()` for custom directories), using CoreAudio IDs and display names. Editing/resetting audio preserves the same file's FaceTime policy. A profile is a generic audio pair, not a FaceTime-specific object; future service adapters can reuse it.

   Example mapping:

   | Application | Microphone | Output |
   |---|---|---|
   | Talk virtual profile | Agent Input | Agent Output |
   | FaceTime (inverse, applied by Swift) | Agent Output | Agent Input |

   FaceTime selection uses the saved friendly names, which must match its Video menu entries exactly. On `/talk facetime` enable, Pi requires the same config path, asks the idle Swift service to reload/apply the inverse pair, then verifies both menu marks before standby. It does not issue a duplicate selection. For custom agent directories, use the app's **Choose Talk config…** menu and Stop/Start to select that exact file. Settings changes apply at the next mode start, never mid-call.

## Commands and tools

```text
/talk                         Regular Talk with physical devices
/talk facetime                FaceTime standby; no GPT-Live connection while idle
/talk facetime status
/talk facetime call PHONE_OR_EMAIL [--reason CALL_PURPOSE]
/talk facetime answer
/talk facetime hangup          End owned call; remain in standby
/talk stop                    End owned call/voice; leave standby
/talk status
/talk devices physical reset  Reset physical profile only
/talk devices virtual reset   Clear virtual selections (must reconfigure to use it)
/talk devices reset           Reset both audio profiles; preserve call policy
```

`/talk devices` opens a **Physical / Virtual** profile picker first, followed by microphone and output pickers. Explicit `/talk devices physical` and `/talk devices virtual` shortcuts skip the first choice. Changes never rewire an active call; restart the mode to apply changes. Regular Talk and FaceTime mode cannot run together.

Only FaceTime mode exposes `facetime_status`, `facetime_call`, `facetime_answer`, and `facetime_hangup`. On leaving the mode they are hidden/deactivated; stale executions are rejected. Call tools do not change allowlists or audio profiles. `facetime_call` takes `to` and a required concise `reason` (known result/update/question, at most 300 UTF-8 bytes). That purpose stays in Talk context, not in the Swift dial command. Terminal calls can supply it with `--reason`; without it, no agenda is invented. Outgoing calls require a fresh explicit request or an already-authorized callback; merely enabling standby is not authorization to dial.

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
