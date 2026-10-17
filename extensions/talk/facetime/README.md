# FaceTime control service

Native Swift executable for observing and controlling macOS FaceTime calls. Intended to provide FaceTime call control alongside Talk's existing voice pipeline.

This package remains an independent service exposing a local Unix socket. The TypeScript Talk extension now provides **FaceTime standby mode**, mode-scoped tools, and physical/virtual audio profiles; see [INTEGRATION.md](INTEGRATION.md). Swift does not start or stop `/talk` itself.

## Responsibilities

- Discover FaceTime, Notification Centre, and related processes.
- Observe their UI with public macOS Accessibility APIs.
- Identify incoming callers and enforce a local caller allowlist.
- Answer incoming calls manually or automatically when configured.
- Initiate FaceTime Audio calls to explicitly allowlisted phone/email addresses.
- Confirm the outgoing “Click to Call” banner.
- Observe ringing, verified connection, ending, and some failure conditions.
- Select FaceTime-specific microphone and output devices.
- Expose commands and events over a Unix domain socket.

This executable does **not** capture, stream, transcribe, or generate audio. It does not communicate with an AI service or hold AI credentials.

## Requirements

- macOS 13 or later as declared by the package; actual FaceTime UI behavior was tested on macOS 26.2 with English UI.
- Swift 6 tooling / Xcode command-line tools.
- A logged-in GUI session with FaceTime configured.
- Accessibility permission for the process hosting the executable or the installed executable itself, depending on how it is launched.
- Virtual audio drivers installed and the explicit pair selected in Pi's shared config for Talk over FaceTime.

There are no third-party Swift dependencies. UI labels and process ownership can differ across macOS versions or languages; the declared deployment target is not a guarantee of compatibility with every FaceTime version.

## Build and test

From this directory:

```sh
swift build -c release
swift test
```

Executable:

```text
.build/release/facetime-observer
```

Tests use synthetic call observations and temporary config files; they do not place real calls or open audio devices. They cover state transitions, timer-based connection verification, confirmation-banner detection, stale failure suppression, identity normalization, and configuration loading. AX actions and socket behavior still require additional coverage and live testing.

## Standalone app (recommended)

From the repository root, `npm run talk:facetime:install` builds and locally ad-hoc-signs **Pi FaceTime Bridge.app**, then installs it under `~/Applications`. Open it through Finder/LaunchServices and use its menu to grant/check Accessibility. No developer account is needed; the app build never launches or requests permission by itself. Actual TCC attribution and grants need manual verification. See [APP.md](APP.md) for the full workflow; automatic startup from Pi remains deferred.

The direct CLI below remains a developer/debug option. Running it inside a terminal can attribute Accessibility to that terminal.

## Accessibility permission

```sh
swift run facetime-observer permission --prompt
```

Enable the terminal/app hosting the executable in **System Settings → Privacy & Security → Accessibility**, then restart it if necessary. A separately installed or differently launched binary may require its own permission entry.

Check without prompting:

```sh
swift run facetime-observer permission
```

Run in the user's GUI session, not as root or as a system LaunchDaemon. No LaunchAgent installer is included yet.

## Configuration

The app and Pi read **`~/.pi/agent/talk.json`**, or `talk.json` under `PI_CODING_AGENT_DIR` when that environment is available. See the [shared configuration reference](../CONFIG.md) for the complete schema and migration/backups.

In Pi, run `/talk devices virtual` to create/migrate the file and select the CoreAudio pair. Edit its `facetime` section to set `allowedCallers`, `allowedRecipients`, `recipientAliases`, `callStartTimeoutSeconds`, and `ringingTimeoutSeconds`. Keep the file owned by you with **`chmod 600 ~/.pi/agent/talk.json`**. There are no separate FaceTime device or auto-answer fields; Swift derives the inverse pair from `audio.virtual`, while Pi coordinates answering after readiness.

