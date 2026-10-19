# Milestone 3A — Pi Talk Webcam camera extension

## Checkpoint: NOT installed or active

Source, bundle assembly and activation integration are implemented. This Mac runs **macOS 26.6.1 / Xcode 27.1**. An actual automatic-signing test detected **William Bergh (Personal Team), 4TM429UCWA**. The **camera extension signed successfully**, including its team-prefixed App Group. The **Electron host failed provisioning**: Xcode explicitly reports that Personal development teams do not support the **System Extension** capability. No profiles were generated. **Host signing, installation, OS approval and FaceTime remain blocked/unverified.** Xcode used the existing local Apple Development identity for the camera-only test; no keys were exported, no activation/deactivation request was submitted, and no security-setting commands were issued. See **[PERSONAL_TEAM_RESULTS.md](PERSONAL_TEAM_RESULTS.md)** for the exact errors, signed entitlements and reproduction commands.

Do not run the extension executable directly. Do not copy an unsigned build into `/Applications` and expect activation. Do not disable SIP, Gatekeeper, or system-extension validation, and do not enable system-extension developer mode as a workaround.

## Implementation

- `extension/`: Swift CoreMediaIO provider/device/source stream. Real camera name **Pi Talk Webcam**; stable device/stream UUIDs; one packed **1280×720 BGRA** format, fixed **30 FPS**.
- Animated scrolling color bars, moving orange square and white scanline. This is deliberately a CPU-generated test pattern, not a Three.js bridge.
- IOSurface-backed `CVPixelBufferPool` capped at five buffers; full pools drop frames rather than allocate/queue indefinitely. Correct `CMSampleBuffer` duration (`1/30`), host-clock PTS and matching nanosecond send timestamp. Demand-counted timer starts/stops when camera clients open/close the stream; serial state and generation tokens guard restart races.
- `manager/`: raw Node-API Objective-C++ bridge to `SystemExtensions.framework`, loaded **inside the Electron main process**. No second app or independent installer helper. It retains request delegates and handles approval, replacements, reboot-required results, errors and OS property queries.
- React shows bundled/signing/installation/activation/request diagnostics and explicit Install/Activate, Deactivate/Remove and Refresh actions. No automatic activation. Unsigned and `pnpm dev` hosts are gated. An accepted request is not presented as proof that the extension is enabled; enabled state comes from `OSSystemExtensionProperties`.
- The app does not control client streaming directly. Selecting it in FaceTime starts the source; closing/deselecting stops it. Existing renderer controls do not control this camera. Quitting Electron does not uninstall a system-managed camera extension.

The packaged structure is:

```text
pi-talk-webcam.app/Contents/
  Resources/{bridge.node,camera_manager.node,app.asar,...}
  embedded.provisionprofile                    # signed build only
  Library/SystemExtensions/
    com.pitalk.webcam.camera.systemextension/Contents/
      Info.plist
      MacOS/com.pitalk.webcam.camera
      embedded.provisionprofile                # optional, extension-specific
```

The extension is a **SYSX `.systemextension`**, not an `.appex`. Its Info.plist includes `NSSystemExtensionUsageDescription` and `CMIOExtension/CMIOExtensionMachServiceName`. The basename matches the bundle ID. The Mach service uses the common App Group prefix.

## Build / non-installing tests

```sh
pnpm camera:build       # compile unsigned extension + activation addon
pnpm camera:test        # standalone buffer/timer tests, NOT a camera service
pnpm native:test        # existing Metal addon tests
pnpm typecheck
pnpm verify            # existing renderer/Metal checks + read-only camera UI diagnostics
pnpm package           # includes extension + native addons, still NOT identity-signed
```

Forge builds and bundles camera components automatically on macOS. The provider executable is compiled without an ad-hoc signature; test harnesses get the arm64 linker's ordinary ad-hoc load signature. Neither uses an Apple signing identity. The real provider is not launched by the tests. See `extension/README.md` for the buffer tests and source details.

The signed workflow below is implemented but cannot be validated until a proper profile/signing configuration is supplied. `camera:sign:check` validates available profile/bundle/identity prerequisites without signing. It checks team/App ID, expiration, local certificate inclusion, the install entitlement, and device-limited profile eligibility. macOS remains the final signing/provisioning policy authority.

## Actually tested at this checkpoint

