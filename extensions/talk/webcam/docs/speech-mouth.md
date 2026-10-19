# Agent speech equalizer mouth

## Use

1. Restart Electron once for the new main/preload API. The audio addon was built separately; `pnpm audio:build` rebuilds only that addon if needed.
2. On normal app startup, the app automatically begins listening to the fixed Pi Talk virtual agent-speech input. Approve macOS Microphone access if prompted (the development process is named **Electron**). This permission covers opening the selected virtual input, not selecting a physical microphone.
3. Agent speech drives twelve amber/eye-color bars below the eyes. Silent, stale or disconnected audio settles to a thin dotted mouth. During CRT boot the mouth is suppressed; it appears with the eye awakening.
4. Capture ends on Quit. Callback stalls/startup callback timeouts and temporary absence of this exact device receive bounded automatic retries, only with already-granted permission. Other faults remain unavailable. Verification and synthetic-fixture runs must not start live capture.

The recovery change is **source-only and runtime-unverified**: no tests, checks, builds, apps, restarts, permissions, provider requests or capture probes were run. There is no manual Enable/Disable UI. Failed/missing-device states never fall back to another source.

## Capture-stall recovery (source-only)

Confirmed source failure path: native `kStaleMs` is **250 ms**, with message `PiTalk input callbacks stalled (>250 ms)` (not 150 ms). Startup separately waits **750 ms** for its first successful callback. Silent PCM and `OutputIsSilence` callbacks both advance liveness. `Refresh()` stops/disposes AUHAL on a stale callback; `readLevels()` can do this without throwing. Previously Electron checked native status only once per second, stopped polling on error, and had no recovery path, leaving the read-only UI permanently unavailable after one gap.

Main now inspects native status after each level read and on metadata reads while active. A failure stops/drains the old stream, immediately zeros RMS/peak/all bands and reports **Retrying…** or **Unavailable**. Only the exact native stall, first-callback timeout, device-absent and disconnected messages are allowlisted: the native start code `PITALK_AUDIO_START` alone cannot distinguish permission/format/render faults. Retry delays are **2, 5, 15, 30, 60 seconds**, then unavailable with the original error and exhaustion notice. A restart that briefly succeeds does not replenish the budget; only **30 seconds of healthy polling** does. Healthy startup clears the old error and reports **Listening**. Missing backend, lookup errors, permission denial, format/selection changes, render/PCM/allocation faults and failed teardown do not retry.

Retries never request permission. At most the initial normal-app start may prompt once; pending permission responses, cancelled/old-generation polls and retry timers cannot restart capture after close. Main also explicitly blocks capture for verification/synthetic/duplicate instances. No default/physical/caller input, device-rate changes or parallel AudioUnits are introduced.

The underlying reason for the observed callback gap (scheduler jitter, sleep, HAL/device interruption, etc.) is **not established** by the error. Driver source returns silent buffers when there is no output; it does not intentionally stop callbacks during silence. Its 16,384-frame zero-timestamp period (~341 ms at 48 kHz) is a clock-reporting period, **not proof of the actual AUHAL callback buffer size**. Native reads the actual device buffer size when allocating; it does not expose that size to JS. No new runtime timing probe was authorized. The native 250 ms fail-closed watchdog and 750 ms startup grace are unchanged rather than loosened without evidence. Brief gaps may still cause a silent teardown/retry; persistently slow/dead streams eventually remain unavailable.

Deployment later requires the updated Electron main and renderer code to be built/deployed and the **Electron main process restarted**; a renderer reload alone is insufficient. **No native addon or virtual-driver rebuild is needed for this change**: native source is untouched. Regression test sources in `test/speech-audio-auto.test.mjs` use fake meters/timers only and were not executed.

## Correct source (mypi inspected read-only)

Source-defined endpoints:

- **Pi Talk Internal**, hidden UID `io.github.willebergh.pitalk.audio.internal`
- **Pi Talk**, visible UID `io.github.willebergh.pitalk.audio.visible`

Their duplex routes are crossed:

```
agent output → Pi Talk Internal OUTPUT → Pi Talk INPUT → call-app microphone
caller output → Pi Talk OUTPUT → Pi Talk Internal INPUT → agent capture
```

