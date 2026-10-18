# Vendored native audio code

`src/codex_audio/buffers.rs` and `src/codex_audio/processing.rs` are adapted
from `codex-rs/voice-host/src/device_buffers.rs` and
`codex-rs/voice-host/src/processing.rs` in
<https://github.com/openai/codex> at commit
`7498521d288b9b3b96ffba4eedf089d8d6e06a84`.

The adaptations retain Codex's callback frame boundaries, capture-generation
isolation, Rubato streaming conversion, and Sonora echo, noise, and gain
processing. Local `ProcessingPolicy` now keeps AEC + NS + gain for physical
routes and disables only AEC for virtual routes; full resets preserve the policy.
Integration with this helper's CPAL devices, WebRTC track, IPC, and bridge mode
remains local to this crate. The copied code is licensed under
Apache-2.0. Its license and notice are in `vendor/openai-codex/`.

`src/pulse/mod.rs` and `src/pulse/stream.rs` are adapted from
`src/host/pulseaudio/mod.rs`, `src/host/pulseaudio/stream.rs`, and
`src/host/latch.rs` in the cpal `0.18.1` crate
(<https://github.com/RustAudio/cpal>). cpal builds its PulseAudio host only
on Linux and the BSDs; the adaptation exposes it on macOS through cpal's
`custom` host, so a forwarded PulseAudio socket can carry the helper's audio.
Each file's header lists its changes. The copied code is licensed under
Apache-2.0, like the cpal crate, whose license `THIRD-PARTY-NOTICES.txt`
reproduces. Its PulseAudio protocol client, `pulseaudio` `0.3.1`, is a
registry dependency.

## Local CPAL visibility patch (protocol 7)

`vendor/cpal/` contains the published **0.18.1** source crate and Apache-2.0
`LICENSE`, with exactly one three-line source addition in `src/lib.rs`. The
archive's package-local `Cargo.lock` is omitted because CPAL is consumed as a
path dependency and the upstream crate itself ignores that file. The patch is
recorded in `vendor/cpal-0.18.1-visibility.patch`.

Source archive:
<https://static.crates.io/crates/cpal/cpal-0.18.1.crate>

SHA-256: `5f77b11176c37874be37e8d691c946e31b2b8c357abce9526f6a99eb469e1028`

The existing `macos::Device::new(AudioDeviceID)` is public and explicitly
supports hidden devices, but **the stock crate's containing modules are private**
and its public platform module does not export a CoreAudio device type. The
local patch exposes a macOS-only `CoreAudioDevice` type alias via the host's
associated `Device`. It changes no constructor, audio backend, device lookup,
stream logic, or dependency. The helper calls that existing constructor and
converts its result with CPAL's existing `From` implementation into the platform
`Device`. There is no custom host, enumeration workaround, transmute, or driver
source incorporated into the helper.

The constructor, platform conversion, and CoreAudio module were also checked
against the exact upstream tag
<https://github.com/RustAudio/cpal/tree/v0.18.1>, not current `main`.
The HAL qualifier ABI was checked against the macOS SDK `AudioHardware.h` and
the locked `objc2-core-audio` / `objc2-core-foundation` **0.3.2** sources.

To reproduce the vendored tree in a scratch directory, download the archive,
verify the hash above, extract it, remove its package-local `Cargo.lock`, then
apply the recorded patch with
`patch -p1 < /path/to/vendor/cpal-0.18.1-visibility.patch` inside the extracted
`cpal-0.18.1` directory. Comparing that tree with `vendor/cpal` should find no
differences. Remove the patch once upstream makes the constructor reachable.

`Cargo.toml` pins CPAL to `=0.18.1` and uses a path override for this exact tree.
The lockfile change is intentionally limited to removing CPAL's registry
source/checksum (now a path package) and adding the two already-locked objc2
packages to the helper's direct dependency list. All package versions and all
other dependency edges are unchanged. Validate using `cargo check --locked
--tests` and `cargo test --locked`; avoid a broad `cargo update`. Even a targeted
CPAL update can unnecessarily re-resolve unrelated Windows dependency edges.

`src/pulse/` remains untouched inactive reference source; the earlier description
of its custom-host integration is upstream provenance, not active configuration.
The separate GPL Pi Talk driver is not vendored here or modified by this work.

Sonora `0.2.0` and Rubato `5.0.0` are registry dependencies rather than
vendored source. Both are pinned in `Cargo.toml` and `Cargo.lock`.
Their binary-distribution notices and those of the introduced transitive
dependencies are in `vendor/rust-dependencies/`.
