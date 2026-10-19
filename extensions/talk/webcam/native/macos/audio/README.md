# PiTalk visible-input audio meters (macOS only)

Independent C++ addon, stable Node-API v8, no `node-addon-api`. It does not link to or rebuild `nativeBridge` or vc4m. macOS 13+, matching process architecture required.

## Safety / integration contract

**The normal webcam app starts this fixed virtual-input meter automatically; there are no listen toggles.** Requiring the addon itself is inert. `getStatus()` and idle `readLevels()` perform only CoreAudio metadata lookup; they do not create/open an AudioUnit, start capture, request permission, or change routing. The addon has no auto-start/retry/permission-request API, background thread, or timer; Electron main owns startup, permissions, **20 Hz** polling, and shutdown. Verification/synthetic runs must never call `start()`. Electron main may visibly retry only allowlisted transient callback stalls/timeouts or absence of this exact device, under already-granted permission: delays 2/5/15/30/60 seconds, then unavailable. It stops the old stream before retrying, zeros every level, and never requests permission on retry. See `../../../docs/speech-mouth.md` for the source-only recovery policy.

The sole eligible input UID is hard-coded:

```
io.github.willebergh.pitalk.audio.visible
```

Expected external agent TTS route: **PiTalkInternal OUTPUT → visible PiTalk INPUT**. This addon neither establishes nor modifies that route. It never selects the hidden Internal input (caller), a physical/default microphone, an aggregate/default device, system audio, or any fallback. No default-device or hardware-rate setters are used. UID-to-device-ID translation is verified again before starting AUHAL. Input bus 1 is enabled; output bus 0 is disabled. No output callback or output stream is used.

No PCM is exposed to JS, logged, transmitted, or written to disk. Only transient native input/FFT buffers and scalar meter values exist. No changes outside this folder are required by the build. Parent integration owns package scripts, IPC, TS, and the UI consent gate.

## Build (does not load the addon)

From the repository root:

```sh
node native/macos/audio/build.mjs
```

Output:

```
native/macos/audio/build/Release/pitalk_audio.node
```

The script reads the installed Electron package version, falling back to the exact root package version, and targets Electron **44.x** with node-gyp's Electron header URL. It builds only this directory. It may download Electron headers if they are not cached. There is no Electron launch, `require()` of the built addon, permission check, or audio test.

Optional entirely offline build using an existing header tree (`include/node/node_api.h`):

```sh
PITALK_AUDIO_NODEDIR=/absolute/path/to/cached/node/headers node native/macos/audio/build.mjs
```

Because the binary uses only stable Node-API v8 (no V8, libuv, Node C++ APIs, or `NODE_MODULE_VERSION` registration), cached host Node headers can be used for this build without an Electron ABI rebuild. The script still resolves and records the Electron 44 target. Match the architecture of Electron; universal packaging/signing is the parent's responsibility. Xcode command-line tools, installed node-gyp, and framework SDKs are needed.

## API (all synchronous)

```ts
getStatus(): {
  devicePresent: boolean;
  running: boolean;
  error?: string;
  deviceName?: string;
  deviceUid: 'io.github.willebergh.pitalk.audio.visible';
};
start(): ReturnType<typeof getStatus>;
stop(): void;
readLevels(): {
  rms: number;
  peak: number;
  bands: number[]; // always 12, low → high frequency
  sampleRate: number; // always 48000, also when stopped
  updatedAt?: number; // Unix epoch milliseconds of latest healthy callback
};
```

`start()` clears the previous error, resolves this UID, validates at least two input channels and the current **48000 Hz** hardware rate, and requires exact Float32 stereo, non-interleaved client PCM at that rate. It never changes the hardware sample rate. If unavailable, unsupported, permission-denied, or failing, it cleans up and throws an Error with code `PITALK_AUDIO_START`; the message remains available through `getStatus().error`. It is idempotent when already healthy. Startup waits up to 750 ms for a successful callback (silence counts) before returning; this briefly blocks the calling thread. Electron main must settle any first-time permission prompt before calling `start()`; this native API never requests permission. A first-callback timeout is eligible for the parent's bounded recovery only if permission is already granted.

`stop()` is idempotent, clears errors and meters, stops AUHAL, drains callbacks, removes the callback, uninitializes/disposes the unit, and frees buffers/FFT setup. A `napi_add_env_cleanup_hook` performs the same teardown when the environment exits.