- Missing config uses empty allowlists, no automatic answering/routing, and 15/60-second timeouts.
- Malformed, unsupported, non-private, or symlinked config is rejected rather than silently falling back.
- Start reads the file; `config.reload` reloads that same selected path only while idle and applies routing. Pi requests this automatically on FaceTime mode enable. Changes do not rewire an active call.
- `allowedCallers` matches the identity actually exposed by the incoming banner.
- `allowedRecipients` should contain exact international phone numbers or FaceTime email addresses, not ambiguous contact names.
- `recipientAliases` explicitly maps an outgoing address to the contact names FaceTime may display in its confirmation and call banners. These aliases authorize UI matching, not alternate outgoing dial targets.
- Matching normalizes casing, surrounding whitespace, phone punctuation, and selected bidirectional formatting characters. It does not resolve Contacts or infer country codes.
- A contact display name match is **not** cryptographic verification of a caller's phone/email identity. Configure names only if that trust level is acceptable.

For a custom Pi agent directory, use the app's **Choose Talk config…** menu, then Stop/Start (or Retry). macOS preferences store only the selected location. Pi checks the reported path so a GUI app that lacks the terminal environment cannot silently use different policy. An explicit CLI `--config PATH` still wins; developer CLI flags remain available for debugging, not as another persisted configuration. See `--help`.

## Audio routing with Talk

The two applications use opposite ends of the virtual devices:

| Application | Microphone / capture | Output / playback |
|---|---|---|
| Talk | Agent Input | Agent Output |
| FaceTime | Agent Output | Agent Input |

```text
Remote caller → FaceTime output → Agent Input → Talk capture
Remote caller ← FaceTime microphone ← Agent Output ← Talk playback
```

Both applications read the same `audio.virtual` profile in `talk.json`: Talk uses its CoreAudio IDs and Swift derives FaceTime's inverse pair from its exact menu names. Neither duplicates the other's settings. Virtual device drivers and names must still be set up on each Mac.

Selection uses the hidden Accessibility children of FaceTime's **Video → Microphone / Output** menu and `AXPick`. It does **not** open the menu or change global macOS sound settings. Opening the menu programmatically previously captured desktop keyboard focus, so the service deliberately avoids that approach.

Configured routing is attempted when a FaceTime PID is first observed and before outgoing call initiation. A failed startup routing attempt may be retried on later reconciliations. Incoming answering does not depend on reapplying routing because FaceTime's menu may be unavailable while the incoming banner is shown. `audio.select` is an immediate selection; it does not rewrite the configuration.

## Run and monitor

Start exactly **one** service instance:

```sh
swift run facetime-observer watch > observer.ndjson
```

In another terminal:

```sh
swift run facetime-observer monitor
```

Typical output:

```text
READY

14:32:52  CONFIRMING CALL — Expected Recipient
14:32:56  CALLING — Expected Recipient, audio
14:33:00  CONNECTING — Expected Recipient, audio
14:33:02  CONNECTED — Expected Recipient, audio, verified
14:33:10  ENDED — Expected Recipient, audio, participant left
```

`monitor --verbose` includes AX and process diagnostics. Stop with Ctrl-C.

The service is a foreground process. It holds an adjacent `.lock` file with a lifetime advisory lock before binding/unlinking the socket, rejects a second cooperating instance, and removes only its own socket on stop. Stop any older, pre-locking instance before starting this version. Talk also uses a separate controller lease so two Pi sessions cannot control the service concurrently.

## Unix socket protocol

Default socket:

```text
~/.local/share/pi-facetime/control.sock
```

The socket is created with mode `0600`; a newly created containing directory uses `0700`. An existing directory's permissions are not automatically repaired. Access is local to this Mac; no TCP server is created.

Protocol is UTF-8 **newline-delimited JSON**. A persistent connection carries responses and asynchronous events together. Every client receives an initial `snapshot` containing current call state, configuration summary, permission status, and process summaries.

Interactive access:

```sh
nc -U ~/.local/share/pi-facetime/control.sock
```

Paste one command per line and press Enter:

```json
{"type":"command","id":"status-1","command":"status"}
{"type":"command","id":"call-1","command":"call","to":"+46000000000"}
{"type":"command","id":"answer-1","command":"answer"}
{"type":"command","id":"hangup-1","command":"hangup"}
{"type":"command","id":"devices-1","command":"audio.devices"}
{"type":"command","id":"audio-1","command":"audio.select","input":"Agent Output","output":"Agent Input"}
{"type":"command","id":"inspect-1","command":"inspect"}
{"type":"command","id":"snapshot-1","command":"snapshot"}
{"type":"command","id":"discover-1","command":"discover"}
```

