---
name: setup
description: Set up or repair this mypi customization layer on a new machine, including Pi/package installation, credentials, web tools, and optional dictation. Use for mypi prerequisites, installation, or setup troubleshooting.
---

# Set up mypi

This is an agent-guided workflow, not an installer or background service. Perform only the requested setup/repair; inspect existing state and skip working components. Do not run the full workflow for a request to rebuild one component.

## Locate and plan

Resolve this skill's directory first. The **repository root is `../../..` relative to this directory**, regardless of the user's current working directory. Run repository commands there, with quoted absolute paths. Read the repository `README.md`, `package.json`, `.env.example`, and the relevant feature docs before changing setup. Never print `.env`, Pi auth files, or tokens.

If the scope is unclear, ask which features the user wants. Core extensions work without audio tooling. Explain missing prerequisites before installation. Ask before installing/updating global software, changing existing secrets, or stopping a running component. Do not silently upgrade Pi, enable project trust, grant privacy access, or open applications. Keep the user's existing configuration and working installations intact.

## 1. Base package

Inspect Node/npm, Git, `pi` on PATH, platform/architecture, and existing Pi package registration. Node must meet Pi's installed requirement (currently >=22.19.0). Subagents invoke the `pi` executable, not a separate worker installation.

If missing, offer the normal Node/Pi installation for the user's environment. With approval, the npm Pi package is `@earendil-works/pi-coding-agent`. Homebrew is optional; do not install it implicitly.

From the repository root:

```sh
npm ci
pi install .
```

The local package is registered in Pi's user settings; do not duplicate it with ad-hoc extension paths. Its manifest includes this skill so it is usable from other projects. Ask the user to `/reload` after resource changes. From an unregistered checkout the trusted project `.pi/skills/setup` is discoverable; `pi --skill /absolute/path/to/mypi/.pi/skills/setup` can load it explicitly if needed.

Questions, todos, dashboard, context viewer, nested instructions/skills, and subagents need no native builds. MCP servers need their own project-declared executables/services/credentials and explicit approvals; do not auto-install or approve arbitrary `.mcp.json` entries.

## 2. Credentials and web tools

- Have the user sign into their providers via Pi's `/login`. Codex-backed search, images, usage, and dictation specifically use `openai-codex`; do not substitute another provider's token.
- Where supported, inspect readiness with `pi auth check --provider openai-codex --json`. Never use credential-printing commands or `--credentials`.
- For scraping, create the repository `.env` from `.env.example` **only if absent**. Have the user supply `FIRECRAWL_API_KEY` privately; optional `FIRECRAWL_API_URL` supports self-hosting. Do not overwrite existing keys or commit secrets. Keep this file owner-only.
- Codex image/voice endpoints are experimental and account-dependent. A successful login does not prove feature access. No speculative endpoint/model probes are part of setup. Live requests can consume usage; ask before running them, and use the actual extension tools rather than standalone probe scripts.

## 3. Dictation (optional)

Install **SoX** (`rec`) if wanted; with approval on a Homebrew machine: `brew install sox`. Ask the user to grant microphone access to the terminal/app hosting Pi through macOS settings. Hold-Space needs Kitty keyboard protocol with key-release reporting (e.g. Ghostty or Kitty); dictation has no slash-command fallback. CMUX is not required.

## 4. Verify and hand off

From the repository root:

```sh
npm run check
npm test
```

Report what was installed, which features remain unconfigured, any account/permission blockers, and the next manual step. Do not claim a feature works merely because its dependencies installed.
