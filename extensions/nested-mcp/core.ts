import { realpath, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isInside, normalizeReferencedPath } from "../nested-agents/core.ts";
import { findRepositoryRoot } from "../monorepo-skills/core.ts";

export const MCP_FILENAME = ".mcp.json";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".astro",
  ".turbo",
]);

export interface McpServerDefinition {
  type: "sse" | "http";
  url: string;
}

export interface ScopedMcpServer {
  id: string;
  name: string;
  definition: McpServerDefinition;
  configFile: string;
  scopeRoot: string;
  scopeLabel: string;
}

export interface McpConfigDiagnostic {
  file: string;
  message: string;
}

export interface NestedMcpDiscovery {
  root: string;
  servers: ScopedMcpServer[];
  diagnostics: McpConfigDiagnostic[];
}

function serverId(root: string, scopeRoot: string, name: string): string {
  const relative = path.relative(root, scopeRoot).split(path.sep).join("/") || ".";
  return `${relative}:${name}`;
}

function parseServer(name: string, raw: unknown): McpServerDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`server ${JSON.stringify(name)} must be an object`);
  }

  const record = raw as Record<string, unknown>;
  if (record.command !== undefined) {
    throw new Error(
      `server ${JSON.stringify(name)} uses unsupported stdio transport; only SSE is supported`,
    );
  }
  if (
    record.type !== undefined &&
    record.type !== "sse" &&
    record.type !== "http" &&
    record.type !== "streamable-http"
  ) {
    throw new Error(
      `server ${JSON.stringify(name)} uses unsupported transport ${JSON.stringify(record.type)}; only SSE and Streamable HTTP are supported`,
    );
  }
  if (typeof record.url !== "string" || record.url.trim() === "") {
    throw new Error(`server ${JSON.stringify(name)} must have a URL`);
  }

  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error(`server ${JSON.stringify(name)} has an invalid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`server ${JSON.stringify(name)} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`server ${JSON.stringify(name)} must not put credentials in its URL`);
  }

  return {
    type:
      record.type === "http" || record.type === "streamable-http"
        ? "http"
        : "sse",
    url: url.toString(),
  };
}

export async function readMcpConfig(
  root: string,
  file: string,
): Promise<{ servers: ScopedMcpServer[]; diagnostics: McpConfigDiagnostic[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return {
      servers: [],
      diagnostics: [{ file, message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { servers: [], diagnostics: [{ file, message: "configuration must be a JSON object" }] };
  }
  const rawServers = (parsed as Record<string, unknown>).mcpServers;
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    return { servers: [], diagnostics: [{ file, message: "configuration must contain an mcpServers object" }] };
  }

  const scopeRoot = path.dirname(file);
  const scopeLabel = path.relative(root, scopeRoot).split(path.sep).join("/") || ".";
  const servers: ScopedMcpServer[] = [];
  const diagnostics: McpConfigDiagnostic[] = [];

  for (const [name, raw] of Object.entries(rawServers)) {
    if (!name.trim()) {
      diagnostics.push({ file, message: "server names must not be empty" });
      continue;
    }
    try {
      servers.push({
        id: serverId(root, scopeRoot, name),
        name,
        definition: parseServer(name, raw),
        configFile: file,
        scopeRoot,
        scopeLabel,
      });
    } catch (error) {
      diagnostics.push({
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { servers, diagnostics };
}

export async function discoverNestedMcp(cwd: string): Promise<NestedMcpDiscovery> {
  const root = await findRepositoryRoot(cwd);
  const files: string[] = [];
  const visited = new Set<string>();

  const walk = async (directory: string): Promise<void> => {
    let canonical: string;
    try {
      canonical = await realpath(directory);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === MCP_FILENAME) {
        files.push(path.resolve(fullPath));
      } else if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        await walk(fullPath);
      }
    }
  };

  await walk(root);
  files.sort((left, right) => left.localeCompare(right));
  const loaded = await Promise.all(files.map((file) => readMcpConfig(root, file)));
  const seenIds = new Set<string>();
  const servers: ScopedMcpServer[] = [];
  const diagnostics = loaded.flatMap((result) => result.diagnostics);

  for (const server of loaded.flatMap((result) => result.servers)) {
    if (seenIds.has(server.id)) {
      diagnostics.push({ file: server.configFile, message: `duplicate scoped server id ${server.id}` });
      continue;
    }
    seenIds.add(server.id);
    servers.push(server);
  }

  return { root, servers, diagnostics };
}

export function resolveReferencedTargets(root: string, rawPaths: string[]): string[] {
  return rawPaths
    .map(normalizeReferencedPath)
    .filter(Boolean)
    .map((target) => path.resolve(root, target))
    .filter((target) => isInside(root, target));
}

export function applicableMcpServers(
  servers: Iterable<ScopedMcpServer>,
  targets: string[],
): ScopedMcpServer[] {
  return [...servers].filter((server) =>
    targets.some((target) => isInside(server.scopeRoot, target)),
  );
}