Use a real configured recipient only when intentionally placing a call. Commands have side effects; do not automatically replay call/answer/hangup commands after a timeout or disconnect.

### Commands

| Command | Behavior |
|---|---|
| `status` | Return cached call state and compact service diagnostics. |
| `call` | Enforce recipient allowlist, apply configured routing, launch FaceTime Audio URL, and track the outgoing request. |
| `answer` | Require an identified allowlisted incoming caller and attempt answering. |
| `hangup` | Attempt pressing the accessible `End` control. |
| `audio.devices` | Read FaceTime's input/output menu entries and selection marks. |
| `audio.select` | Select supplied `input` and/or `output` exact device names. |
| `inspect` | Force reconciliation and return full current AX trees. |
| `snapshot` | Save cached process snapshots to `--snapshot-dir` or `./snapshots`. |
| `discover` | List likely FaceTime/call-related process candidates. |

Successful response example:

```json
{"type":"response","id":"hangup-1","ok":true,"result":{}}
```

Structured error example:

```json
{"type":"response","id":"call-1","ok":false,"error":{"code":"recipient_not_allowed","message":"Recipient must exactly match the Swift recipient allowlist"}}
```

A successful command response means the request/action was accepted or attempted—not that the call connected or the action's intended outcome occurred. Wait for lifecycle evidence.

### Events

Semantic events include:

- `call.incoming`
- `call.confirmation_attempted`
- `call.answer_attempted`
- `call.dialing`
- `call.unknown`
- `call.connected`
- `call.ended`
- `call.failed`

Additional events include `bridge.status`, `audio.routing`, process starts/stops, and AX diagnostics. Consumers should filter for the event types they need and tolerate additional fields/types.

Example:

```json
{"type":"event","protocolVersion":1,"seq":42,"timestamp":"2026-10-17T14:33:02.000Z","event":"call.connected","callId":"local-1","direction":"outgoing","identity":"Expected Recipient","media":"audio","durationSeconds":2,"verified":true,"evidence":"advancing_duration"}
```

Events, initial snapshots, and responses carry `protocolVersion: 1`. Events/snapshots include a per-process `serviceInstanceId`, and snapshots include the current `seq` watermark. Incoming events and incoming snapshot call state include an `allowed` boolean computed from the local caller allowlist. Call IDs/sequences remain local to one service instance; no event replay is provided.

`verified` describes an event's local evidence; it is not a universal delivery/success/authentication guarantee. In particular, `call.answer_attempted` currently reports successful event creation/posting, not confirmation that FaceTime accepted the call. Only the advancing timer verifies connection.

A client should correlate responses by `id`, parse complete newline-delimited records across arbitrary socket chunks, impose request timeouts, reconnect, and reconcile the new initial snapshot. Do not assume one socket read equals one JSON record. The server bounds input frames to 64 KiB and queued output per client to 1 MiB; stalled output is disconnected after a five-second drain deadline. Oversized inspection output can disconnect a client.

## How call detection and control work

### Observation

`NSWorkspace` discovers candidate processes. AX observers subscribe to available notifications. Full tree reconciliation runs periodically (default two seconds), updating the semantic state machine. Currently AX callbacks emit diagnostics; semantic state transitions are primarily driven by reconciliation, not immediate notification-triggered reads.

On the tested Mac, the important banner belongs to **Notification Centre**, not FaceTime.app. The banner exposes `FACETIME_NOTIFICATION` as its identifier/description.

### Incoming

An incoming banner exposes caller text and `Answer`/`Decline`. The service extracts the identity and requires a normalized allowlist match before answering. Auto-answer is opt-in and schedules one attempt per tracked call after a short 600 ms stabilization delay.

**Incoming Answer is the deliberate coordinate fallback:** `AXPress` returned success but caused the call to fail on the tested macOS. The service instead reacquires the caller-verified banner and its exact Answer element, reads its live AX position/size, posts a mouse click at the dynamic center, then restores the pointer. No fixed coordinates are stored. This requires a visible GUI session and can briefly move the pointer; occlusion, animation, or concurrent user interaction remain limitations.

