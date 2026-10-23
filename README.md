# mypi

Personal [Pi](https://pi.dev) extensions.

## Extensions

For whole-machine setup—including Node, Pi, credentials, Firecrawl, and optional SoX dictation—use [`/skill:setup`](.pi/skills/setup/SKILL.md) in Pi after trusting this repository and reloading the package.

### Web

Provides provider-neutral web tools backed by dedicated integrations:

- `web_search` searches the live web through OpenAI's hosted Responses web-search tool and returns a concise answer with clickable inline citations. It uses Pi's existing `openai-codex` login and currently runs `gpt-6-luna`; no separate API key or login is needed.
- `web_scrape` uses Firecrawl to fetch the main content of one known HTTP(S) URL as Markdown.

The provider implementations live under `extensions/web/providers/`, so Firecrawl, Brave, Exa, or other backends can be added without changing the model-facing tool names.

Copy `.env.example` to `.env` in this package and add `FIRECRAWL_API_KEY`. The extension loads this package-scoped file regardless of the project where Pi is running; variables already present in Pi's environment take precedence. Self-hosted Firecrawl deployments may also set `FIRECRAWL_API_URL`.

```bash
cp .env.example .env
# Edit .env and replace fc-your-key
```

Large scrape responses are truncated in model context and saved in full to a temporary Markdown file.

The `axios` override in `package.json` is intentional: the Firecrawl SDK currently pins an older vulnerable release. Remove the override once Firecrawl ships with a patched Axios dependency.

### Image generation

Adds `generate_image`, backed by Codex's image-generation endpoint and Pi's existing `openai-codex` login. It accepts a detailed prompt, a required absolute PNG output path, and optional aspect ratio and background mode. Each call saves the full PNG and also returns the image inline so the model can inspect it. Parent directories are created, and existing files are never overwritten.

The request uses Codex's `gpt-image-2` identifier, but the service controls the effective image model and does not report it. The tool therefore labels results as server-managed and does not expose a misleading model selector. This is an undocumented ChatGPT endpoint and may require updates if OpenAI changes it.

### Dictation

**Hold Space continuously for one second** to start dictation. Text appears live in the prompt; release Space to stop and finalize it. Space is inserted immediately on key-down through Pi's normal editor, without waiting for release. Holding also leaves that one normal space in the draft, but suppresses repeats. Wait for the **Listening** indicator before speaking (connecting can take longer than the one-second hold). Releasing while still connecting cancels startup. Nothing is submitted automatically, and existing prompt text is preserved.

Uses **`gpt-live-transcribe`**, with expected languages **`["en", "sv"]`** for English/Swedish code-switching and **`delay: "low"`**. No transcription prompt is sent: the earlier bilingual instruction prompt could be echoed as invented speech. Language hints are not a strict output filter.

The model streams partial text during uninterrupted speech without waiting for a pause or an audio commit. Release Space to commit the turn and wait for its final transcript. Unlike the previous model, it does **not support server VAD**, so the old 0.03 detection threshold, prefix padding, and 300 ms silence settings no longer apply. There are no arbitrary periodic audio cuts. Processing/network latency still applies. On release, 250 ms of generated silence is appended before the final commit to give short utterances trailing context; the microphone is not kept open for this. SoX uses a smaller 1024-byte processing buffer to reduce short-recording buffering. These are short-utterance robustness measures, not a guarantee of model recognition. An empty result reports whether no audio was captured or the service returned no text. Partial text is replaced by finalized text without duplication. The live insertion begins at the prompt cursor; updates can move the cursor to the end. Cancelling removes the provisional text and restores the original draft. If you independently edit the prompt during dictation, further updates cancel rather than overwrite those edits. Short clips are finalized on release.

The below-input dashboard shows a microphone indicator immediately left of weekly usage: **Mic off**, **Connecting**, **Listening**, or **Transcribing**. Listening appears only after microphone audio starts arriving; Transcribing means capture is stopping/stopped while final text finishes.

Hold-to-talk requires **Kitty keyboard protocol with key-release reporting** (for example Kitty or Ghostty). The extension requests reporting for unmodified keys while loaded and restores Pi's keyboard mode on shutdown/reload. Standalone modifier reports (Shift, Ctrl, etc.) are consumed so their private-use key codes cannot appear as typed symbols. Without protocol support, Space stays a normal typing key; there is no unreliable repeat-gap approximation. Dictation is keyboard-only; no slash commands are registered. The previous Ctrl+Shift+D shortcut is removed.

Uses **Pi's existing `openai-codex` credentials**, refreshed by Pi, even when another chat provider is selected. No separate voice provider, login, or API key is created. Other providers' tokens (including the newer `openai` ChatGPT login) are not substituted. OpenAI must accept your Codex token for `gpt-live-transcribe`; this new model's compatibility with that login still needs a live test. Subscription eligibility, limits, and billing are not guaranteed by the published API pricing. Setup fails visibly if rejected; it does not silently switch models or authentication.

Microphone capture uses **SoX** (`rec`) and the default input device. On macOS, install it with `brew install sox` if needed and allow your terminal microphone access in **System Settings → Privacy & Security → Microphone**. Audio streams directly to OpenAI's realtime transcription endpoint using `gpt-live-transcribe`; no local audio files are saved. Recording stops automatically after two minutes. Reload, session changes, and tree navigation cancel dictation and release the microphone.

This is dictation only: no spoken replies, browser/LAN server, native binary, or voice conversation state. The downloaded `pi-gpt-voice/` reference package is not loaded or required. Uses a direct WebSocket connection (no custom endpoints or proxy configuration).

### Context viewer

Adds `/context-viewer`, a full-height read-only view of Pi's effective system prompt. This is the instruction text assembled from Pi's base prompt, applicable context files such as `AGENTS.md`, tool guidance, and the skill catalog. It deliberately excludes user prompts, assistant replies, tool results, tool-schema JSON, and other diagnostic metadata.

In regular TUI mode, use the terminal's native scrollback or mouse/trackpad to scroll through the full rendered prompt. Press Escape or `q` to close. Native terminal scrollback is unavailable in fullscreen/alternate-screen mode.

### Nested

[`extensions/nested/`](extensions/nested/README.md) combines nested instructions, subtree-scoped skills, and nested MCP servers in one extension. Only `extensions/nested/index.ts` is loaded; the former entry points have been removed. Existing resource formats, approvals, and activation behavior are preserved.

#### Nested AGENTS.md

Loads nested `AGENTS.md` instructions when Pi starts working with a path in their subtree. Pi already loads the root and ancestor `AGENTS.md` files; this extension adds the nested, path-scoped behavior.

The extension detects paths in prompts and in the built-in file/search/shell tools. Instructions are injected once per session, from the broadest applicable directory to the most specific. A first write, edit, or shell command is blocked and retried after newly discovered instructions enter model context. The resource-status widget shows the count and repository-relative directories whose nested `AGENTS.md` instructions were injected during the session.

#### Monorepo skills

Discovers skills across the repository, but advertises nested skills only when their subtree becomes relevant:

- A skill below `package/ui/.agents/skills/` is scoped to `package/ui`.
- A skill below `apps/web/.pi/skills/` is scoped to `apps/web`.
- A literal skill path in `apps/web/.pi/settings.json` also adds `apps/web` as a scope for that skill. This allows one skill to belong to `packages/ui` while also applying in `apps/web`.

Scopes activate when the initial working directory, a prompt path, or a built-in file/search/shell tool enters them. Mutating tool calls are blocked once so the newly injected skill catalog reaches the model before the mutation is retried. The status widget lists a skill only after its `SKILL.md` instructions are actually invoked or read.

Pi currently requires skills to be registered during resource discovery for `/skill:name` expansion. The extension therefore registers the complete resource set internally, removes inactive skills from the model-facing system prompt, and advertises them only on scope activation.

The extension deliberately does not apply other nested Pi settings. Glob and negative selectors remain the responsibility of Pi's native settings loader; this extension follows literal paths and exact `+path` inclusions only. Repository scans skip dependency, VCS, coverage, and common build-output directories.

#### Nested MCP

Discovers `.mcp.json` files across a repository and activates their servers only when the initial working directory, a prompt path, or a built-in file/search/shell tool enters the file's subtree. The first mutating tool call is blocked once so the activation notice reaches the model before the mutation is retried.

This is a deliberately minimal, first-party MCP client rather than a dependency on a third-party Pi MCP extension. It supports stdio commands plus unauthenticated SSE and Streamable HTTP servers with HTTP(S) URLs, including configs whose type is `"http"` or `"streamable-http"`. Stdio processes run with the `.mcp.json` directory as their working directory; configured environment variables are merged with the SDK's safe default environment. OAuth, custom HTTP headers, MCP resources, and MCP prompts remain unsupported.

Every server requires an explicit approval dialog before activation. Approval is stored against a hash of the scoped server definition in both the Pi session and the project-root `.pi/.mcp.auto.json`, allowing subsequent trusted-project sessions and RPC subagents to activate an unchanged server without another prompt. Changing its name, scope, transport, URL, or command requires approval again. Unapproved servers remain disabled in headless and RPC sessions, so subagents cannot block waiting for confirmation. Nested scans do not follow symbolic-link directories.

Servers connect lazily through the `mcp` gateway tool. Use `action: "servers"` to inspect active servers, `action: "tools"` to connect and discover tools, and `action: "call"` to invoke one. Scoped IDs such as `apps/website:astro` avoid collisions between identically named servers in different applications. `/mcp-status` shows the active set.

For Astro, place the generated configuration at `apps/website/.mcp.json`:

```json
{
  "mcpServers": {
    "astro": {
      "type": "sse",
      "url": "http://localhost:4321/__mcp/sse"
    }
  }
}
```

The Astro development server must already be running; the MCP client connects to its endpoint but does not start Astro itself.

### Resource status

Shows a unified live dashboard below the editor. Its top row keeps the session name on the left and the microphone indicator followed by the weekly OpenAI usage window on the right. A separate main-agent row contains elapsed time, resource counters, output throughput in `t/s`, and model-labeled context usage. Subagent runs appear beneath it as an aggregate row plus aligned per-agent rows; each child has its own `t/s` value and the aggregate is their sum. Rates use a roughly one-second rolling window of reported output tokens, excluding the initial wait for generation, and retain their last measurement between responses. Providers that report usage only at completion fall back to a whole-response average; before the first measurement the widget shows `— t/s`. Other OpenAI usage windows, todos, injected agent directories, and actually loaded skills follow in the same widget. OpenAI model labels omit the redundant `gpt-` prefix.

`A(N)`, `S(N)`, and `T(X/N)` mean loaded agent instruction files, loaded skills, and completed/total todos. Subagent aggregate counters and context values are sums across the displayed children, and aggregate elapsed time is the sum of their run times. The layout wraps into separate label and metrics lines on narrow terminals and refreshes elapsed values every second.

Extension participation is still tracked for the `/mypi-resources` command, but it is intentionally omitted from the always-visible dashboard. Pi does not currently expose a public API for enumerating every third-party extension and native skill.

### Ask user

Adds the `ask_user` tool for structured interactive questions instead of numbered questions in chat. One call can contain multiple questions, and each question supports either single-select or multi-select answers. The custom terminal questionnaire always adds **Free text…** and **Skip** choices. Questions use terminal input only. Multi-select questions allow combining suggested and free-text answers before continuing.

### Todos

Adds a model-callable `todo` tool whose state appears in the unified below-editor dashboard. The dashboard shows the latest completed item plus up to four incomplete items, summarizes additional active items, and keeps older completed items represented only in the count. The agent can list, add, complete, edit, remove, and clear items. State is stored in tool-result details so it follows the active session branch and reconstructs correctly after reload, resume, fork, or tree navigation. Use `/todos` to show the complete list in a notification.

### OpenAI subscription usage

Tracks the ChatGPT Codex subscription windows for the active `openai-codex` model. It reads Pi's existing OAuth token, requests usage from ChatGPT's usage endpoint, and publishes progress bars for the five-hour and weekly remaining percentages and reset times to the resource-status widget.

Usage refreshes when the session starts, after each turn, when the model changes, and every minute while an OpenAI Codex model is active. Use `/openai-usage refresh` for a manual refresh. Polling runs only in interactive TUI sessions and stops during shutdown or when another provider is selected.

The ChatGPT usage endpoint is an undocumented service endpoint and may require parser updates if OpenAI changes its response format.

### Subagents

Adds a generic `subagent` tool for starting up to sixteen independent tasks in isolated Pi RPC subprocesses. Calls return session-local agent IDs immediately, while one session-wide scheduler limits concurrency to four across every start call. The parent is instructed to choose explicitly among `openai-codex/gpt-6-luna` for focused, cost-sensitive work, `openai-codex/gpt-6.1-sol` for a strong intelligence/cost balance, and `openai-codex/gpt-6-astra` for the most demanding reasoning and coding. Omitting the model intentionally inherits the parent model. Tasks also inherit the parent thinking level, working directory, and project trust decision unless explicitly overridden. Child sessions are ephemeral and cannot recursively invoke subagent management or blocking interactive tools. The runner discovers the CLI through Pi's `package.json` `bin` entry, supporting both bundled and legacy layouts without hardcoded `dist/cli.js` paths. It checks the running installation, the host SDK package, the managed install's current release, and finally the local SDK; the CLI must match the host RPC client's version to prevent protocol mismatches. Restart Pi after updating or replacing its installation so the parent and children use the same version.

When a child completes, fails, or is aborted, a bounded custom message containing its task and outcome is delivered immediately into the main agent context. It steers an active main run or wakes an idle main agent, then the settled child is removed from the active registry. The parent should continue independent work or, when only delegated results remain, end its turn with a brief progress note and rely on the completion wake-up. Yielding the turn does not declare the user's task complete: the substantive final answer still requires the results. Instructions and start-tool results explicitly prohibit `bash sleep`, delay loops, polling, and keep-alive tool calls merely to wait. `list_subagents` is reserved for real status checks or cancellation decisions and therefore reports only queued or running children. `cancel_subagents` accepts a list of session-local agent IDs. IDs are never reused within a session. Parent-turn cancellation does not cancel background children; session shutdown, reload, or replacement does.

The unified below-editor dashboard shows active aggregate and per-agent activity, IDs, elapsed time, resource counters, model, and context usage. Rows disappear after their outcomes are delivered. The chat start call presents each delegated task in its own Markdown quote block with its selected model (or an explicit parent-model inheritance label). Completion messages show the worker's model in both compact and expanded views, while redundant status output stays hidden because it remains visible in the dashboard. It intentionally omits turn, raw usage-token, and dollar-cost fields. Subagents share the same working tree, so parallel tasks should not edit the same files.

This implementation runs inline in every terminal. Its worker/event model is intentionally independent of cmux so a later adapter can expose the same agents in visible cmux tabs without replacing the scheduler or widget.

## Development

```bash
npm install
npm test
npm run check
pi -e .
```

Install this directory as a personal local package:

```bash
pi install .
```

Use `/reload` after editing an installed local package.
