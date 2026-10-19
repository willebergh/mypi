# Imported verification evidence

Historical snapshots copied byte-for-byte from `../pi-talk-webcam/artifacts/` during the webcam import. These document original runs, not validation of this checkout. Source project files were not modified.

Preserved groups:

- `hud-preview/`: HUD layouts, opening/closing/eye transitions and assertion JSON.
- `speech-mouth/`: synthetic mouth fixtures and checks; not live audio.
- `milestone3a-development/`, `milestone3a-packaged/`: camera UI and existing renderer/native verification; not proof of installation or activation.
- `milestone4-development/`, `milestone4-packaged/`: scene/editor/output/native captures and verification.
- `dual-view/`: doc-linked output-monitor screenshots and checks.

Preserved root reports: `verification.json`, `development-verification.json`, `development-verification-initial.json`, `packaged-verification.json`, `metal-validation-verification.json`, and `aspect-resize-smoke.json`. Root native images: `native-metal-1.png`, `native-metal-2.png`.

Report contents are unchanged, including any historical paths/environment details. Relative artifact filenames inside JSON describe the original run; they are not instructions to write here.

Omitted: logs, raw signing outputs (`personal-team-signing/`), transient failed/debug runs, generated bundles/preloads and duplicate compiled helpers. The historical [Personal Team result](../../native/macos/camera/PERSONAL_TEAM_RESULTS.md) is retained as prose, without its raw signing evidence.

Runnable source helpers and build-only instructions are in [test/artifact-checks](../../test/artifact-checks/README.md). New verification and helper runs **still write to ignored `artifacts/`**, not this evidence directory. Native `vc4m/results/` references are separate historical reports, not part of this artifact-source import.
