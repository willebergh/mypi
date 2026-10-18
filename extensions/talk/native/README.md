# Local macOS talk helper

Maintained local source copy of `pi-gpt-voice` **0.3.0**'s
`src/voice/rust` (`pi-codex-voice` crate version remains `0.0.0`):
<https://github.com/giuseppecrj/pi-voice> (package author Giuseppe Rodriguez).
The upstream MIT license, copyright (c) 2026 Igor Warzocha, is retained in
`LICENSE`. This directory is self-contained: building does not read or depend
on the reference `pi-gpt-voice` package. No original prebuilt binary or upstream
`target`/`bin` directory is bundled, installed, or executed.

## Local changes

- macOS CoreAudio only: removed the `pulse` module from `main.rs` and changed
  `audio.rs::hosts()` to only `vec![cpal::default_host()]`.
- Removed upstream's custom-host CPAL, direct Futures, and PulseAudio dependencies.
  CPAL is now pinned to `=0.18.1`, with a visibility-only local source patch to
  expose its existing hidden-device constructor (see `VENDORED.md`). Direct
  `objc2-core-audio` / `objc2-core-foundation` dependencies are pinned to the
  already-locked `=0.3.2`; no unrelated dependency versions changed.
- `src/pulse/` is retained unchanged **as inactive reference source only**;
  its Apache-2.0 provenance remains in the unchanged upstream `VENDORED.md`.
- Added a minimal Rust **1.99.0** toolchain pin and a documented local build
  workflow that prefers installed static Opus without installing dependencies automatically.

- Added IPC **protocol 7**, UID-only hidden Core Audio streams and diagnostics.
- Physical calls retain Sonora AEC + noise suppression + adaptive gain. Virtual
  calls disable AEC (including render-reference processing), retaining noise
  suppression + gain. Mute, capture-gap, and backlog resets preserve this policy.

Rust WebRTC, Rubato conversion, callback stereo downmix/duplication, and the
physical/bridge routes otherwise retain upstream behavior.

## Hidden virtual audio (protocol 7)

Commands (newline-delimited JSON):

```json
{"type":"start_v3_virtual","visible_uid":"io.github.willebergh.pitalk.audio.visible","internal_uid":"io.github.willebergh.pitalk.audio.internal"}
{"type":"diagnose_virtual_audio","visible_uid":"io.github.willebergh.pitalk.audio.visible","internal_uid":"io.github.willebergh.pitalk.audio.internal"}
```

Startup resolves **both** UIDs with
`kAudioHardwarePropertyTranslateUIDToDevice` on `kAudioObjectSystemObject`,
passing a retained CFString reference as the qualifier. Non-`noErr` status,
`kAudioObjectUnknown`, malformed results, or aliased endpoints fail closed.
Neither startup nor diagnostics enumerate devices, match display names, or fall
back to system defaults. The existing physical `list_devices` command is separate.

Capture and playback each resolve the **internal UID again** just before opening.
Playback stores only the UID and resolves it again on every suppression/resume
rebuild. AudioDeviceIDs in diagnostic output are informational, not reusable IDs.
The hidden streams require **48 kHz, stereo, float32**; capture callbacks downmix
stereo to mono and playback duplicates mono to stereo. Unsupported formats fail
rather than negotiating another rate or channel count.

`diagnose_virtual_audio` requires an idle helper. It returns
`virtual_audio_diagnostics` with `visible` and `internal` objects containing
`uid`, `resolved`, and optional `audio_device_id`, `name`, `nominal_sample_rate`,
`input_channels`, `output_channels`; plus `simultaneous_streams` and `issues`.
It actually opens and starts hidden capture **and** playback concurrently, holds
both for 100 ms, checks stream failures, then releases both before replying.
Playback is silent and capture is discarded (microphone permission may be
required). `simultaneous_streams` proves concurrent stream creation/start, **not**
end-to-end routing or audible loopback. Missing metadata is reported in `issues`.
No WebRTC session is created by the diagnostic.

Error events retain `message` and optionally include a closed, safe `code`:

| Code | Action |
| --- | --- |
| `driver_not_installed` | Both UIDs are absent; install the Pi Talk driver. |
| `visible_endpoint_unavailable` | Check the visible endpoint and driver installation. |
| `hidden_uid_unresolved` | UID translation failed; restart Core Audio/check the driver. |
| `hidden_device_unknown` | Hidden UID translated to `kAudioObjectUnknown`; reinstall/check the driver. |
| `input_stream_creation_failed` | Check microphone permission, driver, and competing clients. |
| `output_stream_creation_failed` | Check driver and competing audio clients. |
| `unsupported_format` | Install a driver supporting 48 kHz stereo float audio. |
| `device_lost` | Check/restart the device or Core Audio, then restart the call. |