- Swift provider and Objective-C++ activation addon compiled successfully. Plists linted; packaged bundle executable name and SYSX layout checked.
- `pnpm camera:test` passed pixel/animation, sample format/duration, host timestamps, five-buffer exhaustion/recovery, reference-counted/concurrent start/stop, restart and shutdown tests. These tests do not register a camera.
- `pnpm native:test`, TypeScript checks, full development verification and unsigned packaged verification passed. Existing Three.js/Metal and bitmap paths remained approximately 30 FPS, including hidden/closed editor and restart/resource-drain checks.
- Read-only UI IPC confirmed extension absent in Electron development host and present in the packaged host, with activation correctly disabled in both unsigned contexts. Screenshot and JSON evidence: `../../../docs/evidence/milestone3a-development/` and `../../../docs/evidence/milestone3a-packaged/`.
- `camera:sign:check` correctly rejected missing signing configuration without touching a signing key. The manual `sign.mjs` positive profile/signing path and notarization are still untested. Separately, the actual Xcode camera-only automatic signing test succeeded; its host provisioning attempt failed as recorded above.
- `systemextensionsctl list` reports **0 extensions**. No CMIO provider service was launched, installed or activated. FaceTime is still untested.

## What you must configure next

### 1. Signing team and provisioning (manual checkpoint)

Use a **paid Apple Developer Program** team with System Extension capability. Confirm whether **4TM429UCWA** is the team you intend to use. Do not send private keys, passwords, App Store Connect API keys, or Keychain credentials to this project or assistant.

For a normal distribution-style activation without relaxed security controls, obtain a **Developer ID Application** identity in your local Keychain. The existing **Apple Development** identity is not a substitute for Developer ID notarized distribution.

In Apple's Certificates, Identifiers & Profiles portal:

1. Create an explicit **macOS App ID `com.pitalk.webcam`**, enabling **System Extension**.
2. Create/download a matching **Developer ID provisioning profile** authorizing `com.apple.developer.system-extension.install` and the selected Developer ID certificate. Keep it at a local path outside the repository.
3. Keep the extension identity **`com.pitalk.webcam.camera`** under the same team. It uses Sandbox + App Groups, not a guessed `com.apple.developer.cmio.*` entitlement. A separate extension provisioning profile is not inherently required for these unrestricted macOS entitlements. If your actual signing setup supplies/requires one, it must match this extension ID, team and certificate; set `CAMERA_EXTENSION_PROFILE`.
4. Both signatures use the same shared group, default **`4TM429UCWA.com.pitalk.webcam`** when using that team. Apple's macOS team-prefixed App Group form does **not** need portal registration. A custom group can be set with `CAMERA_APP_GROUP`; the build then prefixes the Mach service with it.

You can manage certificates through Xcode → Settings → Accounts → your team → Manage Certificates, and profiles through Apple's portal. No Xcode project or second host app is necessary; Swift compilation and bundle assembly are handled here.

**Local-development alternative:** a Mac App Development host profile, Apple Development identity and registered Mac can be used for signing/debugging. Enable System Extension on the same host App ID, include this Mac and the chosen certificate in that profile, and use `CAMERA_SIGNING_TYPE=development`. Whether the resulting non-notarized manual build is accepted by the normal activation policy still requires a real OS test. If macOS rejects it for notarization/policy, stop and use Developer ID + notarization—do not weaken system security. The implementation does not assume development signing alone guarantees activation.

### 2. Build and sign yourself (may request Keychain approval)

Only after the above is configured, run in the project root, replacing the local certificate name/path with yours:

```sh
export CAMERA_TEAM_ID='4TM429UCWA'
export CAMERA_SIGN_IDENTITY='Developer ID Application: YOUR CERTIFICATE NAME (4TM429UCWA)'
export CAMERA_SIGNING_TYPE='distribution'
export CAMERA_HOST_PROFILE='/absolute/path/to/PiTalkWebcam.provisionprofile'
export CAMERA_BUILD_VERSION='1'
# Optional: export CAMERA_EXTENSION_PROFILE='/absolute/path/to/Camera.provisionprofile'

pnpm package
pnpm camera:sign:check
pnpm camera:sign
```

If you instead use the existing Apple Development certificate with a development host profile, set its exact local name or SHA-1 and `CAMERA_SIGNING_TYPE=development`. The public SHA-1 can be listed with `security find-identity -v -p codesigning`; it is not a private key.

**Stop and answer any Keychain access prompt yourself.** The script embeds profiles, signs the camera extension first, then Electron frameworks/helpers/addons and the outer app last. Host System Extension/App Group entitlements are not applied recursively to helpers. It uses `codesign --deep` only for **verification**, never for signing. Host App Sandbox is deliberately not enabled; existing Electron renderers retain their separate Chromium sandboxing.

