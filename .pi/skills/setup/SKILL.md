---
name: setup
description: Set up or repair this mypi customization layer on a new machine, including Pi/package installation, credentials, dictation, native Talk, and the FaceTime bridge. Use for mypi prerequisites, local builds, app installation, or setup troubleshooting.
---

# Set up mypi

This is an agent-guided workflow, not an installer or background service. Perform only the requested setup/repair; inspect existing state and skip working components. Do not run the full workflow for a request to rebuild one component.

## Locate and plan

Resolve this skill's directory first. The **repository root is `../../..` relative to this directory**, regardless of the user's current working directory. Run repository commands there, with quoted absolute paths. Read the repository `README.md`, `package.json`, `.env.example`, and the relevant feature docs before changing setup. Never print `.env`, Pi auth files, tokens, or complete private caller lists.

If the scope is unclear, ask which features the user wants. Core extensions work without audio tooling. Explain missing prerequisites before installation. Ask before installing/updating global software, changing existing secrets/allowlists, replacing an app, or stopping a running component. Do not silently upgrade Pi, change the default Rust toolchain, enable project trust, grant privacy access, or open applications. Keep the user's existing configuration and working installations intact.

## 1. Base package

Inspect Node/npm, Git, `pi` on PATH, platform/architecture, and existing Pi package registration. Node must meet Pi's installed requirement (currently >=22.19.0). Subagents and Talk summaries invoke the `pi` executable, not a separate worker installation.

If missing, offer the normal Node/Pi installation for the user's environment. With approval, the npm Pi package is `@earendil-works/pi-coding-agent`. Homebrew is optional; do not install it implicitly.

From the repository root:

```sh
npm ci
pi install .
```

The local package is registered in Pi's user settings; do not duplicate it with ad-hoc extension paths. Its manifest includes this skill so it is usable from other projects. Ask the user to `/reload` after resource changes. From an unregistered checkout the trusted project `.pi/skills/setup` is discoverable; `pi --skill /absolute/path/to/mypi/.pi/skills/setup` can load it explicitly if needed.

Questions, todos, dashboard, context viewer, nested instructions/skills, and subagents need no native builds. MCP servers need their own project-declared executables/services/credentials and explicit approvals; do not auto-install or approve arbitrary `.mcp.json` entries.

## 2. Credentials and web tools

- Have the user sign into their providers via Pi's `/login`. Codex-backed search, images, usage, dictation, and Talk specifically use `openai-codex`; do not substitute another provider's token.
- Where supported, inspect readiness with `pi auth check --provider openai-codex --json`. Never use credential-printing commands or `--credentials`.
- For scraping, create the repository `.env` from `.env.example` **only if absent**. Have the user supply `FIRECRAWL_API_KEY` privately; optional `FIRECRAWL_API_URL` supports self-hosting. Do not overwrite existing keys or commit secrets. Keep this file owner-only.
- Codex image/voice endpoints are experimental and account-dependent. A successful login does not prove feature access. No speculative endpoint/model probes are part of setup. Live requests can consume usage; ask before running them, and use the actual extension tools rather than standalone probe scripts.

## 3. Dictation (optional)

Install **SoX** (`rec`) if wanted; with approval on a Homebrew machine: `brew install sox`. Ask the user to grant microphone access to the terminal/app hosting Pi through macOS settings. Hold-Space needs Kitty keyboard protocol with key-release reporting (e.g. Ghostty or Kitty); `/dictate` is the manual toggle when unavailable. CMUX is not required.

## 4. Native Talk (optional, macOS)

Read and follow [references/native-talk.md](references/native-talk.md). It covers pinned Rust, installed static Opus, the locked release build, and the architecture-specific helper destination. No build happens automatically at runtime. Talk needs its normal microphone permission, but not SoX.

## 5. FaceTime bridge (optional, macOS)

Read and follow [references/facetime-app.md](references/facetime-app.md) before building or replacing the app. Its fixed app metadata lives with the Swift project in [extensions/talk/facetime/Info.plist](../../../extensions/talk/facetime/Info.plist). Swift 6/macOS SDK, FaceTime sign-in, and the GPLv3 [Pi Talk driver](../../../extensions/talk/macos-audio-driver/README.md) are required. Build/install the driver only with user approval; installation restarts Core Audio. It provides visible `Pi Talk` and hidden `Pi Talk Internal` at fixed UIDs. Never persist numeric AudioDeviceIDs or assume they transfer between Macs.

Use `/talk devices` in Pi to select physical microphone/output devices only. Virtual routing is hardcoded; `/talk devices diagnostics` resolves its UIDs and briefly opens silent duplex streams (capture is discarded). Ask before that live probe. The only active Talk/FaceTime settings file is `<getAgentDir()>/talk.json` (default `~/.pi/agent/talk.json`), owner-only `0600`. Read `extensions/talk/CONFIG.md` in the repository for schema/migration. Preserve existing allowlists, aliases, timeouts, and selections; ask for explicit caller/recipient identities before authorizing any new ones. Do not erase malformed policy or recreate it with permissive defaults. Do not create a second FaceTime config.

Swift selects visible `Pi Talk` for both FaceTime microphone and output; the native helper resolves hidden `Pi Talk Internal` for both directions with no physical fallback. Schema v2 requires the exact fixed visible/internal UIDs; outgoing calls require exactly one configured owner in `allowedRecipients`, never a model-selected target. For custom agent directories the GUI may not inherit the terminal environment: choose the exact config in the app menu and Stop/Start. The app stores only that file's location, not another settings copy.

Explain manual Accessibility approval for **Pi Talk**, not CMUX/Terminal as a workaround. Do not manipulate TCC, request screen recording, auto-launch a LaunchAgent, or open permission dialogs without the user's action. Ad-hoc rebuilds can invalidate a visibly enabled permission: quit, remove/re-add the installed app in Accessibility, reopen, then Start service.

## 6. Verify and hand off

From the repository root:

```sh
npm run check
npm test
```

After Swift changes, also run `swift test --package-path extensions/talk/facetime`. Tests use synthetic state, not live calls. Verify generated Mach-O architecture and the installed app's plist/signature when built; signing success alone does not establish Accessibility trust.

With explicit user approval, open `~/Applications/Pi Talk.app` through LaunchServices (never its executable) and FaceTime. Verify live bridge status reports trusted Accessibility, the expected config path, and visible `Pi Talk` in both directions. When FaceTime omits its sole/default microphone menu, require the exact visible Core Audio UID as independently verified by the bridge. `/talk facetime` enables standby only when requested; it does not launch the app. Do not place/answer/hang up calls merely to verify setup, and never automatically replay a call mutation.

Report what was installed/built, which features remain unconfigured, any account/permission blockers, and the next manual step. Do not claim a feature works merely because its dependencies compiled.

## Kept diagnostics

Only `scripts/talk-monitor.mjs` and `scripts/talk-context.jq` remain as standalone helpers. Use the monitor for opt-in Talk JSONL traces or the jq filter when requested; neither is required to run mypi. Logs contain private conversation text. Tracing and jq installation are optional, and no trace should be enabled by setup without consent.
