# Pi Talk Webcam camera extension

Synthetic CPU-only milestone. Everything here is self-contained; the parent build owns bundle assembly. No Three.js integration, physical capture-device access, install/activation logic, or signing scripts.

## Sources

- `Provider.swift`: real `CMIOExtensionProviderSource`, device and source-stream implementations. Device localized name: **Pi Talk Webcam**. Fixed device UUID `71CBB0D9-7FE0-4C8F-91CA-4A9B43D64FD3`; stream UUID `46833C22-78B0-4C18-B44C-9BA17F250C2D`.
- `main.swift`: `@main` service entry point, compatible with `-parse-as-library`. **Do not run this executable as a test.** It calls `CMIOExtensionProvider.startService`.
- `TestPattern.swift`: packed BGRA (`kCVPixelFormatType_32BGRA`), 1280×720, scrolling eight-color bars, moving orange box and white scanline. IOSurface-backed pixel-buffer pool, stride-aware CPU writes, opaque alpha, initialized padding. Also creates ready `CMSampleBuffer`s with duration exactly `1/30`, invalid DTS, and host-clock PTS.
- `FramePump.swift`: one private serial queue owns all timer/demand/pool mutation. Start increments demand; only 0→1 creates a timer. Stop decrements; only 1→0 cancels it. Unmatched stops cannot underflow. Synchronous stop drains in-flight delivery; generation checks reject stale events after restart. Weak timer captures avoid a retain cycle.
- `test/FrameTests.swift`: separate `--self-test` entry point. Does not import CoreMediaIO, construct a provider, or register a service.

The same capture instant supplies PTS and `hostTimeInNanoseconds`, using integer `CMTimeConvertScale` to nanoseconds (not floating-point seconds or raw mach ticks). Successfully generated timestamps must increase. The timer runs at nominal 30 fps on the host clock, not a fictional frame-index clock; scheduling delays are not replayed as queued frames. Stream duration is fixed to `1/30`; unsupported format/duration setters throw. Restart and allocation-drop boundaries use `.time` and `.sampleDropped`, respectively.

Every allocation uses `CVPixelBufferPoolCreatePixelBufferWithAuxAttributes` with threshold **5**. Exhaustion drops the current frame immediately; no fallback allocations or pending-frame queue. Stop cancels the timer and flushes unused IOSurfaces. The pool object deliberately survives stops so consumer-retained buffers still count toward the cap on restart (about 18 MiB pixel storage, plus overhead). Source destruction releases the pool; buffers already held by consumers live until those consumers release them. Errors/drops (rate limited), start/stop and lifecycle events use `os.Logger`, subsystem `PiTalkWebcam.CameraExtension`.

CMIO stream callbacks balance demand. Provider disconnect is not counted as an extra stream stop, which could otherwise interrupt another client. Authorization accepts consumers of synthetic output; it never requests physical-camera authorization.

## Apple API / metadata reference

Read the installed template's two Swift files, entitlements and `TemplateInfo.plist` at:

```
/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Xcode/Templates/Project Templates/macOS/System Extension/Camera Extension.xctemplate
```

Also checked inherited `System Extension Base.xctemplate` / `OSX App Extension Base.xctemplate`, current CoreMediaIO SDK headers, and Xcode's `DarwinProductTypes.xcspec` / `DarwinPackageTypes.xcspec`. The template inherits product type `com.apple.product-type.system-extension`; its package specification sets `PRODUCT_BUNDLE_PACKAGE_TYPE = SYSX`. This is a `.systemextension`, not an `NSExtension`/`XPC!` plug-in.

`Info.plist` is a parent-substituted template:

| Token | Meaning |
| --- | --- |
| `__BUNDLE_ID__` | Bundle identifier **and executable filename** in `Contents/MacOS/` (matches the Xcode system-extension product-name default) |
| `__TEAM_ID__` | Informational `PiTalkTeamIdentifier` build metadata; does not grant identity or replace signing |
| `__VERSION__` | `CFBundleShortVersionString` |
| `__BUILD_VERSION__` | `CFBundleVersion` |
| `__MACH_SERVICE__` | Full team-prefixed `CMIOExtensionMachServiceName`; Xcode default is `$(TeamIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)` |

The parent must replace every token and place the compiled executable under the substituted executable filename. The declared minimum OS is macOS 12.3 (camera-extension API availability). No bundle is assembled here.

`extension.entitlements` contains `com.apple.security.app-sandbox = true` and the parent-substituted `__APP_GROUP__`, matching Apple's documented shared-group configuration. No custom app-to-camera frame IPC is implemented yet; CMIO's Mach service still uses the group-prefixed namespace. There is no invented camera-output entitlement, physical camera entitlement, or `NSCameraUsageDescription`.

## Exact validation commands

Run from the repository root. All compiler products and the module cache go under `/tmp`, not the source tree.

Compile the provider **without running it**, explicitly suppressing the linker's automatic ad-hoc signature:

```sh
xcrun swiftc -swift-version 6 -warnings-as-errors -parse-as-library -emit-executable -Xlinker -no_adhoc_codesign -module-cache-path /tmp/pi-talk-camera-extension-module-cache native/macos/camera/extension/TestPattern.swift native/macos/camera/extension/FramePump.swift native/macos/camera/extension/Provider.swift native/macos/camera/extension/main.swift -o /tmp/pi-talk-camera-extension-unsigned
```

Compile and run only the standalone synthetic-buffer harness:

```sh
xcrun swiftc -swift-version 6 -warnings-as-errors -parse-as-library -emit-executable -module-cache-path /tmp/pi-talk-camera-extension-module-cache native/macos/camera/extension/TestPattern.swift native/macos/camera/extension/FramePump.swift native/macos/camera/extension/test/FrameTests.swift -o /tmp/pi-talk-camera-extension-self-test
/tmp/pi-talk-camera-extension-self-test --self-test
```

The runnable arm64 harness has the Apple linker's default ad-hoc Mach-O load signature (no identity, provisioning, or `codesign` invocation). The provider output explicitly disables that and has no `LC_CODE_SIGNATURE`. Never run the provider output for these tests.

Metadata checks:

```sh
plutil -lint native/macos/camera/extension/Info.plist native/macos/camera/extension/extension.entitlements
```

Validated with Apple Swift 6.4, arm64, Swift 6 language mode and warnings as errors. Both compiles pass; both plists pass lint. The harness checks BGRA bytes, bar animation, moving box/line, opacity/padding, IOSurface backing, sample readiness/format, exact sample duration, host PTS/nanosecond agreement and monotonicity, invalid inputs, five retained frames/exhaustion, cap across stop-style flush, recovery/reuse, multiple/concurrent demands, restart, synchronous final stop and shutdown.

Host timestamps are tick-quantized; the interval test allows one nanosecond of rounding while sample duration remains rationally exact. These are **standalone synthetic-frame tests**, not proof of OS device discovery or camera-client compatibility. No provider was executed, installed, activated or developer-signed; no CMIO daemon was launched. Bundle packaging and actual client/OS integration remain untested.