Both status and level polling check device identity/aliveness, hardware rate, callback faults, and callback freshness. Disconnects, UID changes, format changes, render errors, oversized callbacks, invalid PCM, or a callback gap exceeding 250 ms become an error and trigger main-thread teardown at the next poll. No polling means no asynchronous error notification; continue polling while enabled. There is no native automatic reconnect; parent main owns bounded recovery and visible retry status. A stopped/stale stream always returns zero RMS, peak, and all 12 bands, with no `updatedAt`. Actual silent callbacks reset all meters immediately, without a smoothing tail.

## Meter meaning / RT constraints

- RMS uses power averaged across both channels; peak is the greatest absolute sample of either channel. Opposite-phase stereo cannot cancel.
- All displayed levels are **normalized dBFS bars**, not linear amplitudes: `clamp((20*log10(amplitude)+60)/60, 0, 1)`. Thus -60 dBFS and below map to 0, -30 dBFS to 0.5, and 0 dBFS to 1. They are not calibrated SPL/loudness or speech-recognition features.
- Twelve logarithmically spaced bands cover approximately 100–8000 Hz. Edges are `100 * 80^(i/12)`, for `i = 0…12`. A 2048-point Hann-window complex vDSP FFT, 1024-frame hop (~21 ms), integrates one-sided power, corrects window energy, and averages stereo power. Startup needs ~43 ms of nonsilent data for the first spectrum; FFT bin resolution is ~23.4 Hz.
- RMS/peak use short attack and 150–180 ms release; bands use 35 ms attack / 180 ms release. Silence overrides smoothing. `updatedAt` is a wall-clock estimate from a monotonic callback timestamp, not a PCM timestamp.
- Input buffers are allocated/touched before initialization, using AUHAL's validated maximum-frames value (at least 16384 requested; hard allocation cap 65536). Oversized callbacks fault without rendering into undersized buffers. The callback only renders the selected device, runs bounded preallocated DSP, and publishes lock-free atomics/counters. No JS/N-API, heap allocation, mutex, file/network I/O, logging, device lookup, or teardown occurs on the audio thread. JS polling takes bounded atomic snapshots; contention may produce one zero poll.

## Limitations

This is metering-only, not playback, a route manager, a permission manager, or a recorder. The external virtual driver and TTS route must already exist, at 48 kHz. Only the first two input channels are read. Other rates are rejected rather than resampled or changed. macOS/Electron may require a parent-app microphone usage description, user permission, signing, and sandbox audio-input entitlement; this module does not alter them or bypass macOS privacy controls. Sleeping, suspension, or unusually large driver buffers can trip the 250 ms watchdog. Parent main now has source-only bounded recovery for a stall, without loosening this threshold. The driver's 16,384-frame zero-timestamp period is not necessarily its AUHAL callback size; actual callback timing has not been measured for this change. Persistent stalls exhaust recovery and require an app restart. No native source/binary change or native rebuild is required for the parent recovery change. Load this addon only in the intended main-process environment, not independently in workers/renderers (each Node environment would otherwise own its own instance).

Implementation verification must not start capture: compiling and static binary inspection are safe. Never call `start()` as part of an automated smoke test. An explicitly scoped metadata-only check may load the addon and call `getStatus()` / idle `readLevels()` without opening a stream. Real stream/permission/speech-level validation is reserved for a deliberate normal-app launch; automated tests use fake meters and never start native capture.

### Implementation build result

Compilation succeeded for arm64 with Electron 44.9.0 selected, Node-API v8, and the existing Node 25.9.0 cached header tree (offline override). `file`, `otool -L`, and `nm` confirmed an arm64 Mach-O bundle, the intended framework dependencies, stable Node-API registration, and no V8/Node C++ imports. The binary was **not loaded**. No Electron instance, capture, permission request, device probe, or audio/runtime test was run. This is historical build-only evidence, not verification of the current automatic normal-app capture path.

A later parent **metadata-only** check loaded the addon without calling `start()`: exact UID resolved to installed `Pi Talk`, `running` was false, and idle RMS/peak/all twelve bands were zero. No stream or permission request was opened. This supersedes the build-stage 'not loaded' note above; actual audio capture is still untested.
