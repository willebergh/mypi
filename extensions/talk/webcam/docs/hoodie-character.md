# Character selection: Robot / Hoodie & face

`src/avatar/hoodie-character.ts` exports:

```ts
createHoodieCharacter(resources: WorldResources, config: SceneConfig,
  getTalk: (time: number) => HudTalkPreflight): Robot
// Robot = { group: THREE.Group; update(config, time, audio?: SpeechAudioFrame): void }
```

In **Appearance → Display & expression → Character**, choose **Robot** (`robot`, unchanged default) or **Hoodie & face** (`hoodie`). Either character works independently in Workshop and Desk setup. Changing character preserves the selected room, aspect, camera pose, HUD and appearance controls; Reset look preserves character, room and aspect. Casing tint/wear remain stored but affect only Robot.

`shared/scene-config.ts` defines typed `CharacterId`/`CHARACTER_OPTIONS`. Missing `characterId` in older configs migrates to `robot` without resetting other controls; explicit invalid IDs/types and unknown fields are rejected. Both editor preview and hidden output receive the existing coalesced config/revision IPC, with output acknowledgement after update/render. An older running main process cannot learn the schema through renderer HMR: its selector/Reset look stay disabled with an update notice. No new persistence is added (main retains settings until quit).

`world.ts` owns a separate `WorldResources` for the installed character, places the origin-based hoodie at the original hero position `[-.62, 0, .62]`, and removes/disposes outgoing character assets once. Room resources, camera, renderer, HUD, captions, presentations and feeds are not replaced. Both factories receive the same advancing absolute time, structured readiness projection and optional numerical speech frame; selection does not open audio or change voice authorization. Each newly installed face starts its own readiness warmup. `scene.ts` swaps characters synchronously on config edits without reframing/resizing; its next frame updates animation before acknowledging the revision.

The group starts at the origin (caller controls placement), with a roughly 3.7-unit-high hood/garment silhouette: closed pullover, draped fabric sleeves with closed cuffs/no hands, pouch, drawstrings, sewn hood and dark lining around a recessed animated face. There is no monitor casing, exposed mechanical torso, neck, arms, chassis, service hardware or metal trim. This is procedural geometry, not a cloth simulation or skinned rig; overlapping fabric shells approximate sewn garment joins.

- Call `update` with advancing seconds, including when `idleIntensity` is zero.
- `getTalk` is the existing structured render-only readiness projection; it does not authorize answers or open audio. Stops, new generations and rewinds reset eye warmup.
- Optional audio is numerical input only: 12 supplied spectrum bins, fresh Unix-ms timestamp, RMS/peak gates, clamping, frame-rate-independent attack/release. Missing/stale/silent input releases to a quiet dotted mouth. The factory never accesses devices.
- `hoodieColor`, eye controls and `idleIntensity` apply. Casing, environment, HUD and aspect controls do not affect this asset.
- The caller owns `WorldResources`; dispose it after removing the character. Nothing GPU-backed is shared between instances.

`animated-face.ts` is a focused extraction of the original robot's surface builder, curved screen/shader and face animation. `createRobot` retains its original geometry, material settings, garment, hardware, placement and pose formulas. A pre-extraction fingerprint test covers mesh buffers, shaders, appearance and animated uniforms/transforms across boot, readiness, speech, blink, still, generation change, stop and rewind.

## Checks / isolated preview

From `extensions/talk/webcam`:

```sh
node --test test/coded-scenes.test.mjs test/hoodie-character.test.mjs
node test/artifact-checks/hoodie-capture.mjs --build-only
node test/artifact-checks/hoodie-capture.mjs
node test/artifact-checks/run.mjs character-capture
pnpm typecheck
```

The opt-in capture runs a **separate hidden Electron fixture**, never the application entry or active scenes. It denies permissions, imports no feed/preload/native adapter, and uses synthetic readiness/audio numbers. Separate fixture user data, no single-instance lock, no running-app restarts, no camera publication or audio capture. Front, three-quarter, back, boot, blink and mouth captures plus GPU errors/draw metrics go to ignored `artifacts/hoodie-preview/`. Its neutral fixture lighting is not a scene integration/framing check.

## Selection integration validation

The focused coded-scene + character tests pass **12/12**, including ID migration/roundtrips, invalid values, repeated switches in both rooms, disposal events, camera/control preservation, preview/output render-before-ack ordering and the unchanged robot fingerprint. Asset tests cover readiness, generation/stop/rewind, blink, stillness and fresh/stale/silent synthetic mouth input.

`character-capture` reuses the shared hidden scene renderer and hot-switches both characters across both rooms in landscape/portrait, with mock ready telemetry and synthetic speech only. It denies permissions, uses separate fixture user data, imports no app main/preload/native adapters and never restarts/kills user apps. Eight PNGs and `capture.json` go to ignored `artifacts/character-preview/`; this run passed without console/shader errors and all eight images were visually inspected. Default dark fabric remains deliberately low-contrast in the existing lighting; portrait is tighter at the desk edges. This is not an interactive UI, live-call or leak/performance benchmark.

Full webcam suite initially reported **139 passed, 5 failed**: four existing extensionless `live-protocol` import failures (live-captions, live-hud-render, live-pipeline, live-projection), plus the existing one-rack LED expectation (416 actual vs 208 expected). A final rerun during concurrent presentation work reported **132 passed, 12 failed**: those same five plus seven untouched `live-main.test.mjs` failures resolving `../shared/presentation-protocol`. The focused wrapper test now loads that protocol module for compatibility with the concurrent scene import; focused tests still pass 12/12. Webcam typecheck remains blocked by four existing diagnostics: `shared/live-projection.ts:51` and `shared/presentation-assets.ts:125,159`. Root `npm run check` also remains blocked by unrelated captions, presentation type, bridge event API and transcript test diagnostics, plus presentation-assets. Those files were left untouched. No packaged build, real audio, camera or FaceTime validation was performed.
