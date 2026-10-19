# Actual Personal Team automatic-signing test

## Detected

- Xcode 27.1.
- Xcode preferences identify **4TM429UCWA**, **William Bergh (Personal Team)**, `isFreeProvisioningTeam = true`.
- One valid local **Apple Development** signing identity; certificate OU/team matches 4TM429UCWA.
- No local provisioning profiles before the test.

No account tokens, passwords or private keys were read/exported by the scripts. Xcode used its existing configured account and local signing identity.

## Configured / attempted

`auto-sign.mjs` generates an Xcode project under ignored `build/automatic-signing/`:

- `ElectronHost`: stages the existing packaged Electron app, bundle ID `com.pitalk.webcam`, Automatic signing, team 4TM429UCWA, Apple Development, System Extension installation entitlement and shared App Group.
- `CameraExtension`: compiles the existing Swift sources as a real system-extension product, bundle ID `com.pitalk.webcam.camera`, Automatic signing, same team, Sandbox and shared App Group.
- Group: `4TM429UCWA.com.pitalk.webcam` (macOS team-prefixed form).

Ran `xcodebuild ... -target ElectronHost -configuration Debug -allowProvisioningUpdates -allowProvisioningDeviceRegistration ... build` against the configured Personal Team. This target depends on the camera extension.

**Exit 65 / BUILD FAILED**, during provisioning, with these exact Xcode errors:

```text
Cannot create a Mac App Development provisioning profile for "com.pitalk.webcam". Personal development teams, including "William Bergh", do not support the System Extension capability. (in target 'ElectronHost' from project 'PiTalkSigning')

No profiles for 'com.pitalk.webcam' were found: Xcode couldn't find any Mac App Development provisioning profiles matching 'com.pitalk.webcam'. (in target 'ElectronHost' from project 'PiTalkSigning')
```

This is a capability/account rejection, not a Swift compilation error or an assumption based on membership type.

## Isolated extension / App Group test

Separately ran the **CameraExtension target alone** with the same account, automatic-signing flags and `ARCHS=arm64`.

**BUILD SUCCEEDED.** `codesign --verify --strict --verbose=2` reported:

```text
valid on disk
satisfies its Designated Requirement
```

Its signature has `TeamIdentifier=4TM429UCWA` and an Apple Development certificate chain. The signed entitlements are:

```xml
<dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.application-groups</key>
  <array><string>4TM429UCWA.com.pitalk.webcam</string></array>
  <key>com.apple.security.get-task-allow</key><true/>
</dict>
```

**Do not report App Groups as unavailable:** this macOS team-prefixed App Group signed successfully. There is no `com.apple.developer.system-extension.install` entitlement in the extension, nor should there be just to implement the camera. That restricted entitlement is needed by the **host process requesting installation**.

## Provisioning-profile inspection

After both attempts, searched:

- `~/Library/Developer/Xcode/UserData/Provisioning Profiles/`
- `~/Library/MobileDevice/Provisioning Profiles/`
- Generated automatic-signing products, including embedded profiles.

**0 provisioning profiles found.** Therefore no generated profile authorizes `com.apple.developer.system-extension.install`. Successful unrestricted camera-extension signing did not provision the restricted host capability.

## State / blocker

- Signed camera-only build exists under `build/automatic-signing/products/Debug/`.
- The complete Electron host is **not successfully automatically provisioned/signed** and is not ready for installation.
- **No camera installed or activated.** `systemextensionsctl list` still reports `0 extension(s)`.
- No FaceTime claim. No installation, activation, security-setting commands, purchases or backend changes were performed. Normal Xcode build/signing steps ran, including its standard execution-policy registration step for the development product; no custom security exceptions were requested.

Continuing under normal security controls requires a team/profile that Apple authorizes for the System Extension installation capability. The tested Personal Team cannot supply that profile. There is no local Xcode setting shown by this result that fixes this capability restriction. Stop here; do not attempt activation with the signed camera-only bundle or strip the required host entitlement to simulate success.

## Reproduce

```sh
pnpm camera:autoprovision -- --configure-only  # generate project and inspect team; no build
pnpm camera:autoprovision                   # actual host + camera provisioning attempt
pnpm camera:autoprovision --extension-only  # isolated camera / App Group signing
```

For pnpm versions requiring an argument separator, call `node native/macos/camera/auto-sign.mjs --extension-only` directly. Generated projects, entitlements, products and logs stay under ignored `native/macos/camera/build/automatic-signing/`. The host staging product is diagnostic until full nested Electron signing/profile validation has succeeded; it is never installed automatically.

In the original project, raw logs and signature evidence from this historical test were saved under `artifacts/personal-team-signing/`. Those raw signing outputs were **not imported** into this checkout or `docs/evidence/`; only this written result was retained. They may include local paths and public identity metadata; no exported keys or supplied credentials were reported. Reproduction still writes generated signing outputs to the ignored runtime locations above, not to `docs/evidence/`.
