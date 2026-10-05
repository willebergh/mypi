# mypi

Personal [Pi](https://pi.dev) extensions.

## Extensions

### Web

Provides provider-neutral web tools backed by dedicated integrations. The current `web_scrape` tool uses Firecrawl to fetch the main content of one known HTTP(S) URL as Markdown. Future search and extraction tools can add Firecrawl, Brave, Exa, or other providers under `extensions/web/providers/` without changing the model-facing tool names.

Copy `.env.example` to `.env` in this package and add `FIRECRAWL_API_KEY`. The extension loads this package-scoped file regardless of the project where Pi is running; variables already present in Pi's environment take precedence. Self-hosted Firecrawl deployments may also set `FIRECRAWL_API_URL`.

```bash
cp .env.example .env
# Edit .env and replace fc-your-key
```

Large scrape responses are truncated in model context and saved in full to a temporary Markdown file.

The `axios` override in `package.json` is intentional: the Firecrawl SDK currently pins an older vulnerable release. Remove the override once Firecrawl ships with a patched Axios dependency.

### Nested AGENTS.md

Loads nested `AGENTS.md` instructions when Pi starts working with a path in their subtree. Pi already loads the root and ancestor `AGENTS.md` files; this extension adds the nested, path-scoped behavior.

The extension detects paths in prompts and in the built-in file/search/shell tools. Instructions are injected once per session, from the broadest applicable directory to the most specific. A first write, edit, or shell command is blocked and retried after newly discovered instructions enter model context. The resource-status widget shows the count and repository-relative directories whose nested `AGENTS.md` instructions were injected during the session.

### Monorepo skills

Discovers skills across the repository, but advertises nested skills only when their subtree becomes relevant:

- A skill below `package/ui/.agents/skills/` is scoped to `package/ui`.
- A skill below `apps/web/.pi/skills/` is scoped to `apps/web`.
- A literal skill path in `apps/web/.pi/settings.json` also adds `apps/web` as a scope for that skill. This allows one skill to belong to `packages/ui` while also applying in `apps/web`.

Scopes activate when the initial working directory, a prompt path, or a built-in file/search/shell tool enters them. Mutating tool calls are blocked once so the newly injected skill catalog reaches the model before the mutation is retried. The status widget lists a skill only after its `SKILL.md` instructions are actually invoked or read.

Pi currently requires skills to be registered during resource discovery for `/skill:name` expansion. The extension therefore registers the complete resource set internally, removes inactive skills from the model-facing system prompt, and advertises them only on scope activation.

The extension deliberately does not apply other nested Pi settings. Glob and negative selectors remain the responsibility of Pi's native settings loader; this extension follows literal paths and exact `+path` inclusions only. Repository scans skip dependency, VCS, coverage, and common build-output directories.

### Nested MCP

Discovers `.mcp.json` files across a repository and activates their servers only when the initial working directory, a prompt path, or a built-in file/search/shell tool enters the file's subtree. The first mutating tool call is blocked once so the activation notice reaches the model before the mutation is retried.

This is a deliberately minimal, first-party MCP client rather than a dependency on a third-party Pi MCP extension. It supports stdio commands plus unauthenticated SSE and Streamable HTTP servers with HTTP(S) URLs, including configs whose type is `"http"` or `"streamable-http"`. Stdio processes run with the `.mcp.json` directory as their working directory; configured environment variables are merged with the SDK's safe default environment. OAuth, custom HTTP headers, MCP resources, and MCP prompts remain unsupported.

Every server requires an explicit approval dialog before activation. Approval is stored in the Pi session against a hash of the scoped server definition; changing its name, scope, transport, URL, or command requires approval again. Unapproved servers remain disabled in headless sessions. Nested scans do not follow symbolic-link directories.

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

Shows a live widget below the editor with injected agent directories, actually loaded skills, compact context usage, and provider limits reported by this package. Loaded agent directories and skills use the selected-background highlight. It refreshes whenever tracked resources change and whenever monorepo skill discovery runs during startup or `/reload`.

Extension participation is still tracked for the `/mypi-resources` command, but it is intentionally omitted from the always-visible widget. Pi does not currently expose a public API for enumerating every third-party extension and native skill.

### Ask user

Adds the `ask_user` tool for structured interactive questions instead of numbered questions in chat. One call can contain multiple questions, and each question supports either single-select or multi-select answers. The custom terminal questionnaire always adds **Free text…** and **Skip** choices. Multi-select questions allow combining suggested and free-text answers before continuing.

### Todos

Adds a separate below-editor todo widget and a model-callable `todo` tool. The agent can list, add, complete, edit, remove, and clear items. State is stored in tool-result details so it follows the active session branch and reconstructs correctly after reload, resume, fork, or tree navigation. Use `/todos` to show the current list in a notification.

### OpenAI subscription usage

Tracks the ChatGPT Codex subscription windows for the active `openai-codex` model. It reads Pi's existing OAuth token, requests usage from ChatGPT's usage endpoint, and publishes progress bars for the five-hour and weekly remaining percentages and reset times to the resource-status widget.

Usage refreshes when the session starts, after each turn, when the model changes, and every minute while an OpenAI Codex model is active. Use `/openai-usage refresh` for a manual refresh. Polling runs only in interactive TUI sessions and stops during shutdown or when another provider is selected.

The ChatGPT usage endpoint is an undocumented service endpoint and may require parser updates if OpenAI changes its response format.

### Subagents

Adds a generic `subagent` tool for running up to eight independent tasks in isolated Pi RPC subprocesses, with at most four running concurrently by default. Tasks inherit the parent model, thinking level, working directory, and project trust decision unless explicitly overridden. Child sessions are ephemeral and cannot recursively invoke `subagent` or blocking interactive tools.

A live below-editor widget shows each agent's activity and elapsed time, followed by a compact context bar and `A(N)`, `S(N)`, and `T(X/N)` counters for loaded agent files, loaded skills, and completed/total todos. It intentionally omits turn, raw token, and dollar-cost fields. Pressing Escape on the parent run propagates cancellation to active children. Subagents share the same working tree, so parallel tasks should not edit the same files.

This first version runs inline in every terminal. Its worker/event model is intentionally independent of cmux so a later adapter can expose the same agents in visible cmux tabs without replacing the scheduler or widget.

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