### Outgoing

The service opens `facetime-audio://…` explicitly with FaceTime. macOS can show a **Click to Call** confirmation rather than immediately ringing. During an active outgoing request only, the service checks the displayed identity against the requested address/its configured aliases, then presses that banner's `Call` button with `AXPress`.

The confirmation is not treated as ringing or connection. The requested address is stable, but any friendly-name alias is an explicitly configured trust mapping, not independent proof of the underlying remote handle.

### Connected

The tested outgoing ringing description looks like `FaceTime Audio…`. After answer, a duration appears (`0:00`, `0:02`, ...).

The service emits `call.unknown` on the first duration observation and verified `call.connected` only after the duration advances. A hangup/mute/keypad control can already exist while ringing and is never sufficient connection evidence.

### Ended and failed

The state machine observes panel disappearance and participant-left notifications. Disappearance requires two missing reconciliations unless a participant-left notification is present. A successful local `End` action marks a requested local hangup; actual UI disappearance supplies subsequent ending evidence.

Failure handling includes call UI startup timeout, ringing timeout, observed unapproved recipient identity, and some failure text exposed inside the call banner. Timeout handling attempts `End` where available; it never kills FaceTime as a workaround. Remote decline versus early cancellation, network failure, and unknown disappearance cannot always be distinguished reliably. Account/network errors outside the observed banner are not comprehensively classified.

Persistent `Call Failed` banners do not create repeated new calls. Only one call is tracked; multi-call/conference scenarios and localization need further work.

## Inspection and snapshots

```sh
swift run facetime-observer discover
swift run facetime-observer dump --bundle com.apple.FaceTime
swift run facetime-observer dump --process Notification --keyword Answer
swift run facetime-observer snapshot --snapshot-dir ./snapshots
swift run facetime-observer watch --snapshot-dir ./snapshots > observer.ndjson
swift run facetime-observer --help
```

With `--snapshot-dir`, snapshots are saved at semantic call transitions, not every timer tick. Dumps support role/title/description/value/identifier/action inspection and depth/node limits.

**Logs and snapshots contain private caller details, emails, phone numbers, and potentially unrelated accessible UI text.** Do not commit them or personal configuration. Build output, logs, and snapshots are machine-local artifacts, not source to distribute.

## Source map

| File | Responsibility |
|---|---|
| `main.swift` | CLI/app entry dispatch, configuration application, service lifecycle, commands, routing, and timeouts. |
| `Application.swift` | Standalone menu-bar app and explicit Accessibility/service controls. |
| `Configuration.swift` | JSON configuration and permission checks. |
| `Processes.swift` | Candidate process discovery. |
| `AXInspector.swift` | Tree reading and AX observation. |
| `AXActions.swift` | Answer, confirmation, and end-control actions. |
| `AudioRouting.swift` | FaceTime's hidden device menu and `AXPick` selection. |
| `FaceTimeCalling.swift` | Explicit FaceTime Audio URL launch. |
| `CallState.swift` | Call/confirmation extraction and local state tracking. |
| `SocketServer.swift` | Single-instance Unix socket, bounded NDJSON framing, and nonblocking client output. |
| `ServiceMetadata.swift` | Service instance/sequence metadata and incoming allowlist flags. |
| `ServiceRun.swift` | Per-start lifecycle token that prevents stopped services from executing stale callbacks. |
| `HumanMonitor.swift` | Human-readable socket client. |
| `JSON.swift` | JSON, timestamps, and AX value/error formatting. |

## Talk integration boundary

The Swift executable stays independent at runtime. Talk's TypeScript coordinator connects to this socket, prepares gated virtual audio before answering, exposes tools only in FaceTime mode, and returns to standby after owned calls end. The shared file has no auto-answer flag: Swift observes/enforces policy, while Pi prepares Talk and requests Answer. A debug CLI service with standalone auto-answer enabled is rejected by the coordinator.

Regular Talk and FaceTime mode are mutually exclusive. Hangup, service disconnects, Pi-session changes, and the ten-minute limit close only owned voice resources; they do not abort queued/running Pi work. Audio remains on existing virtual devices, never on the control socket. Detailed setup and limitations are in [INTEGRATION.md](INTEGRATION.md).
