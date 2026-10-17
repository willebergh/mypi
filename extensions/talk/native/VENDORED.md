# Vendored native audio code

`src/codex_audio/buffers.rs` and `src/codex_audio/processing.rs` are adapted
from `codex-rs/voice-host/src/device_buffers.rs` and
`codex-rs/voice-host/src/processing.rs` in
<https://github.com/openai/codex> at commit
`7498521d288b9b3b96ffba4eedf089d8d6e06a84`.

The adaptations retain Codex's callback frame boundaries, capture-generation
isolation, Rubato streaming conversion, and Sonora echo, noise, and gain
processing. Integration with this helper's CPAL devices, WebRTC track, IPC,
and bridge mode remains local to this crate. The copied code is licensed under
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

Sonora `0.2.0` and Rubato `5.0.0` are registry dependencies rather than
vendored source. Both are pinned in `Cargo.toml` and `Cargo.lock`.
Their binary-distribution notices and those of the introduced transitive
dependencies are in `vendor/rust-dependencies/`.