For later extension updates, increase `CAMERA_BUILD_VERSION` before packaging. Do not alter the bundle after signing; rerun package/sign if content changes. `pnpm package` always produces a new unsigned assembly, not a signed incremental update.

### 3. Notarize distribution builds

Configure a `notarytool` credential profile in **your own Keychain** using Apple's documented interactive workflow. Do not put credentials in environment files, source code, chat or this repository. Only its non-secret profile name is used here:

```sh
export CAMERA_NOTARY_PROFILE='YOUR_LOCAL_KEYCHAIN_PROFILE_NAME'
pnpm camera:notarize
```

This checks for Developer ID signing, submits a ZIP using the existing Keychain credential profile, waits, staples, validates and assesses the app. Apple may reject the submission; read its result and stop rather than bypassing Gatekeeper. This workflow has not yet been exercised on this machine because only Apple Development signing is available.

### 4. Install and approve (manual checkpoint)

1. Quit any old Pi Talk Webcam development or packaged instance.
2. In Finder, copy `out/pi-talk-webcam-darwin-arm64/pi-talk-webcam.app` into **`/Applications`**, replacing an old copy if appropriate. Administrator authorization may be needed. Launch **that copy**.
3. In its camera section, verify the bundle is present and signing instructions have cleared, then click **Install / Activate**. Keep the app open while approval is pending.
4. On **macOS 26**: open **System Settings → General → Login Items & Extensions → Camera Extensions → information button**, and enable Pi Talk Webcam. Follow any administrator approval prompt. This is the extension approval, not the Privacy & Security → Camera switch for consuming apps.
5. Return to the app and **Refresh**. Expected OS-reported activation: **enabled**. If a request says reboot-required, save your work and restart when ready. If it fails, stop and report the displayed error/domain/code; do not change unrelated security settings.

No Accessibility, Screen Recording, Input Monitoring or microphone permission is required. The generator does not enumerate or open a physical camera. FaceTime's own ordinary camera authorization is separate; if macOS asks for it when you open FaceTime, approve it there. Do not grant camera permissions to the Electron app just to install the extension.

### 5. FaceTime test — requires your confirmation

1. Fully quit/reopen FaceTime after successful activation so it refreshes device discovery.
2. In FaceTime's **Video** menu, choose **Pi Talk Webcam** in the camera choices (some versions group them under **Camera**).
3. Expect 1280×720 color bars with a moving orange square and white scanline. Check continuous movement for at least 30 seconds. The source targets 30 FPS; actual FaceTime presentation cadence is not yet measured.
4. Select a different camera or quit FaceTime, then select Pi Talk Webcam again to test client start/stop. It must animate again, not show a frozen frame.
5. Tell me whether the device was listed, whether animation appeared, and any activation error. **FaceTime compatibility is not verified until this succeeds. Do not proceed to Milestone 3B yet.**

For diagnostics, use the app's OS request errors, `systemextensionsctl list` (read-only), or Console filtered by subsystem `PiTalkWebcam.CameraExtension`. CLI logs: `log stream --style compact --predicate 'subsystem == "PiTalkWebcam.CameraExtension"'`. Do not interpret CLI bundle presence or standalone tests as camera installation.

## Remove / uninstall

Quit FaceTime or deselect this camera. Open the **same signed host in `/Applications`**, click **Deactivate / Remove**, finish any administrator prompt, and Refresh. Honor any reboot-required result. Confirm the camera disappears after reopening FaceTime, then move the host app to Trash if desired. Do not use privileged `systemextensionsctl uninstall`, developer mode, or manual deletion from system directories as a normal uninstall path.

## Official requirements reviewed

- [Apple Camera Extension guide](https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o)
- [System Extensions bundle/signing requirements](https://developer.apple.com/documentation/systemextensions)
- [System Extension install entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.system-extension.install)
- [Provisioning-profile authorization / TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)
- [App Groups, macOS team-prefixed form and Mach service namespace](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.application-groups)
- [macOS 26 Camera Extensions settings](https://support.apple.com/guide/mac-help/change-login-items-extensions-settings-mtusr003/26/mac/26)
- [Electron host provisioning discussion (Apple DTS)](https://developer.apple.com/forums/thread/811067)

Installed Xcode 27.1 Camera Extension templates and CoreMediaIO/SystemExtensions SDK headers were also reviewed. System extension installation, notarization and FaceTime discovery still require the actual signed-user-approved test.
