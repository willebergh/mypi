# Pi Talk macOS audio routing

## Endpoints

`PiTalk.driver` publishes two 48 kHz stereo duplex devices:

| Endpoint | Visibility | Used by |
| --- | --- | --- |
| `Pi Talk` | Normal device menus | Discord, FaceTime, and other call apps |
| `Pi Talk Internal` | Hidden | Pi Talk native audio helper |

The routes are crossed and isolated:

```text
Pi Talk visible output -> visible-to-internal buffer -> Pi Talk Internal input
Pi Talk Internal output -> internal-to-visible buffer -> Pi Talk visible input
```

Consequently, the call app can select `Pi Talk` for both input and output without hearing its own output as microphone input.

## Stable identifiers

```text
Bundle ID:    io.github.willebergh.pitalk.audio.driver
Visible UID:  io.github.willebergh.pitalk.audio.visible
Internal UID: io.github.willebergh.pitalk.audio.internal
```

Pi Talk must persist the internal UID, resolve it through `kAudioHardwarePropertyTranslateUIDToDevice`, and reopen the resulting device for both input and output. It must resolve the UID again after Core Audio or the driver restarts; `AudioDeviceID` is process-lifetime state, not a stable identifier.

## Build and install

From a source checkout (or from the distribution's `Source/` directory), build with:

```bash
./Scripts/build_pi_talk_drivers.sh
```

Install that source build with:

```bash
./dist/pi-talk-macos-audio-driver/install.sh
```

From an extracted binary distribution, install its bundled driver with:

```bash
./install.sh
```

Close audio applications before installation. After Core Audio restarts, normal audio menus should show exactly one Pi Talk endpoint named `Pi Talk`. The hidden endpoint is not expected to appear in those menus.

Configure the call application:

```text
Microphone/input: Pi Talk
Speaker/output:   Pi Talk
```

Pi Talk's native helper should use `Pi Talk Internal` by UID for both capture and playback.

## Verification

1. Resolve `io.github.willebergh.pitalk.audio.internal` and confirm it returns a valid device ID.
2. Write a test signal to `Pi Talk`; confirm it arrives only at `Pi Talk Internal` input.
3. Write a different signal to `Pi Talk Internal`; confirm it arrives only at `Pi Talk` input.
4. Run both directions simultaneously and check for crosstalk or self-loopback.
5. Restart Core Audio, resolve the UID again, and recreate all streams.

For virtual call audio, start with acoustic echo cancellation disabled in Pi Talk. The driver routing must provide isolation; AEC should not be used to mask an unintended loop.

## Uninstall

From a source checkout, run `./Scripts/uninstall_pi_talk_drivers.sh`. From an extracted binary distribution, run `./uninstall.sh`.

This removes the current bundle and old Pi Talk/Agent test bundles, then restarts Core Audio.

## Distribution

The binary package includes GPLv3 notices and complete corresponding source under `Source/`. This is an unofficial BlackHole-derived driver and is not affiliated with Existential Audio Inc.
