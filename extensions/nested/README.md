# Nested resources

`index.ts` is the single Pi extension entry point, announced as **nested**. It
combines the existing nested instruction, monorepo skill, and path-scoped MCP
behavior without changing their resource formats or activation policies.

- `agents.ts` injects applicable nested `AGENTS.md` files and blocks mutations
  until queued instructions have reached the next turn. Pi still loads root and
  ancestor instruction files itself.
- `skills.ts` discovers nested `.agents/skills`, `.pi/skills`, and literal skill
  references in `.pi/settings.json`. Skills enter the model catalog when their
  scope is referenced; the complete discovered set remains available to Pi's
  `/skill:name` expansion.
- `mcp.ts` retains the lazy `mcp` gateway and `/mcp-status`. It keeps the existing
  SDK stdio, legacy SSE (including the URL-only default), and Streamable HTTP
  transports. Server approval, trusted `.pi/.mcp.auto.json` loading, RPC approval
  restrictions, connection cleanup, and configuration-bound hashes are unchanged.

The factory registers modules in their former alphabetical load order: skills,
then instructions, then MCP. Pi's first blocking `tool_call` handler still stops
later handlers. Do not combine these handlers in a way that discards an earlier
block or one of the `before_agent_start` messages.

## Compatibility and loading

The three former extension directories have been removed. Their utilities now
live here as `agents-core.ts`, `skills-core.ts`, and `mcp-core.ts`.
`resource-status` imports `readSkillName` from `skills-core.ts`. There are no
legacy entry points or compatibility directories to load duplicate extensions.

The package's `extensions/*/index.ts` glob already finds this entry point. Replace
any explicit old entry-point paths in external profiles/settings with
`extensions/nested/index.ts` (or the `nested` directory). Do not list the internal
modules individually. No settings are written by this consolidation.

Existing custom message types, `nested-mcp-approval` branch entries, approval
hashes, and `mypi:nested-agents-changed` / `mypi:skills-changed` payloads retain
their names and formats. Only the extension-loaded identity changes to `nested`,
so status retains instruction and skill data while listing one extension.

## Focused checks

From the repository root, without media/native builds:

```sh
node --test test/nested*.test.ts test/monorepo-skills.test.ts test/resource-status.test.ts
./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --allowImportingTsExtensions --types node --skipLibCheck extensions/nested/index.ts test/nested*.test.ts test/monorepo-skills.test.ts
```

The integration tests cover the unified identity, resource/status payloads,
mutation ordering, scope exclusions, trusted approval persistence, legacy branch
approval restoration, changed-definition invalidation, and local SSE/HTTP tool
round trips with lazy connection and idempotent shutdown.
