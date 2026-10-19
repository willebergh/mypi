# Opted-in multisession webcam data

The main Pi remains the **only HUD socket publisher and app owner**. Receivers collect the existing projection without binding a socket or launching anything. The coordinator must start collection only after explicit receiver opt-in and forward it only while its opted-in IPC connection is live; dispose collection on disconnect/revoke. No receiver gains presentation-tool authority.

## Bridge integration exports

`extensions/talk/webcam-bridge.ts` exports `LiveSnapshot` (the existing `LiveHudSnapshot`), `WebcamSnapshotListener`, and `WebcamMultisession`:

```ts
const dispose = await webcam.startProjection!(ctx, (snapshot: LiveSnapshot | null) => {
  // Full replacement to the opted-in main over private IPC; null revokes it.
});
dispose(); // idempotent; no socket/app was started

webcam.setMultisession!({
  mainSessionId,
  activeSessionId,
  sessions: [{ instanceId, sessionId, name, cwd, isMain, snapshot }],
});
webcam.setMultisession!(undefined); // legacy single-session framing
```

The optional interface methods preserve compatibility with older injected test bridges; the real registered bridge always supplies them. One collector subscriber per bridge: replacement revokes the previous subscriber; its old disposer cannot stop the new subscriber. `stop()`/shutdown stops both sharing and collection. A collector alongside an already-running main publisher does not acquire new authority or stop the publisher when disposed. Capture uses the same transcript sanitizer, compact-renderer observations, active-branch reconstruction, resource projections and expiry behavior as legacy publishing. No raw arguments, results, reasoning or synthetic summaries are introduced. Factory registration and `setMultisession` are resource-free. The coordinator supplies identity, never the legacy snapshot producer.

`setMultisession` is an exact full replacement, **not a patch**. Include only opted-in connected sessions. Remove disconnected/revoked rows immediately (including their identity); use `snapshot: null` for an opted-in row temporarily lacking a projection. Main's matching row uses its actual current local projection, not caller-authored data. Invalid input clears the envelope and fails closed rather than silently showing main's conversation. `undefined` deliberately restores v1. Main must remain in the registry exactly once; instance and session IDs must each be unique. Synchronous collector → coordinator → `setMultisession` feedback is batched without recursive collection or socket backlogs.

## Wire and app model

V1 snapshots remain unchanged, identity-free and capped at **128 KiB**. A separate exact v2 envelope contains:

- `version: 2`, main publisher `streamId`, monotonic `sequence`, current `timestamp`;
- `mainSessionId`, `activeSessionId`;
- `sessions[]`: `{ instanceId, sessionId, name, cwd, isMain, isActive, snapshot }`.

`isActive` is derived from `activeSessionId`; flags inconsistent with the envelope are rejected. Session identity is not copied into nested snapshots. Names and absolute cwd are now deliberately shared at the envelope level and displayed in the editor. Names are bounded to 256 UTF-8 bytes and cwd to 4096 bytes; controls/bidi/format controls are rejected. Up to **65** sessions (main plus 64 destinations) are supported. Each nested snapshot keeps its existing strict allowlist and limits; the complete envelope is bounded to **8.625 MiB** including identity overhead. Unknown fields, duplicate identities, getters, malformed snapshots and recursive envelopes are rejected. Each update is a full bounded frame, never a queue or tool command.

`LiveHudState.multisession` contains **every full session snapshot concurrently**. Its existing `snapshot` property is a derived active display: model/context/agents/todos/history come from the selected conversation, while call visuals, captions and authorized presentation/display scope come exclusively from fresh main-owned state. Source rows remain untouched, including inactive presentations, which are never displayed. Missing/stale selected snapshots yield `null`, never fallback to main. Stale/missing main state clears call visuals, captions and presentation; only main's current verified audio gate and matching run authorize captions. Existing avatar/HUD/transcript/captions/presentation paths use this derived property. The existing private presentation authority and prepared-image channel are unchanged. The editor adds a read-only session list (not full per-session detail panels; full snapshots remain available in state) (main/conversation badges, name/cwd, status/model/context and agent/todo counts), with no voice/session-selection controls and no avatar rewrite.

Socket replay fences use the **main envelope generation and sequence**, not the active session's sequence, so switching conversations cannot retire/revive another conversation's stream. Both producer and app independently expire nested snapshots after five seconds (or reject excessively future clocks). Removal/active changes publish immediately. Socket disconnect/stale clears the entire multisession state; branch/session changes and collector disposal revoke the previous projection. Normal caption/presentation freshness gates remain in force.

## Loading and validation

Updated Pi sources need a later `/reload` and explicit sharing re-enable. Updated Electron main/renderer sources require a later authorized JS build/package and restart; old apps do not understand v2. No native rebuild or camera/audio changes are required. Focused tests exercise projection opt-in/disposal, exact envelope validation/bounds, identity isolation, real data-only socket/client delivery, active-only visuals and revoke/stale clearing. No app, camera, audio device or call is launched by these tests. This is not visual or live-call verification.
