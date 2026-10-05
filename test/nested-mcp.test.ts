import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import nestedMcp from "../extensions/nested-mcp/index.ts";
import {
  applicableMcpServers,
  discoverNestedMcp,
  resolveReferencedTargets,
} from "../extensions/nested-mcp/core.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nested-mcp-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "apps", "website", "src"), { recursive: true });
  await mkdir(path.join(root, "apps", "docs"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
  await writeFile(
    path.join(root, "apps", "website", ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        astro: { type: "sse", url: "http://localhost:4321/__mcp/sse" },
      },
    }),
  );
  await writeFile(
    path.join(root, "apps", "docs", ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "Astro docs": { type: "http", url: "https://mcp.docs.astro.build/mcp" },
        "next-devtools": {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
          env: { NEXT_TELEMETRY_DISABLED: "1" },
        },
        malformed: { command: "node", args: [42] },
      },
    }),
  );
  await writeFile(
    path.join(root, "node_modules", "hidden", ".mcp.json"),
    JSON.stringify({ mcpServers: { hidden: { type: "sse", url: "https://example.com/sse" } } }),
  );
  return root;
}

test("discovers scoped stdio, SSE, and HTTP servers and reports malformed definitions", async () => {
  const root = await fixture();
  const discovery = await discoverNestedMcp(root);

  assert.equal(discovery.root, root);
  assert.deepEqual(
    discovery.servers.map((server) => server.id).sort(),
    ["apps/docs:Astro docs", "apps/docs:next-devtools", "apps/website:astro"],
  );
  assert.equal(
    discovery.servers.find((server) => server.id === "apps/docs:Astro docs")?.definition.type,
    "http",
  );
  assert.deepEqual(
    discovery.servers.find((server) => server.id === "apps/docs:next-devtools")?.definition,
    {
      type: "stdio",
      command: "npx",
      args: ["-y", "next-devtools-mcp@latest"],
      env: { NEXT_TELEMETRY_DISABLED: "1" },
    },
  );
  assert.equal(
    discovery.servers.find((server) => server.id === "apps/website:astro")?.scopeLabel,
    "apps/website",
  );
  assert.equal(discovery.diagnostics.length, 1);
  assert.match(discovery.diagnostics[0]!.message, /args must be an array of strings/);
});

test("activates a server only for paths in its subtree", async () => {
  const root = await fixture();
  const discovery = await discoverNestedMcp(root);
  const websiteTargets = resolveReferencedTargets(root, ["apps/website/src/page.astro"]);
  const docsTargets = resolveReferencedTargets(root, ["apps/docs/index.mdx", "../outside"]);

  assert.deepEqual(
    applicableMcpServers(discovery.servers, websiteTargets).map((server) => server.id),
    ["apps/website:astro"],
  );
  assert.deepEqual(
    applicableMcpServers(discovery.servers, docsTargets).map((server) => server.id),
    ["apps/docs:Astro docs", "apps/docs:next-devtools"],
  );
});

test("asks before activating a nested server and blocks the first mutation", async () => {
  const root = await fixture();
  const handlers = new Map<string, Array<(event: any, context?: any) => Promise<any>>>();
  const messages: any[] = [];
  const entries: any[] = [];
  let registeredTool: any;
  let confirmations = 0;

  const api = {
    events: { emit() {} },
    on(name: string, handler: (event: any, context?: any) => Promise<any>) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
      return () => undefined;
    },
    registerTool(tool: any) {
      registeredTool = tool;
    },
    registerCommand() {},
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
    appendEntry(customType: string, data: any) {
      entries.push({ customType, data });
    },
  };
  nestedMcp(api as any);

  const context = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch: () => [] },
    ui: {
      async confirm() {
        confirmations += 1;
        return true;
      },
      notify() {},
    },
  };
  const emit = async (name: string, event: any) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, context);
    return result;
  };

  await emit("session_start", { reason: "startup" });
  assert.ok(registeredTool);
  assert.equal(confirmations, 0);

  const result = await emit("tool_call", {
    toolName: "write",
    input: { path: "apps/website/src/page.astro" },
  });
  assert.equal(result.block, true);
  assert.equal(confirmations, 1);
  assert.equal(entries[0]?.customType, "nested-mcp-approval");
  assert.deepEqual(messages[0]?.message.details.servers, [
    {
      id: "apps/website:astro",
      transport: "sse",
      location: "http://localhost:4321/__mcp/sse",
    },
  ]);

  const status = await registeredTool.execute(
    "call-id",
    { action: "servers" },
    undefined,
    undefined,
    context,
  );
  assert.match(status.content[0].text, /apps\/website:astro/);

  const retry = await emit("tool_call", {
    toolName: "write",
    input: { path: "apps/website/src/other.astro" },
  });
  assert.equal(retry, undefined);
  assert.equal(confirmations, 1);
});
