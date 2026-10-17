# Shared Talk configuration

Talk and the Swift FaceTime bridge use **one active configuration file**:

```text
~/.pi/agent/talk.json
```

Pi resolves it with `getAgentDir()` (including `PI_CODING_AGENT_DIR`). This is user/machine configuration, not project `.pi/settings.json`; a project cannot supply its own calling allowlist through this feature. AI credentials remain in Pi's normal authentication storage, never here.

## Shape

```json
{
  "version": 1,
  "audio": {
    "physical": {},
    "virtual": {
      "microphone": { "id": "YOUR_COREAUDIO_INPUT_ID", "name": "Agent Input" },
      "speaker": { "id": "YOUR_COREAUDIO_OUTPUT_ID", "name": "Agent Output" }
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

Use `/talk devices` to populate real device IDs/names rather than copying the placeholders. Its first picker selects Physical or Virtual, then microphone and output. Physical may use system defaults (`{}`); FaceTime requires both explicit virtual selections. Device IDs are opaque CoreAudio IDs, not friendly names.

- **Pi/Talk capture:** `audio.virtual.microphone.id`.
- **Pi/Talk playback:** `audio.virtual.speaker.id`.
- **FaceTime microphone:** `audio.virtual.speaker.name`.
- **FaceTime output:** `audio.virtual.microphone.name`.

Swift derives the inverse pair automatically. There are no separate FaceTime `inputDevice`/`outputDevice` settings and no persisted `autoAnswer` setting: Pi coordinates allowlisted answering after voice readiness, while Swift enforces the allowlists and performs the actions. Caller names remain UI identity matches, not cryptographic authentication.

Keep the file **owned by your user and mode `0600`**, at most 64 KiB. Timeouts must be 1–3600 seconds. Readers reject unsupported versions, malformed/unsafe policy, oversized files, and non-private or symlinked files rather than silently applying defaults. Editing/resetting audio must preserve FaceTime allowlists, aliases, and timeouts; `/talk devices reset` never erases call policy. A malformed shared config must be repaired or restored from a known backup, not reset to a permissive state.

## When settings apply

- Regular Talk reads the physical profile on its next connection.
- The Swift service reads the shared file when started and selects the inverse virtual pair when FaceTime is available.
- Enabling `/talk facetime` asks the **idle** Swift service to reload that same file and apply routing, then verifies the selected device marks. It does not maintain or write a second routing configuration.
- Changes do not rewire an active call. Stop/re-enable FaceTime mode to apply changes; restarting the entire Swift app is not required for ordinary shared-config edits. A known active call prevents `config.reload`.
- The extension manages config writes. Swift reads it; socket commands do not edit the file or calling allowlists.

## Standalone GUI app and custom paths

A LaunchServices app may not inherit the terminal's `PI_CODING_AGENT_DIR`. Its default is still `~/.pi/agent/talk.json`; when that environment variable is available, it uses the corresponding agent directory.

For a custom Pi agent directory, use **Choose Talk config…** in the bridge app menu to select the exact file Pi uses. The app remembers **only its location** in macOS preferences—not another copy of the audio/call settings. Apply a different location with Stop/Start (or Retry), not during a call. Explicit CLI `--config PATH` remains available for development.

The bridge reports its selected config path in status. Pi refuses FaceTime mode if that path differs, instead of silently using different allowlists or devices. No IPC command can silently repoint the bridge to a different policy file.

## Migration

The extension's first shared-config load migrates existing settings only when `talk.json` is absent:

- `<agent-dir>/talk-devices.json` (old flat/v1 or physical/virtual v2 profiles).
- `~/.config/pi-facetime/config.json` (old FaceTime policy).

Valid selections, caller/recipient allowlists, aliases, and timeouts are preserved. Owner-only `.pre-talk-json.bak` copies are created without overwriting an existing backup. Original legacy files are left untouched for the still-running old service/rollback; **new versions ignore them once the canonical file exists**. The migration publishes the complete shared file atomically and does not restart the service, place calls, or change live routing.

Migration refuses an old `autoAnswer: true` configuration or conflicting legacy FaceTime/virtual routing instead of silently changing policy. If there were no virtual CoreAudio IDs, it does not invent IDs from device names; choose the virtual pair in Pi. Missing old files create safe defaults (empty allowlists). If `talk.json` disappears after migration but migration backups remain, automatic re-import is refused: restore a known shared config, or explicitly archive the legacy files to start fresh. Deleting the shared file must not resurrect old calling permissions.

After upgrading, rebuild/install the Swift app with calls ended and the old app quit, then reload Pi. Old running binaries keep their loaded legacy settings until restarted; a new extension will reject a bridge that cannot report/reload the shared file.
