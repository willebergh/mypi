# Holographic Pi telemetry HUD

## Current live connection

The app now defaults to **Live**, receiving a validated, read-only Pi projection over `<Pi agent directory>/webcam/hud.sock`. Enable it with `/talk webcam on`, or `/talk facetime` to also open/reuse the prebuilt app. See the [current integration guide](../README.md#live-pi-integration). Demo is explicitly selectable; a disconnected/stale live feed clears real data and never falls back to mock activity.

The same snapshot drives preview and hidden output. Live panels show model/context, active-only subagent labels/model names/context (no task text), todo text/progress, full-background weekly usage, authoritative structured Talk state, and **bounded visible conversation plus compact tool previews**. Public text is shared only after explicit sharing start. The wire still contains consented subagent task text. **Displayed conversation, tool previews and task/todo fields can expose sensitive project content in the live camera output.** Common credential redaction is best-effort, not arbitrary/perfect secret detection. Reasoning, raw tool arguments/results, raw provider errors, separate file lists/cwd/session-name fields and authentication are not forwarded. Public display text may itself contain paths, snippets and error text. Unknown metrics remain unavailable/null. The robot resets readiness between voice attempts and never treats a listening label as proof of connected FaceTime audio.

### Main-agent Activity card

- Stack in both orientations: compact Weekly → unlabeled Session/context → compact Activity. Activity follows **Session** visibility, with no new scene/config/UI fields. The existing status/timer **header is unchanged**. Subagent visibility/count does not control Activity. Todos, weekly background fill, session/context, panel caps/layout/toggles and all subagent animations/outcome retention remain intact.
- Actual public user/assistant text and visible `talk-history` bodies populate Activity. Talk must have the exact current `[talk:user]\nbody` or `[talk:assistant]\nbody` shape, from a string or text blocks only; its bracketed header is removed and speaker maps to an internal styling role. Legacy/XML and unsupported shapes are omitted. Other custom types are omitted: arbitrary `display: true` raw content need not match a custom renderer, which may hide a large underlying outcome. Roles are internal styling hints only: no role/type/time prefixes, timestamp/event metadata rows or generic assistant-finished/tool-completed placeholders are displayed. Nothing is fabricated from legacy metadata events. Paragraphs/blank lines and code indentation survive wrapping; tabs display as four spaces. The available Activity height retains the chronological recent tail, including the tail of a long block. No scrolling or DOM console. Empty/offline/stale is explicit; Demo is never a fallback.
- History reconstruction uses compaction-aware `buildContextEntries` when available, with a compaction-aware active-branch fallback. Only the active main branch is reconstructed on initialization/tree navigation; abandoned branches and nested/subagent history are excluded. Finalized message reconciliation reads persisted history at suitable post-message lifecycle boundaries or heartbeat, allowing later message handlers to finish transforming messages first. Navigation replaces the tail and rotates its opaque branch epoch. Session replacement/shutdown/off clears state. Existing freshness and generation fences are unchanged; raw message/result objects never reach Electron.
- The installed Pi **1.3.0** host supports public `registerToolRenderer`; the pinned development SDK **0.87.1** lacks it. The integration feature-detects the API without importing newer runtime symbols; hosts without it omit tool previews honestly. Capture decorates the effective returned component's actual compact `render(width)` output only **after sharing starts**, without a second render/copy or replay. Previously rendered tools require a normal renderer invocation after enable; enabling does not render them again. The public renderer context cannot distinguish matching compact HTML export renders from terminal rendering: a matching active-tool export can also update its preview. Expanded output is excluded. Native bash/powershell output tails, edit diffs and read/write previews are captured as Pi normally chooses to show them. A successful compact read often has **only a header/path**, not the full file body. Missing effective renderers, unrendered tools and expanded-only output are omitted. Raw arguments/results never supply a fallback preview. Captured public text is sanitized, bounded and best-effort credential-redacted before publication; this is not perfect secret detection. Stripping/redaction processes the entire input before clipping. Conversation/live/finalized prose keeps the newest UTF-8-safe tail, preserving paragraph breaks and indentation; combined tool blocks retain a bounded call-title prefix plus the recent result tail. No lifecycle text is invented.
- The additive v1 field is `transcript?: LiveHudTranscriptBlock[]`, with exact blocks `{ id: string, role: 'user'|'assistant'|'tool'|'custom', text: string }`. IDs are opaque `/^[a-zA-Z0-9_-]{1,128}$/`. Exported limits are `LIVE_HUD_MAX_TRANSCRIPT_BLOCKS = 10`, `LIVE_HUD_MAX_TRANSCRIPT_TEXT = 2048` UTF-8 bytes per block and `LIVE_HUD_MAX_TRANSCRIPT_BYTES = 32768` summed text bytes (currently further constrained by the other two caps). Text must contain non-whitespace content; newline/tab and valid astral characters are allowed, while other controls, Unicode format controls (including bidi), isolated UTF-16 surrogates and ANSI/OSC escapes are rejected. Exact validation rejects unknown keys, malformed IDs/roles, duplicates and byte overflow. The HUD projector explicitly copies only id/role/text. Existing version/events/todoCounts compatibility is retained; absent transcript is honest empty Activity, not event-derived text.
- One snapshot per update, ≤4 Hz raster cadence, the fifth quad and existing opening/closing/reflow rules remain unchanged. Preview and hidden camera output use the same safe DTO and rendering path. Explicit Demo adapts authored fixture text to transcript blocks; it does not claim live tool execution.
- **Later loading required:** Pi `/reload` and re-enable `/talk webcam on`; explicitly rebuild/package and restart Electron for its updated JS/validator. Renderer HMR alone cannot update main-process validation. No native/config changes are needed. Old validators reject the new transcript field; update both sides. No tests, checks, typechecks, builds/rebuilds, app launches/restarts or live probes were executed. Source tests are unexecuted.

The remaining sections preserve the original demo's design and historical evidence; authored conversation summaries and timer-driven preflight there are **demo-only**, not the live activity adapter.

## Look / controls

The shared Three.js renderer now draws a camera-locked cyan/amber holographic interface after the world pass. It is **burned into hidden output and PNG captures**, not a React-only overlay. Dashboard now uses five panels: compact **Weekly budget**, unlabeled **Session / main context**, **Activity** directly beneath Session, **Subagents** with per-agent context-window progress bars, and **Todos**. **Show HUD** is on (Dashboard) or off; legacy `minimal` configs are accepted but canonicalized/rendered as Dashboard. Duplicate metadata and the decorative full-screen frame have been removed. Old perspective labels, camera corner marks, targeting brackets and the center reticle have been removed. The robot's eyes remain unobstructed in both 16:9 and 9:16.

Under **Overlay → HUD display** in the inspector:
- **Show HUD** checkbox (Dashboard / nothing)
- Hologram intensity
- Independent visibility checkboxes: Session (context and Activity), Subagents, Todos, Weekly limit
- **HUD whitespace**: independent **Landscape** and **Portrait** profiles, each with top/right/bottom/left padding (0–15% of output dimensions). The controls automatically edit the current orientation; **Reset this profile** does not change the other orientation. Padding translates anchors and reflows available panel widths like a website; it never scales the HUD or typography. Portrait text is rerasterized at its normal pixel size when its container narrows. Spacing changes preserve opening clocks. Large custom padding can deliberately place panels over the character.

### Interactive Demo fixtures (source-only)

**Overlay → Telemetry → Demo** enables **Demo / not live Pi data**. `shared/demo-hud.ts` is a pure, bounded model/reducer and strict version-1 action parser; `main/demo-hud.ts` owns fixtures and a single three-second terminal-expiry timer. Editor-only main-frame-checked `live-hud:demo-update` accepts only fixed enums/booleans/bounded numeric IDs and percentages—no arbitrary text, arrays, images, private/live snapshot fields or executable commands. Arrays are authored/capped at 12 agents and 48 todos; all text is fixed fictional fixture text. `LiveHudState.demo` travels through the existing getter/broadcast/preload/shared subscription and `projectLiveHud`/`mockHudSnapshot`, not a renderer-only fake or second live authority. Live protocol validation and subscription/session/retarget/disconnect fences are unchanged.

Main/agent context percentages match tokens in a fixed 128k window; weekly percentages sum to 100. Add/remove/empty/move-up agents, choose active status, Complete/Reopen, and add/complete/reopen/remove/empty todos. Main publishes authoritative terminal status/`endedAt` before bounded three-second removal; the existing renderer handles pulse/fade, not disappearance-as-success. Reopen uses a fresh numeric identity/`startedAt`. Reset restores three agents/six todos with fresh IDs/generation. Full todo counts reflect the actual array; ascending IDs, pending-first selection, at most one completed display row and existing HUD caps remain. No fabricated todo in-progress fields. Demo offline is explicit and does not alter the real feed. No timer randomizes telemetry or overrides choices; the deadline timer cancels in Live and on quit. Existing mock boot stays labeled/mock/audio-off; real spectrum/mouth/Talk/captions/presentations are unchanged.

UI/styles and HUD mode normalization can HMR; **shared Demo controls require later loading of updated main and preload** (and a later JS package build for packaged copies). UI requires both the new API and versioned main snapshot before enabling controls; older backends show **Backend restart required**, with no optimistic local application. No tests/checks/builds/rebuilds/restarts/apps/calls/probes/provider requests were run; test source is prepared only. Historical captures below do not validate this feature.

The top-right **DEMO / MOCK / NO LIVE CONNECTION** bar has been removed as requested. The settings retain the mock-data disclosure. Off closes all floating panels, then removes the HUD entirely, but does not disable the robot's physical boot display. No chat-input control is simulated.

The initial render can hot-reload with existing backends using demo defaults. **Restart Electron once to enable the new shared HUD settings**; old backend detection disables only the unsupported controls instead of sending unknown config fields. Main-process code does not hot-reload just because Vite updates the preview.

## Historical prototype research — `mypi` READ ONLY

The dashboard below the input editor is:

`/Volumes/Samsung T5/development/mypi/extensions/resource-status/index.ts`

It installs `mypi-resource-status` via `ctx.ui.setWidget(..., { placement: "belowEditor" })`. Supporting sources reviewed:

- `resource-status/protocol.ts`, `core.ts`, `context-bar.ts`
- `subagents/core.ts` (state/usage/status transitions)
- `todos/core.ts`
- `openai-usage/core.ts`

Pi's installed extension/TUI/session-format/message-type docs and the widget-placement example were also reviewed. A small structural sample from three recent **mypi** session JSONL files was inspected: entry/role/content-block types, tool names, usage field names and metadata only. No raw prompts, thinking text, tool arguments/results or message bodies were copied into the prototype. No `.env`, tokens, credentials or private keys were read. No command, build, test or source mutation was performed in `mypi`; its existing unrelated working-tree changes were left alone.

## Historical source shapes → mock render DTO

`src/shared/hud-data.ts` contains authored synthetic fixtures, not real current-session readings. Nothing in the renderer opens a file, accesses a provider account, watches Pi sessions or connects to a socket.

| HUD data | Actual source / important semantics |
| --- | --- |
| Main context | `ctx.getContextUsage()` → `{ tokens: number|null, contextWindow, percent: number|null }`; model context-window fallback. Unavailable values are not zero and are not guessed. |
| Session runtime | Elapsed wall time since `session_start`, **not** model execution time. |
| Output rate | `OutputTokenRate.value`, optional output tokens/sec, may retain a last measured value. |
| Subagents | `{ id,label,task,cwd,status,activity,startedAt?,endedAt?,turns,usage,model?,tokensPerSecond?,contextTokens,contextWindow?,agentFiles,loadedSkills,todosCompleted,todosTotal }`. Seven states: queued/starting/thinking/running/completed/failed/aborted. |
| Child context | Usage-derived/observed totals; not guaranteed to be an exact live context measurement. Do not label this as a precise token partition. |
| Todos | `{ items: [{id,text,completed,completedAt?}], nextId }`, not fictional task status enums or inferred completion percentages. |
| Usage windows | `OpenAiUsageState` inactive/loading/error/ready. Ready snapshot may have primary/secondary windows, each with optional used/remaining percent, reset time/countdown and window duration. Provider-specific, not a universal request-count quota. |
| Session identity | Pi supplies session name/model/cwd. Git branch/repository information is **not** supplied by this widget; the example branch is explicitly synthetic. |
| Event digest | A normalized UI projection, not an existing dashboard wire format. Actual JSONL entries form a tree with `id/parentId`, ISO entry timestamps and structured message roles/content. Display time here is normalized to Unix milliseconds. Summaries shown are authored mock text. |

Usage `resetAt` is Unix **seconds**, while snapshot `updatedAt`, subagent timestamps and message/runtime timestamps use **milliseconds**. `resetAfterSeconds` is a duration. Actual session entry timestamps are ISO strings, so an eventual adapter must normalize them. Current mock data uses a deliberately fixed demo epoch.

The useful event channels for a later adapter are `mypi:subagents-changed` (`{states}`), `mypi:todos-changed` (`{state}`), and `mypi:openai-usage-changed` (usage state). Main context comes from the extension context API. No event bridge has been installed or connected in this pass.

A future history adapter must follow the **active session branch**, not flatten abandoned branches. Use allowlisted metadata and opt-in/redacted summaries rather than exposing tool bodies, prompt contents, or private reasoning. Do not manufacture system/files/conversation context partitions, GPU percentages, battery/GPS values or raw request quotas that Pi does not provide.

## Historical Talk / FaceTime pre-answer trace (read-only)

A second Luna source trace reviewed `mypi/extensions/talk/{index,facetime-mode,codex,native-peer,facetime-client}.ts` and the status protocol. No Talk/FaceTime process, device operation, call, credential lookup or API request was executed.

Before a call, enabling FaceTime mode validates the managed audio profile/recipient, obtains a controller lease, connects/reconciles the service and verifies routing before entering standby. Only an explicit `call.incoming` event with `allowed === true` can initiate answering; snapshots alone are not authorization.

For an allowed incoming call, `facetime-mode.ts` `incoming()`/`prepare()` orders:

1. Claim the call and publish `preparing`.
2. Prepare the Pi voice session; read settings/credential in the **real extension**, summarize conversation context (summary failure is nonfatal).
3. Start the native peer with both audio directions gated off.
4. Create a WebRTC offer; connect to Codex voice.
5. Apply its SDP answer and wait for WebRTC readiness.
6. Voice is ready but remains audio-gated; recheck the same incoming call is still allowed.
7. Publish `answering` and submit the answer request.
8. Only a verified `call.connected` for the owned call permits audio. An answer request succeeding does not prove connection.

Useful source anchors: `facetime-mode.ts:223–301,376–389`; `index.ts:275–324,403–446,607–658`; `codex.ts:134–221`; `native-peer.ts:244–251,284–291,360–366` (line references at inspection time).

Existing `mypi:talk-status-changed` payload is `{state: idle|connecting|listening|closing, mode?: facetime, detail?: string, elapsedMs?: number}`. Fine progress is **detail text**, not a structured stage enum. `FaceTimeStatus.phase` is a separate string field; active Talk status can mask that FaceTime phase. In particular, Talk `listening` does not necessarily mean FaceTime is connected or its audio gate is open.

`HudTalkPreflight` is a new mock-only presentation projection, not a wire protocol. It now runs **once per renderer startup**, reaching readiness after approximately 14.4 seconds, rather than looping. The nine checkpoints are shown directly on the robot's **curved CRT face**, replacing the eyes while loading: current step, segmented progress and GPU circuit animation, labeled **MOCK / BOOT** and **AUDIO OFF / NO ANSWER**. It is no longer in Session.

At readiness, the boot display clears and the eyelids open from fully closed over 0.9 seconds with phosphor warmup, then resume normal idle blinking. The opening still runs with Idle intensity zero. Toggling a HUD panel does not restart the robot boot. This visual awakening does **not** imply an actual answered/connected call: answer submission and audio remain false in the mock. No live adapter or FaceTime action was added.

## Implementation / cost

- `src/avatar/hud.ts`: standalone HUD scene and orthographic camera; canonical layouts for 1280×720 and 720×1280.
- `src/avatar/scene.ts`: world render, depth clear, HUD render. Both preview and hidden output use this same path, including explicit PNG capture. Draw statistics count both passes.
- At most five unlit HUD draws, fewer when panels are unchecked. The physical boot display is part of the existing CRT material, not another overlay draw. No extra lights, shadows or framebuffer/postprocessing pipeline.
- Opening uses a 1.08-second GPU shader sequence per panel with 120 ms stagger: ignition line → perimeter tracing heads → unfolding glass → content scan. Fixed-size quads keep text unsquashed. Per-frame changes are uniforms; panel-sized data textures refresh at most 4 Hz. Each panel has its own opening clock. Showing one panel creates/animates only that panel; existing meshes, materials and clocks are retained. Hiding a panel plays a **0.62-second reverse sequence**: content retracts, glass collapses, the traced frame returns to an ignition line and disappears. The closing card's mesh/texture stays alive until its exit finishes. Other panels keep their animation phases; anchors and new additions wait until exits finish to avoid overlap. Rapid toggles reverse from the current shader phase without jumping or duplicating a card. HUD re-enabling, mode or orientation changes may replay the full layout; opacity and padding do not. No camera pixel readback is used for the animation.
- `src/avatar/robot-preflight.ts`: 512×288 text mask, uploaded only on stage changes and at most 4 Hz; scan/progress motion is shader-only. Resources register with the existing world resource owner.
- `scene.ts` composites according to `hud.scene.visible`, not the requested mode, so Off still renders its exit frames. No extra config fields or backend restart are needed for closing.
- Geometry, materials and textures dispose with their renderer context. HUD mode changes do not restart the world/output window.

## Historical validation / screenshots (not rerun for live Activity)

`pnpm typecheck` passed. A focused **hidden** Electron capture check rendered the actual shared scene/HUD in six configurations, intermediate panel opening frames, and the robot's eye transition. Representative images were opened and visually inspected. A GLSL reserved identifier discovered by capture was corrected and the check rerun cleanly. The existing dev server was not stopped and no full regression/build suite was run:

- `evidence/hud-preview/landscape-dashboard.png`
- `evidence/hud-preview/portrait-dashboard.png`
- `evidence/hud-preview/portrait-minimal.png`
- `evidence/hud-preview/landscape-selected-inset.png` (two panels hidden; asymmetric whitespace)
- `evidence/hud-preview/landscape-off.png` (no floating HUD)
- `evidence/hud-preview/portrait-padded.png` (independent portrait padding, normal-size text)
- `evidence/hud-preview/eyes-opening.png`, `eyes-ready.png` (closed-to-open transition)
- `evidence/hud-preview/single-panel-opening.png` (new Todo trace while others remain open)
- `evidence/hud-preview/focused-checks.json`: asserts retained panel object/clock identity, new panel opening, no padding scale and portrait profile selection.
- `evidence/hud-preview/landscape-opening.png`, `landscape-unfolding.png` (actual intermediate shader frames)

Closing follow-up: typecheck and `../test/artifact-checks/hud-close-check.ts` (see [runner instructions](../test/artifact-checks/README.md)) passed assertions for per-panel closing, unrelated panel stability, continuous reversal, disposal, and Off→On. Actual intermediate images are `panel-closing.png`, `hud-closing.png`, and `hud-closed.png` in the same preserved `evidence/hud-preview/` directory. The capture emitted one Chromium Skia mailbox diagnostic, but no renderer/shader errors; all three images were inspected successfully.

This validates composition/readability and the shared GPU render pass, not a live Pi data connection or a new full Metal/performance benchmark. The existing native Metal pipeline was not changed. Dense portrait text is intended for the full-resolution output and becomes small in the fitted editor preview.

## Ownership

- Luna researched `mypi` and the relevant harness history **read-only**, identified the actual DTOs and availability semantics.
- Astra designed and built the holographic layer from the two supplied inspiration images.
- Lead wired shared config/controls/compositing, authored schema-aligned mock data, corrected reset-time units and plane-sidedness, and captured/inspected both orientations.