The helper neither installs nor modifies the separately licensed GPL driver.

## Licenses and notices

This is mixed-license source, not exclusively MIT. In particular,
`src/codex_audio/buffers.rs` and `processing.rs` are Apache-2.0 adaptations from
OpenAI Codex; retained inactive `src/pulse/` files adapt Apache-2.0 CPAL code.
See `VENDORED.md`, file headers, and `vendor/openai-codex/{LICENSE,NOTICE}`.
`vendor/rust-dependencies/` retains additional dependency notices/licenses.

The full upstream `THIRD-PARTY-NOTICES.txt` is preserved after a local disclaimer.
Its original binary manifest describes **upstream binaries only**, not the local
artifact or its exact dependency inventory. Local builds use installed Opus,
not necessarily upstream's bundled version. Review notices for the actual Opus
installation and toolchain before redistributing a local binary; upstream's
`licenses/rust-std-COPYRIGHT-library.html` reference is an upstream path, not a
file bundled here.

## Build

Requires macOS (arm64 or x64), rustup with Rust 1.99.0 **already
installed**, Xcode command-line tools/macOS SDK, `pkg-config`, and installed
Opus with a static library. For complete new-machine setup, see
[`/skill:setup`](../../../.pi/skills/setup/SKILL.md) and its
[native Talk reference](../../../.pi/skills/setup/references/native-talk.md).
Optional Homebrew setup (run manually):

```sh
brew install opus pkg-config
```

For the complete guarded build/publication procedure, follow the skill reference above. The underlying Cargo command, from the repository root, is:

```sh
cd extensions/talk/native
OPUS_STATIC=1 cargo build --release --locked
```

The checked-in rust-toolchain pin selects Rust without changing your global
default. Install prerequisites separately; no setup is performed by this
build. Installed Opus is found through pkg-config; no CMake source-build
fallback is intended. Cargo may download locked registry crates. The compiled
binary is at `target/release/pi-codex-voice`; copy it to
`bin/darwin-<Node process.arch>/pi-codex-voice` for the extension to use (`arm64` or `x64`, not `x86_64`).

Output (built locally, mode 755):
`bin/darwin-${process.arch}/pi-codex-voice`, copied from
`target/release/pi-codex-voice`. These generated directories are not source.

## Safe verification

The retained unit tests use synthetic samples, clocks, queues, and in-memory
I/O; they do not open audio devices or create network sessions:

```sh
cd extensions/talk/native
OPUS_STATIC=1 cargo test --locked --no-run --bin pi-codex-voice
OPUS_STATIC=1 cargo test --locked --bin pi-codex-voice
```

For a device-free smoke check, feed **only** `{"type":"shutdown"}` plus a
newline to the locally built helper's stdin. It emits `ready` with version 7
and exits. Do not send `start_v3`, `start_v3_virtual`, `start_v3_bridge`,
`start_dictation`, `diagnose_virtual_audio`, or `list_devices` when performing
this restricted smoke check.

The synthetic tests cover failed/unknown UID translations, both-endpoint
preflight, fresh IDs for each open, exact virtual formats, concurrent stream
resource lifetime/partial-failure cleanup, safe IPC codes, and processing-policy
resets. They do not require the driver. Live validation still requires installing
the driver, running the diagnostic, checking actual routing, and exercising
suppression/resume and device loss during a call.

Implementation validation on macOS arm64: `cargo check --locked --tests`, all
**53 unit tests**, a debug `cargo build --locked`, and the shutdown/version-7
smoke check passed with Rust 1.99.0 extracted to a temporary directory. Installed
static Opus was linked using `OPUS_NO_PKG=1 OPUS_LIB_DIR=/opt/homebrew
OPUS_STATIC=1` because pkg-config was unavailable. A separate negative IPC check
using random nonexistent UIDs returned unresolved diagnostics and
`driver_not_installed`, without opening streams or creating an offer. The
installed-driver success path, audible routing, and live device-loss behavior
have **not** been exercised. The only compiler warning was the pre-existing
`AtomicUsize::fetch_update` deprecation in a queue test.
