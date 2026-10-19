# Shared Talk configuration

Talk and the Swift FaceTime bridge use one active, owner-only configuration file:

```text
~/.pi/agent/talk.json
```

Pi resolves it with `getAgentDir()` (including `PI_CODING_AGENT_DIR`). This is user/machine configuration, not project `.pi/settings.json`. AI credentials remain in Pi's normal authentication storage.

## Version 2 shape

```json
{
  "version": 2,
  "audio": {
    "physical": {},
    "virtual": {
      "visibleUid": "io.github.willebergh.pitalk.audio.visible",
      "internalUid": "io.github.willebergh.pitalk.audio.internal"
    }
  },
  "facetime": {
    "allowedCallers": ["Expected Caller"],
    "allowedRecipients": ["+46000000000"],
    "recipientAliases": { "+46000000000": ["Expected Recipient"] },
    "callStartTimeoutSeconds": 15,
    "ringingTimeoutSeconds": 60
  }
}
```

`audio.physical` retains optional `microphone` and `speaker` objects containing an opaque Core Audio ID and display name. Omitted physical directions use the macOS default.

`audio.virtual` is managed and accepts only the two fixed UIDs above. Numeric `AudioDeviceID` values and friendly names are never persisted as virtual routing authority. Pi resolves the internal UID again whenever it creates or recreates a virtual stream. It does not enumerate the hidden endpoint or fall back to a physical/default device.

| Client | Input | Output |
| --- | --- | --- |
| FaceTime/call application | visible `Pi Talk` | visible `Pi Talk` |
| Pi Talk native helper | hidden internal UID | hidden internal UID |

The Swift bridge normally selects the visible name `Pi Talk` in both FaceTime menu sections. If FaceTime omits its entire Microphone section because Pi Talk is the sole/default input, Swift accepts that input only when Core Audio independently reports the exact fixed visible UID as the current default; this is not a general system-default fallback. There are no separate FaceTime device fields and no persisted `autoAnswer` setting. For outgoing calls, `allowedRecipients` must contain exactly one owner address; Pi resolves it locally and the model supplies only a reason, never a recipient. `recipientAliases` authorize UI identity matching but are not alternate dial targets. Pi coordinates allowlisted answering after voice readiness; Swift enforces allowlists and performs the UI actions.

Keep the file owned by your user and mode `0600`, at most 64 KiB. Timeouts must be 1–3600 seconds. Readers reject unsupported versions, malformed/unsafe policy, oversized files, and non-private or symlinked files rather than silently applying defaults. Audio reset preserves FaceTime allowlists, aliases, and timeouts. A malformed shared config must be repaired or restored from a known backup.

## Commands and diagnostics

- `/talk devices` and `/talk devices physical` select ordinary microphone/output devices directly; there is no profile-choice widget.
- `/talk devices reset` and `/talk devices physical reset` restore physical system defaults.
- `/talk devices diagnostics` resolves both hardcoded managed UIDs and reports current IDs, names, format/channels, and whether hidden capture/playback streams can be created simultaneously.
- Virtual UIDs are fixed schema values: they are never selected, reset, or persisted from a device picker.

Diagnostics do not contact OpenAI or start a WebRTC call. A successful preflight proves current Core Audio resolution and stream creation, not audible end-to-end routing or isolation; use the manual checks in the driver and FaceTime documentation for that.

## When settings apply

- Regular `/talk` reads the physical profile on its next connection.
- `/talk start virtual` opens only `Pi Talk Internal` with audio enabled immediately; it does not inspect or control the call application.
- FaceTime mode reads the managed virtual profile, opens only `Pi Talk Internal`, and asks the idle Swift service to reload/apply visible `Pi Talk` routing.
- Changes never rewire an active call. Stop/re-enable the mode after a config or driver change.
- A device-loss/Core Audio restart ends the affected virtual session. Starting again resolves the UIDs afresh; there is no automatic default-device substitution.
- The extension writes configuration. Swift reads it; socket commands do not edit allowlists or routing.

## Standalone GUI app and custom paths

A LaunchServices app may not inherit the terminal's `PI_CODING_AGENT_DIR`. Its default remains `~/.pi/agent/talk.json`. For a custom agent directory, use **Choose Talk config…** in the bridge app and Stop/Start so the app and Pi report the same path. The app remembers that path in macOS preferences. Optional video-follow enablement and empirical per-peer calibration are separate UI preferences scoped to that path; they do not copy or replace caller authorization or audio policy. See [video follow](facetime/README.md#persistent-automatic-matching-for-allowlisted-video-calls).

The bridge reports its selected config path in status. Pi refuses FaceTime mode when paths differ. No IPC command silently repoints the bridge to another policy file.

## Webcam presentations

No new setting or call/audio permission is added. `present_to_webcam` shows intended public text/local PNG/JPEG in this session's already opted-in, ready webcam/HUD publisher, independently of Talk/FaceTime. Call end/standby alone does not clear it; explicit clear/replace, sharing off, session/branch change, disconnect/stale or app quit does. `present_to_call` remains strict verified-call-only with its original call lifetime; both use one panel/cache. Neither enables sharing, launches apps or starts calls. Success means published, not necessarily seen. Off HUD/opacity do not hide the panel; overlap masking preserves configured settings and updates. Captions stay call-scoped. Assets follow `dirname(actual HUD socket)/presentations`; source paths never enter the wire. Later Pi `/reload` exposes the new tool; updated Electron main/validator bundles need a full restart (and authorized packaging if using an older prebuilt app). See [usage/privacy/schema migration](webcam/docs/call-presentations.md).

Source-only and untested/unbuilt: a later Pi `/reload` and sharing re-enable plus explicit Electron rebuild/package and full restart are needed. Main/preload/validator changes cannot be loaded by renderer HMR. This feature needs no Swift/native rebuild.

## Migration

The extension migrates an existing canonical version-1 `talk.json` to version 2 after strictly validating it. It preserves physical selections and all FaceTime policy, replaces the old arbitrary virtual microphone/output pair with the fixed UIDs, and saves the exact original bytes in owner-only `talk.json.pre-v2.bak` without overwriting an existing backup.

When no canonical file exists, migration can also import the old `<agent-dir>/talk-devices.json` and `~/.config/pi-facetime/config.json`. It preserves physical settings and policy, creates exact `.pre-talk-json.bak` copies, and publishes version 2 directly. It still refuses `autoAnswer: true`, invalid policy, unsafe files, or conflicting migration evidence.

Original and backup files are not runtime fallbacks. If the canonical file disappears after migration, automatic legacy-policy re-import is refused so deleted calling permissions cannot silently return.

After upgrading, rebuild the native helper and Swift app with calls stopped, then reload Pi. Old protocol-6 helpers and version-1 Swift readers are intentionally incompatible with the new fail-closed routing contract.
