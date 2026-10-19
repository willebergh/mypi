# Multi-session FaceTime Talk

The extension-layer implementation has synthetic regression coverage; live-call validation is still required. No live FaceTime, microphone, camera, app-installation or permission change is performed by the automated tests.

## Starting and connecting

All processes must load this extension version and use the same Pi agent directory. The webcam app also needs a manually rebuilt version with the multisession protocol; an older prebuilt app cannot read the new aggregate feed. No Swift service or audio-driver change is required for session routing.

1. In the main Pi session, use `/name` to choose its routing name, then `/talk facetime` as usual. Main must be running before destinations connect.
2. In each destination, set a distinct `/name`, then run `/talk receive on`. This opts the current session into call routing **and public webcam-data sharing**; it does not open audio, control FaceTime, or launch the webcam app.
3. Main can call `facetime_sessions` to inspect names, absolute project directories, availability and activity. During an owned connected call it can call `facetime_transfer({ session, summary? })` with an exact session name.
4. The active destination can call `facetime_return_to_main({ summary? })` to transfer directly back. A connected but inactive destination cannot return someone else's conversation.

   Both tools accept an optional short handoff `summary` (at most 1,000 characters). It is quoted reference data with source name/directory—not a new task, instruction, approval or permission. It never submits work or imports the source history. Omission explicitly says no summary was supplied; no agenda is invented.
5. `/talk receive off` withdraws a destination. After main disconnects, reconnect explicitly with `/talk receive on`; there is no automatic task replay or automatic re-opt-in.

Renaming an attached session does not silently change a live route: disconnect and opt in again to publish the new name. Session/branch replacement, reload and shutdown withdraw the old attachment. Main's `/talk stop` ends FaceTime ownership and disconnects destinations without aborting their Pi work.

## Model

One explicitly enabled **main Pi session** owns the FaceTime controller lease, virtual audio, voice connection and webcam publisher. Other named Pi sessions explicitly connect as destinations. There is still **one call and one audible voice connection**, not simultaneous calls or conferencing.

A transfer selects which Pi session supplies context and receives voice-delegated tasks. It does not move FaceTime ownership or terminate the call. The main session can list destinations and transfer to any connected session, including selecting B while A is active; it does not need an intermediate main voice leg. A destination has only a direct return-to-main tool, not arbitrary transfer authority. There is no return-request/approval workflow.

## Session identity and metadata

Connected sessions automatically supply their Pi session name and absolute working directory (`ctx.cwd`). No separate project-directory configuration is needed. Multiple sessions may share a directory; directories are metadata, not identifiers.

Names are user-facing selectors. Internally a live connection is bound to its process/connection instance and Pi session identity. Missing or duplicate names/identities are rejected instead of selecting an arbitrary session. Names must be 1–128 display characters and at most 256 UTF-8 bytes; control/format characters (including joined emoji) are rejected before connection so one invalid identity cannot suppress the aggregate webcam feed. A restart, branch/session replacement, or reconnection must not inherit an old conversation or pending task authority.

Discovery includes a bounded availability/activity summary. It does not publish raw tool arguments, credentials, reasoning or an entire session history.

## Sharing and webcam

Connection opts into call routing **and webcam-data sharing**. Treat this as consent to share the same bounded public session data as the existing webcam feed: model/context, subagent activity, todos, usage, public conversation and compact rendered tool previews. Public project content can be sensitive; credential redaction is best-effort, not a guarantee.

The main publisher aggregates separate snapshots for all connected sessions. Each retains its own name, project directory and live identity; main and active-conversation identity are explicit. Histories are not merged. Voice/call captions and the call presentation remain scoped to the active conversation. Disconnect/revocation removes the session rather than leaving a misleading live card.

## Transfer safety

- Transfers are serialized and invalidate callbacks from the previous route.
- Close and reap the previous voice leg before preparing/enabling a replacement. Sending a mute command alone is not a mute acknowledgement.
- The coordinator still controls audio: only an owned, verified connected call can enable it. Ending/disconnecting during transfer invalidates pending preparation.
- Submitted Pi tasks remain owned by the destination Pi process. Transferring, disconnecting, or ending a call never aborts them or clears its native queue.
- A lost acknowledgement is uncertain submission, not permission to replay a task. Old results must not be spoken into a new route.
- Destination loss returns the conversation to main with a notice when call authority permits; failed voice preparation remains visibly unavailable rather than claiming successful recovery.
- Every new call starts at main. Transfers do not reset the call's ten-minute limit or replay an outgoing greeting.
- Remote voice questionnaires and remote voice Stop are initially unavailable. Transfers with a pending questionnaire at the source or destination (including main) are rejected rather than guessing at an answer or cancelling unrelated work. Destination activation is acknowledged after its summary is prepared and rechecks questionnaire state before audio is enabled. Local and remote task admission share vague-task and parsed retired-question-control guards.
- Receiving voice grants no tool approval, sharing permission, call permission or access to other sessions' histories.

## Local IPC boundary

A private, bounded, versioned Unix-socket protocol connects opted-in sessions. Use the same Pi agent directory for main and destinations. There is no network listener or automatic session-file scanning. Existing/ambiguous socket ownership fails closed rather than deleting another process's endpoint.

Filesystem permissions isolate other OS users; processes running as the same user are trusted. This is not an authentication boundary against malicious same-user processes or a cryptographically authenticated remote caller.

## Manual validation before relying on it

After synthetic tests, use an explicitly authorized harmless call to verify:

1. Connect two differently named sessions, including one already working, and inspect their automatic directories/activity.
2. Confirm all opted-in session snapshots arrive separately in the webcam app; an unconnected session must not appear.
3. Transfer main → destination → main: same FaceTime call, a brief silent transition, no overlapping speakers and target-specific context.
4. Submit a harmless task, transfer before it completes, and verify its result is not spoken into another route or rerun.
5. Revoke/exit/reload a destination and confirm removal, explicit fallback to main, and no task cancellation/replay.
6. Hang up during a transfer and confirm no late audio activation; the next call starts at main.
7. Verify duplicate names, missing main, pending questionnaires, unknown transfer outcome and unavailable voice all fail clearly.

A passing synthetic test is not proof of audible delivery, live FaceTime continuity or remote receipt of webcam pixels.

## Synthetic validation checkpoint

- Root `npm run check`: passes.
- Root `npm test`: 1,120 passed, 1 skipped, 0 failed (1,121 total).
- Regression coverage includes duplicate identity/name rejection, socket publication ownership, native reaping before replacement, direct main A→B routing, return-only destination permissions, handoff-reference bounds, no old-result playback/task replay, failed-start recovery without hangup, cancelled-transfer rejection, questionnaire preparation/activation races, and simultaneous webcam snapshots/expiry.
- The webcam package's broad suite still has 16 failures already present in the saved baseline (20 baseline failures; no new failure names). Its separate typecheck remains blocked by an existing incomplete desktop API in `src/preload/index.ts`. These are not a passing packaged-app claim. No native helper, app package, camera or live call was started.
