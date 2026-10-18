# Pi Talk macOS Audio Driver

A self-contained macOS Core Audio driver for Pi Talk. One installed bundle exposes two crossed duplex endpoints:

- **Pi Talk** — visible; select this as both speaker and microphone in Discord, FaceTime, or another call app.
- **Pi Talk Internal** — hidden; Pi Talk opens this endpoint directly by its stable Core Audio UID.

```text
Call output  -> Pi Talk output          -> Pi Talk Internal input -> Pi Talk capture
Pi Talk audio -> Pi Talk Internal output -> Pi Talk input          -> Call microphone
```

The directions use separate ring buffers, so an endpoint never reads back its own output.

This is an unofficial GPLv3-licensed modification of [ExistentialAudio/BlackHole](https://github.com/ExistentialAudio/BlackHole). It is not affiliated with or endorsed by Existential Audio Inc.

## Identity and format

- Bundle: `PiTalk.driver`
- Bundle ID: `io.github.willebergh.pitalk.audio.driver`
- Visible UID: `io.github.willebergh.pitalk.audio.visible`
- Internal UID: `io.github.willebergh.pitalk.audio.internal`
- Format: 48 kHz, stereo, 32-bit float PCM
- Platform: Apple Silicon, macOS 12 or newer

The internal endpoint is intentionally omitted from normal device pickers. Pi Talk must resolve its UID with `kAudioHardwarePropertyTranslateUIDToDevice`; numeric `AudioDeviceID` values are not persistent.

## Build

Requires Xcode and Python 3:

```bash
./Scripts/build_pi_talk_drivers.sh
```

Outputs:

```text
dist/pi-talk-macos-audio-driver/PiTalk.driver
dist/pi-talk-macos-audio-driver.zip
```

## Install

```bash
./dist/pi-talk-macos-audio-driver/install.sh
```

The installer removes legacy multi-device Pi Talk builds, installs the one new bundle in `/Library/Audio/Plug-Ins/HAL`, and restarts Core Audio.

Configure the call application:

```text
Microphone: Pi Talk
Speaker:    Pi Talk
```

Pi Talk itself should open `io.github.willebergh.pitalk.audio.internal` for both capture and playback.

See [`PI_TALK_AUDIO.md`](PI_TALK_AUDIO.md) for verification and integration details.

## Tests

```bash
xcodebuild -project BlackHole.xcodeproj \
  -target BlackHoleTests -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
./build/Debug/BlackHoleTests
```

## License

This component and its modifications are GPLv3. See [`LICENSE`](LICENSE) and [`PI_TALK_DRIVER_NOTICE.md`](PI_TALK_DRIVER_NOTICE.md). See [`UPSTREAM.md`](UPSTREAM.md) for upstream provenance.
