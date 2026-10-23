import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import nested from "../extensions/nested/index.ts";

for (const type of ["sse", "http"] as const) {
  test(`unified nested gateway retains lazy ${type} transport and shutdown`, { timeout: 15_000 }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nested-transport-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".git"));
    const mcp = new Server({ name: "nested-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: "text", text: String(request.params.arguments?.text) }],
      structuredContent: { echoed: request.params.arguments?.text },
    }));
    let sse: SSEServerTransport | undefined;
    const http = type === "http"
      ? new StreamableHTTPServerTransport({ sessionIdGenerator: () => "nested-test-session", enableJsonResponse: true })
      : undefined;
    if (http) await mcp.connect(http);
    let requests = 0;
    const requestErrors: unknown[] = [];
    const server = createServer((req, res) => {
      requests += 1;
      void (async () => {
        if (http) {
          await http.handleRequest(req, res);
        } else if (req.method === "GET" && req.url === "/sse") {
          sse = new SSEServerTransport("/messages", res);
          await mcp.connect(sse);
        } else if (req.method === "POST" && req.url?.startsWith("/messages")) {
          assert.ok(sse);
          await sse.handlePostMessage(req, res);
        } else {
          res.writeHead(404).end();
        }
      })().catch((error) => {
        requestErrors.push(error);
        res.writeHead(500).end();
      });
    });
    t.after(async () => {
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/${type === "sse" ? "sse" : "mcp"}`;
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { echo: { type, url: endpoint } } }));

    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    let gateway: any;
    nested({
      events: { emit() {} },
      on(name: string, handler: (event: any, ctx: any) => any) {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
        return () => undefined;
      },
      registerTool(tool: any) { assert.equal(gateway, undefined); gateway = tool; },
      registerCommand() {},
      appendEntry() {},
    } as any);
    const ctx = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [] },
      ui: { async confirm() { return true; }, notify() {} },
    };
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    };
    t.after(() => emit("session_shutdown"));
    await emit("session_start");
    await emit("before_agent_start", { prompt: "List tools", systemPromptOptions: { skills: [] } });
    assert.equal(requests, 0, "approval and activation must not open a connection");
    const tools = await gateway.execute("list", { action: "tools", server: ".:echo" });
    assert.match(tools.content[0].text, /"name": "echo"/);
    assert.ok(requests > 0);
    const result = await gateway.execute("call", { action: "call", server: ".:echo", tool: "echo", arguments: { text: "round-trip" } });
    assert.equal(result.content[0].text, "round-trip");
    assert.match(result.content[1].text, /"echoed": "round-trip"/);
    await emit("session_shutdown");
    await emit("session_shutdown");
    const status = await gateway.execute("status", { action: "servers" });
    assert.match(status.content[0].text, /connected: no/);
    assert.deepEqual(requestErrors, []);
  });
}