Therefore this app meters **visible Pi Talk INPUT**, by exact UID. Reading Internal input would animate the caller instead of the agent. It never selects a default/physical input, aggregate device, system audio tap, or the hidden endpoint. It does not change device defaults, sample rates, routing, FaceTime calls, or any `mypi` source/configuration.

Read-only evidence came from `mypi/extensions/talk/macos-audio-driver/{README.md,PI_TALK_AUDIO.md,Scripts/build_pi_talk_drivers.sh,BlackHole/BlackHole.c}`, Talk `CONFIG.md`, native `virtual_audio.rs`, `audio.rs` and protocol sources. The existing native `playback_activity` event is only activity, not a spectral meter, and is currently discarded by the extension. No credential/config-secret/session-body reads were needed. macOS System Profiler confirmed the visible Pi Talk device exists; no stream was opened for inspection.

## Implementation

- `native/macos/audio/audio.cc`: independent stable Node-API addon, exact UID verified before AUHAL starts; input bus enabled, output disabled. 48 kHz stereo Float32 only; no device-rate/default setter or fallback. Bounded preallocated 2048-point FFT, twelve logarithmic bands around 100–8000 Hz. PCM stays transient/native and is never logged, saved, sent to renderers or a server.
- `src/main/speech-audio.ts`: only owner. Metadata getters do not open streams. The parent main process calls `speechAudio.enable()` during normal app startup; this may request permission once and starts capture. `close()` cancels pending recovery and ends capture on Quit. The addon is polled at 20 Hz only while running; bounded backoff replaces polling while retrying. Failure never selects another input.
- Native RMS, peak and spectral bars use normalized -60…0 dBFS. Main converts RMS/peak back to linear amplitude for the mouth's silence gate; bands remain normalized display values. Only scalar levels and metadata cross IPC to preview and output.
- `src/shared/speech-audio-feed.ts`: same read-only feed for preview and hidden output. It never starts capture. Missing old APIs remain silent until an app restart.
- `src/avatar/robot.ts`: the mouth is part of the existing curved CRT shader, not a separate draw/HTML overlay. Twelve real spectral bins, 35 ms attack / 145 ms release, independent of Idle intensity. Missing/stale frames (>250 ms) release to rest; no oscillator or fabricated talking animation.
- `src/ui/SpeechAudio.tsx`: read-only listening/starting/retrying/unavailable status and level, with device, permission and error feedback; no start/stop controls.
- `forge.config.ts`: microphone usage description and packaged addon resource. No camera-extension or signing changes.

See `native/macos/audio/README.md` for native lifecycle, callback constraints and build/API details. A native start can briefly block main while awaiting the first callback (750 ms maximum); live timing/performance is not yet measured.

## Historical verification (predates recovery; not rerun)

- `pnpm typecheck` passed.
- Native addon compiled for arm64 / Electron 44.9.0 using stable Node-API v8 and cached headers. A subsequent **metadata-only** Node check loaded it, resolved the exact visible UID to **Pi Talk** on this Mac, and confirmed `running: false` with zero RMS/peak and twelve zero bands. `start()` was never called and no permission was requested.
- Read-only Luna review checked consent, exact routing, cancellation, stale silence and shared feeds; no actionable issues found.
- One short hidden GPU capture used **explicit synthetic numerical test fixtures**, not live audio. Speaking changed 7,576 face-region bitmap bytes; the stale fixture returned to the exact rest bitmap (0 differing bytes), including Idle intensity zero. No renderer/shader errors. Chromium emitted a teardown Skia mailbox diagnostic after success.

Artifacts:

- `evidence/speech-mouth/mouth-rest.png`
- `evidence/speech-mouth/mouth-spectrum-fixture.png`
- `evidence/speech-mouth/mouth-stale.png`
- `evidence/speech-mouth/checks.json`

These verify the mouth shader and numeric feed, not actual microphone permission, driver behavior or live speech capture. No full app package/regression suite was run.

## Separate follow-up

Todo #12 was subsequently implemented: see `docs/output-monitor.md` for dual editor/output-source views and selectable camera framing. It remains separate from the speech capture pipeline.
