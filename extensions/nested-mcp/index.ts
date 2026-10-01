import { createHash } from "node:crypto";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  extractPathMentions,
  pathsFromToolCall,
  toPosix,
} from "../nested-agents/core.ts";
import { announceExtension } from "../resource-status/protocol.ts";
import {
  applicableMcpServers,
  discoverNestedMcp,
  resolveReferencedTargets,
  type ScopedMcpServer,
} from "./core.ts";

const APPROVAL_ENTRY = "nested-mcp-approval";
const BLOCK_UNTIL_ACTIVE = new Set(["edit", "write", "bash", "powershell"]);
const MAX_TEXT_BYTES = 50 * 1024;
const MAX_TEXT_LINES = 2_000;

interface Connection {
  client: Client;
  transport: Transport;
}

interface McpToolDetails {
  action: string;
  servers?: string[];
  server?: string;
  tool?: string;
}

function approvalHash(server: ScopedMcpServer): string {
  return createHash("sha256")
    .update(JSON.stringify({ id: server.id, definition: server.definition }))
    .digest("hex");
}

function boundedText(text: string): string {
  const lines = text.split("\n");
  let result = lines.slice(0, MAX_TEXT_LINES).join("\n");
  const bytes = Buffer.byteLength(result);
  if (bytes > MAX_TEXT_BYTES) {
    result = Buffer.from(result).subarray(0, MAX_TEXT_BYTES).toString("utf8");
  }
  if (result !== text) {
    result += `\n\n[Output truncated to ${MAX_TEXT_BYTES} bytes / ${MAX_TEXT_LINES} lines]`;
  }
  return result;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activationMessage(servers: ScopedMcpServer[]) {
  return {
    customType: "nested-mcp-activated",
    content: `## Newly available MCP servers\n\nThe following path-scoped MCP servers are now available through the \`mcp\` tool. Use \`action: \"tools\"\` to inspect their tools before calling one.\n\n${servers
      .map((server) => `- **${server.id}** — ${server.definition.url}`)
      .join("\n")}`,
    display: false,
    details: {
      servers: servers.map((server) => ({ id: server.id, url: server.definition.url })),
    },
  };
}

export default function nestedMcp(pi: ExtensionAPI) {
  let root = "";
  let catalog = new Map<string, ScopedMcpServer>();
  const active = new Map<string, ScopedMcpServer>();
  const approvedHashes = new Set<string>();
  const denied = new Set<string>();
  const activationPromises = new Map<string, Promise<boolean>>();
  const connections = new Map<string, Connection>();
  const connecting = new Map<string, Promise<Connection>>();

  const closeConnections = async () => {
    const open = [...connections.values()];
    connections.clear();
    connecting.clear();
    await Promise.allSettled(open.map(({ client }) => client.close()));
  };

  const approve = async (
    server: ScopedMcpServer,
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    const hash = approvalHash(server);
    if (approvedHashes.has(hash)) return true;
    if (denied.has(server.id) || !ctx.hasUI) return false;

    const allowed = await ctx.ui.confirm(
      `Enable nested MCP server “${server.name}”?`,
      `Configuration: ${toPosix(path.relative(root, server.configFile))}\nScope: ${server.scopeLabel}\nEndpoint: ${server.definition.url}\n\nThe server can return untrusted content and expose tools that make changes. Only approve endpoints you trust.`,
    );
    if (!allowed) {
      denied.add(server.id);
      return false;
    }

    approvedHashes.add(hash);
    pi.appendEntry(APPROVAL_ENTRY, {
      hash,
      id: server.id,
      configFile: toPosix(path.relative(root, server.configFile)),
    });
    return true;
  };

  const activate = async (
    targets: string[],
    ctx: ExtensionContext,
  ): Promise<ScopedMcpServer[]> => {
    const candidates = applicableMcpServers(catalog.values(), targets).filter(
      (server) => !active.has(server.id),
    );
    const newlyActive: ScopedMcpServer[] = [];
    for (const server of candidates) {
      let activation = activationPromises.get(server.id);
      const ownsActivation = !activation;
      if (!activation) {
        activation = (async () => {
          if (!(await approve(server, ctx))) return false;
          if (active.has(server.id)) return false;
          active.set(server.id, server);
          return true;
        })();
        activationPromises.set(server.id, activation);
      }
      try {
        if ((await activation) && ownsActivation) newlyActive.push(server);
      } finally {
        if (activationPromises.get(server.id) === activation) {
          activationPromises.delete(server.id);
        }
      }
    }
    return newlyActive;
  };

  const selectServers = (requested?: string): ScopedMcpServer[] => {
    if (requested) {
      const server = active.get(requested);
      if (!server) {
        throw new Error(
          `MCP server ${JSON.stringify(requested)} is not active. Use action "servers" to list active servers.`,
        );
      }
      return [server];
    }
    return [...active.values()].sort((left, right) => left.id.localeCompare(right.id));
  };

  const connect = async (
    server: ScopedMcpServer,
    signal?: AbortSignal,
  ): Promise<Connection> => {
    const existing = connections.get(server.id);
    if (existing) return existing;
    const pending = connecting.get(server.id);
    if (pending) return pending;

    const promise = (async () => {
      const client = new Client({ name: "mypi-nested-mcp", version: "0.1.0" });
      const endpoint = new URL(server.definition.url);
      const transport: Transport =
        server.definition.type === "http"
          ? new StreamableHTTPClientTransport(endpoint)
          : new SSEClientTransport(endpoint);
      try {
        await client.connect(transport, { signal, timeout: 30_000 });
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
      const connection = { client, transport };
      connections.set(server.id, connection);
      return connection;
    })();
    connecting.set(server.id, promise);
    try {
      return await promise;
    } finally {
      connecting.delete(server.id);
    }
  };

  const listTools = async (server: ScopedMcpServer, signal?: AbortSignal) => {
    const { client } = await connect(server, signal);
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error(`MCP server ${server.id} returned more than 100 pages of tools`);
  };

  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      "Inspect and call tools from path-scoped MCP servers. First use action 'servers', then action 'tools', then action 'call'. Servers are connected lazily.",
    promptSnippet: "Use path-scoped MCP servers through the mcp gateway.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("servers"),
        Type.Literal("tools"),
        Type.Literal("call"),
      ]),
      server: Type.Optional(
        Type.String({ description: "Scoped server id returned by action 'servers'" }),
      ),
      tool: Type.Optional(Type.String({ description: "MCP tool name for action 'call'" })),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Arguments passed to the MCP tool",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (params.action === "servers") {
        const servers = selectServers(params.server);
        const text =
          servers.length === 0
            ? "No path-scoped MCP servers are active. Reference or work inside a directory containing .mcp.json first."
            : servers
                .map(
                  (server) =>
                    `${server.id}\n  scope: ${server.scopeLabel}\n  transport: ${server.definition.type}\n  url: ${server.definition.url}\n  connected: ${connections.has(server.id) ? "yes" : "no"}`,
                )
                .join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: { action: "servers" } as McpToolDetails,
        };
      }

      const servers = selectServers(params.server);
      if (servers.length === 0) throw new Error("No path-scoped MCP servers are active");

      if (params.action === "tools") {
        const listings = await Promise.all(
          servers.map(async (server) => ({ server, tools: await listTools(server, signal) })),
        );
        return {
          content: [
            {
              type: "text",
              text: boundedText(
                JSON.stringify(
                  listings.map(({ server, tools }) => ({ server: server.id, tools })),
                  null,
                  2,
                ),
              ),
            },
          ],
          details: {
            action: "tools",
            servers: servers.map((server) => server.id),
          } as McpToolDetails,
        };
      }

      if (!params.tool) throw new Error("action 'call' requires a tool name");
      if (servers.length !== 1) {
        throw new Error("action 'call' requires a server when more than one MCP server is active");
      }
      const server = servers[0]!;
      const { client } = await connect(server, signal);
      const result = (await client.callTool(
        { name: params.tool, arguments: params.arguments ?? {} },
        undefined,
        { signal },
      )) as {
        content: Array<Record<string, unknown>>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [];
      for (const block of result.content) {
        if (block.type === "text" && typeof block.text === "string") {
          content.push({ type: "text", text: boundedText(block.text) });
        } else if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        } else {
          content.push({ type: "text", text: boundedText(JSON.stringify(block, null, 2)) });
        }
      }
      if (result.structuredContent !== undefined) {
        content.push({
          type: "text",
          text: boundedText(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`),
        });
      }
      if (result.isError) {
        throw new Error(
          content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("\n") || `MCP tool ${params.tool} failed`,
        );
      }
      return {
        content: content.length > 0 ? content : [{ type: "text", text: "MCP tool completed without output." }],
        details: {
          action: "call",
          server: server.id,
          tool: params.tool,
        } as McpToolDetails,
      };
    },
  });

  pi.registerCommand("mcp-status", {
    description: "Show active path-scoped MCP servers",
    handler: async (_args, ctx) => {
      const servers = selectServers();
      ctx.ui.notify(
        servers.length === 0
          ? "Nested MCP: no active servers"
          : `Nested MCP (${servers.length}): ${servers.map((server) => server.id).join(" · ")}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await closeConnections();
    active.clear();
    approvedHashes.clear();
    denied.clear();
    activationPromises.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== APPROVAL_ENTRY) continue;
      const hash = (entry.data as { hash?: unknown } | undefined)?.hash;
      if (typeof hash === "string") approvedHashes.add(hash);
    }

    const discovery = await discoverNestedMcp(ctx.cwd);
    root = discovery.root;
    catalog = new Map(discovery.servers.map((server) => [server.id, server]));
    announceExtension(pi.events, { id: "nested-mcp", label: "nested-mcp" });

    for (const diagnostic of discovery.diagnostics) {
      ctx.ui.notify(
        `Nested MCP ignored ${toPosix(path.relative(root, diagnostic.file))}: ${diagnostic.message}`,
        "warning",
      );
    }

  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!root || catalog.size === 0) return;
    const targets = [
      path.resolve(ctx.cwd),
      ...resolveReferencedTargets(root, extractPathMentions(event.prompt)),
    ];
    const newlyActive = await activate(targets, ctx);
    if (newlyActive.length > 0) return { message: activationMessage(newlyActive) };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!root || catalog.size === 0 || event.toolName === "mcp") return;
    const references = pathsFromToolCall(event.toolName, event.input);
    const targets = resolveReferencedTargets(
      root,
      references.map((reference) => reference.path),
    );
    const newlyActive = await activate(targets, ctx);
    if (newlyActive.length === 0) return;

    pi.sendMessage(activationMessage(newlyActive), { deliverAs: "steer" });
    if (BLOCK_UNTIL_ACTIVE.has(event.toolName)) {
      return {
        block: true,
        reason: `Path-scoped MCP servers were activated: ${newlyActive.map((server) => server.id).join(", ")}. Review the newly available servers, then retry this ${event.toolName} call.`,
      };
    }
  });

  pi.on("session_shutdown", closeConnections);
}
