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
- Removed macOS-specific custom CPAL, direct Futures, and PulseAudio manifest
  dependencies/custom-host feature. Updated the copied lockfile by building
  once without `--locked`; surviving dependency versions are unchanged.
- `src/pulse/` is retained unchanged **as inactive reference source only**;
  its Apache-2.0 provenance remains in the unchanged upstream `VENDORED.md`.
- Added a minimal Rust **1.99.0** toolchain pin and a documented local build
  workflow that prefers installed static Opus without installing dependencies automatically.

Rust WebRTC, Sonora acoustic echo cancellation/noise/gain processing, Rubato,
IPC **protocol 6**, and all other source behavior remain upstream's.

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
newline to the locally built helper's stdin. It emits `ready` with version 6
and exits. Do not send `start_v3`, `start_v3_bridge`, `start_dictation`, or
`list_devices` when performing this restricted smoke check.
