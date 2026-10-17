# Local FaceTime bridge app

The Swift service can run as **Pi FaceTime Bridge.app**, hosted independently of Terminal/CMUX. Talk still connects through the same private Unix socket; no Pi code, AI credentials, or audio transport moves into the app.

## Build and install

From the repository root on your Mac:

```sh
npm run talk:facetime:build    # Swift CLI + locally ad-hoc-signed app bundle
npm run talk:facetime:install  # Build and install in ~/Applications
```

`npm run talk:build` also includes the Swift app build, after the Rust WebRTC helper.

Requirements: Swift 6/Xcode command-line tools and the macOS SDK. No paid Apple Developer account, shared certificate, notarization, or administrative install is needed for this personal local build. The script installs no tools, opens no app, and requests/changes no privacy permissions.

Locations:

- Staged bundle: `extensions/talk/facetime/.build/Pi FaceTime Bridge.app`
- Installed bundle: `~/Applications/Pi FaceTime Bridge.app`
- Stable bundle ID: `dev.mypi.facetime-bridge`

Stop active calls and quit the old bridge app/CLI before rebuilding. The builder checks mapped executables with `lsof` and refuses replacement rather than stopping processes. It signs and verifies a temporary bundle before replacing an existing known bundle, preserving the old app on signing failure.

For development verification while an old CLI binary must remain untouched, a separate Swift cache can be used explicitly:

```sh
node scripts/build-talk-facetime.mjs --install --scratch-path extensions/talk/facetime/.build/app-check
```

This does not restart the service or launch the installed app. Do not run two service instances.

## Grant Accessibility to the app, not CMUX

1. Stop the old terminal-hosted service, if running.
2. Open the **installed app through LaunchServices**, not its executable:

   ```sh
   open "$HOME/Applications/Pi FaceTime Bridge.app"
   ```

3. Use its menu-bar controls to request Accessibility access/open the Accessibility settings pane.
4. In **System Settings → Privacy & Security → Accessibility**, check that the entry is **Pi FaceTime Bridge**, then grant it access manually. Follow macOS's quit/reopen instruction if shown, and use Start/Retry after permission is available.
5. Verify that the app reports a running service. Then enable `/talk facetime` in Pi as before.

The app does not prompt for Accessibility merely because it was built/installed, and it does not need microphone or screen-recording access. Talk's separate native audio helper still needs its normal microphone permission. App launch is manual for now; automatic startup from `/talk facetime` remains deferred.

**Actual permission attribution requires a live check on your Mac.** A proper signed bundle launched through LaunchServices is the intended identity boundary, but code signing verification alone does not prove which process TCC authorizes. Do not grant CMUX broad Accessibility just to bypass a failed app test. Launching `Contents/MacOS/facetime-observer` directly from a terminal can still attribute access to that terminal, even though the executable lives in an app bundle.

Accessibility itself is broad: macOS does not scope the grant to FaceTime alone. The service's existing allowlists/commands constrain normal operation, and its socket is private to the user, but this is not a security boundary against other processes running as that same user. Diagnostic `inspect`/snapshot commands still expose accessible UI data; Pi's normal FaceTime tools do not expose those diagnostics.

## Configuration and lifecycle

The app and Pi share owner-only **`~/.pi/agent/talk.json`**; the socket remains `~/.local/share/pi-facetime/control.sock`. See the [configuration reference](../CONFIG.md) for schema and safe migration from the two old files. Swift derives FaceTime's microphone/output from the inverse `audio.virtual` pair and automatically selects them; there are no separate device or auto-answer settings. Pi still prepares/gates audio before requesting Answer, while Swift enforces allowlists.

Use **Choose Talk config…** for a custom Pi agent directory, then Stop/Start (or Retry). The GUI may not inherit terminal environment variables. macOS preferences remember only the selected file location, never another policy/audio copy. Pi requires the bridge's reported config path to match its own. Ordinary edits to that file apply when the idle service reloads on `/talk facetime` enable; no app restart is needed. An active call is never rewired by config reload.

Without Accessibility permission the app remains visible with actionable menu status; it does not repeatedly request access. With permission already granted, launching the app may start the service. Stop/Quit closes observers and the socket, but **does not hang up a FaceTime call or abort Pi work**. Use Pi's hangup/stop command or FaceTime's controls to end a call first.

## Rebuilds and signing

Default signing is local **ad-hoc signing** (`codesign --sign -`). Changed builds can require another manual Accessibility grant. Keep the installed path and bundle ID stable, but do not assume those alone preserve consent.

If desired later, use a stable signing identity already in your local keychain:

```sh
npm run talk:facetime:install -- --identity "Your local code-signing identity"
```

No certificate or private key is distributed with the repository. The builder does not reset TCC, edit macOS privacy databases, remove Terminal/CMUX permissions, install a LaunchAgent, or bypass Gatekeeper. If macOS blocks a locally built app, review its normal Open Anyway flow manually rather than disabling platform protections.

## Verification

```sh
node --test test/talk-facetime-app-build.test.ts
swift test --package-path extensions/talk/facetime
```

These tests use synthetic executables/socket state and do not launch the menu-bar app, prompt for Accessibility, or place calls. App launch, permission attribution, routing, and a real call are separate manual checks.
