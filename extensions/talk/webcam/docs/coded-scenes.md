# Coded scenes

This is selection among predefined TypeScript environments, **not a scene editor**.
In **Scene → Environment → Scene**, choose `workshop` (**Workshop**,
unchanged default) or `desk` (**Desk setup**), a distinct procedural oak workstation. Reset settings preserves the selected scene/character/aspect. Choose **Robot** (default) or **Hoodie & face** independently under **Character → Model**; both work in either room. See [character selection](hoodie-character.md).

## Factory contract

The desk factory is **`src/avatar/desk-room.ts:createDeskRoom(resources)`**.
It returns **`Environment`** from `src/avatar/environment.ts`:

```ts
interface Environment {
  group: THREE.Group;
  update(config: SceneConfig, time: number): void;
  configureWorld?(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
  ): void;
  dispose?(): void;
}
```

- `group` contains **all environment geometry, lights and light targets**. Do not
  add room objects directly to `scene` in the hook: only the returned group is
  detached on switches. The group is installed before `configureWorld` runs.
- Allocate every geometry/material/texture through the supplied `WorldResources`
  (`geometry`, `material`, `texture`), or use helpers in `avatar/materials.ts`.
  A separate resource owner is created for each installed room in each renderer.
  Outgoing room assets are disposed once on switch; final teardown also releases
  character assets. Never share GPU objects between factories/renderer contexts.
- `update` receives the shared validated config and absolute seconds, not a delta.
  It must honor `roomIntensity` and `warmCoolBalance` for room lighting/materials.
  Use deterministic procedural assets and time-based updates. Do not start RAFs,
  timers, audio, network, IPC, live subscriptions or independent renderers here.
- Optional `dispose` is only for additional non-GPU cleanup. WorldResources owns
  GPU disposal; do not dispose its assets a second time.
- Optional `configureWorld` runs once per installation. Customize scene name,
  background/fog and the **landscape hero** camera position/FOV/target there.
  Do not retain/mutate the camera afterward. World resets background to `#10191c`,
  fog to null, camera position to `[.15, 3.1, 7.85]`, FOV to `37.5`, and target to
  `[.15, 2.63, .1]` before the hook. The scene wrapper then applies portrait framing
  (position/target offset `[-.77, -.38, 0]`, FOV `45`) or the existing explicit
  Follow editor / saved output pose. Those user camera overrides remain intact.
- The selected character is a separate foreground group at `[-.62, 0, .62]`, persistent across room switches (character switches own/dispose only foreground assets); its
  head is around y=2.62. Positive z faces the hero camera; room geometry normally
  belongs behind the robot (negative z). Robot/HUD/live/audio code needs no changes.
- If replacing the workshop lighting, include camera-side robot fill in the desk
  rig. The existing workshop rig/default atmosphere/camera and update formulas
  were moved verbatim into `workshop-environment.ts`; `room.ts` is unchanged.

Desk visual reference:
`/var/folders/p2/500blnnj6k7ct8l9qq1lc6mm0000gp/T/clipboard-2026-10-18-213015-98D761A6.png`.
Natural wood desk; one large landscape monitor left; two smaller landscape
monitors stacked vertically right; open silver laptop center/front; silver Mac mini
left. Robot remains foreground, desk background. The implementation uses rounded
aluminum shells, laptop keys/trackpad/hinge, inset mini ports, a continuous grained
oak slab, steel trestles and routed cables. Simple charcoal surroundings omit the
reference's windows/clutter. Screens reuse deterministic code, logs and meter
animations (four canvases, at most 8 uploads/second each), not live computer data.
Three localized screen pools and a behind-camera spotlight avoid ambient room wash.
Room intensity and warm/cool controls remain supported. Landscape defaults frame
the robot beside the desk; the existing portrait transform remains unchanged.
No workshop, registry, UI, robot or HUD changes are needed.

## Configuration and revision flow

`SceneId` is derived from `SCENE_OPTIONS` in `shared/scene-config.ts`;
`SceneConfig.sceneId` is validated across the existing editor-only `scene:set` IPC.
Missing `sceneId` in legacy configs migrates to `workshop` without changing other
settings. Unknown IDs/types and unknown config fields are rejected. There is no
existing disk/localStorage scene persistence: main retains config across editor
hide/show and output stop/start, but quitting resets it. The validator also accepts
old serialized config snapshots; no new persistence mechanism is introduced.

Both renderers use the same `createScene` → `createWorld` → `createEnvironment`
path. Scene edits use the existing coalesced config/revision broadcast. `setConfig`
swaps the environment synchronously, refreshes hero framing, and preserves explicit
camera overrides. The hidden renderer acknowledges the revision only **after** its
next world/HUD update and render. Room changes do not replace the renderer/window,
selected character, HUD, controls or feeds and do not resize/drain the native output transport
unless the aspect also changes. Older running main-process code cannot gain this
schema through renderer HMR; the UI disables scene selection for such a main.

## Validation

`test/coded-scenes.test.mjs` covers missing-ID migration, JSON roundtrips, invalid
IDs/unknown keys, repeated switching with real procedural worlds and disposal
events, unchanged robot ownership, plus preview/output wrapper framing and
render-before-revision acknowledgement with a fake GPU renderer. No Electron app,
real audio, camera or FaceTime session is launched by these tests. Desk assertions
also cover landscape panel proportions, stacking, computer order, lighting ownership,
zero-intensity screens and GPU disposal.

For fresh hidden GPU captures, run `node test/artifact-checks/run.mjs desk-capture`
from the webcam package. It reuses the existing capture renderer with synthetic HUD
data and writes landscape/portrait, HUD-off/dashboard PNGs to ignored
`artifacts/desk-preview/`. It does not launch the user app or connect audio/camera.
The desk is staged beside the robot to keep all three monitor faces and computers
visible; portrait is tighter at the outer desk edges. Dashboard panels can occlude
the setup, and background text is not guaranteed readable. No live FaceTime or
GPU performance benchmark is implied by these captures.

Desk implementation validation: webcam typecheck passed; focused coded-scene and
terminal tests passed (9/9); hidden GPU capture passed and all four PNGs were
visually inspected after composition iterations. Full webcam suite: 126 passed,
3 failed on the extensionless `live-protocol` import in untouched live-projection
code. Root suite: 968 passed, 1 skipped, 20 failed in untouched bridge integration
(19 undefined `aborted` errors and one metadata-projection assertion). These broader
failures were not repaired as part of the scene work. No user app restart/kill,
real audio/camera activation, packaging, or commit was performed.
