import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import nested from "../extensions/nested/index.ts";
import {
  discoverNestedMcp,
  mcpApprovalHash,
  saveMcpAutoApproval,
} from "../extensions/nested/mcp-core.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nested-unified-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "apps/web/src"), { recursive: true });
  await writeFile(path.join(root, "apps/web/AGENTS.md"), "Web instructions");
  const skills = [];
  for (const name of ["web", "database"]) {
    const directory = path.join(root, "apps", name, ".agents/skills", name);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "SKILL.md");
    await writeFile(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
    skills.push({ name, filePath: await realpath(file) });
  }
  await writeFile(
    path.join(root, "apps/web/.mcp.json"),
    JSON.stringify({ mcpServers: { web: { type: "sse", url: "http://localhost:4321/sse" } } }),
  );
  return { root, skills };
}

function harness(root: string, options: { trusted?: boolean; mode?: string; branch?: any[] } = {}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const emitted: Array<{ name: string; data: any }> = [];
  const messages: Array<{ message: any; options: any }> = [];
  const entries: any[] = [];
  const tools: any[] = [];
  const commands: string[] = [];
  let confirmations = 0;
  nested({
    events: { emit(name: string, data: any) { emitted.push({ name, data }); } },
    on(name: string, handler: (event: any, ctx: any) => any) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
      return () => undefined;
    },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand(name: string) { commands.push(name); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
    appendEntry(customType: string, data: any) { entries.push({ customType, data }); },
  } as any);
  const ctx = {
    cwd: root,
    mode: options.mode ?? "tui",
    hasUI: true,
    isProjectTrusted: () => options.trusted ?? true,
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: {
      async confirm() { confirmations += 1; return true; },
      notify() {},
    },
  };
  // Match Pi: before_agent_start collects messages from every handler, while
  // tool_call stops at the first block instead of overwriting earlier guards.
  const emit = async (name: string, event: any = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(event, ctx);
      if (result !== undefined) results.push(result);
      if (name === "tool_call" && result?.block) break;
    }
    return results;
  };
  return { emit, emitted, messages, entries, tools, commands, confirmations: () => confirmations };
}

test("nested is the sole discoverable entry point for the three resource modules", async () => {
  assert.equal(nested.name, "nested");
  await access(new URL("../extensions/nested/index.ts", import.meta.url));
  for (const directory of ["nested-agents", "monorepo-skills", "nested-mcp"]) {
    await assert.rejects(access(new URL(`../extensions/${directory}/`, import.meta.url)), { code: "ENOENT" });
  }
});

test("one nested registration retains instruction and skill status plus lazy MCP activation", async (t) => {
  const { root, skills } = await fixture(t);
  const h = harness(root);
  t.after(() => h.emit("session_shutdown"));
  const resources = await h.emit("resources_discover", { cwd: root, reason: "startup" });
  assert.deepEqual(resources[0].skillPaths.sort(), skills.map((skill) => skill.filePath).sort());
  await h.emit("session_start");
  assert.deepEqual(h.tools.map((tool) => tool.name), ["mcp"]);
  assert.deepEqual(h.commands, ["mcp-status"]);
  assert.deepEqual(h.emitted.filter((item) => item.name === "mypi:extension-loaded").map((item) => item.data), [
    { id: "nested", label: "nested" },
  ]);

  const event = { prompt: "Inspect apps/web/src/page.ts", systemPromptOptions: { skills: [...skills] } };
  const results = await h.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.skills.map((skill) => skill.name), ["web"]);
  assert.deepEqual(results.map((result) => result.message.customType), ["nested-agents-context", "nested-mcp-activated"]);
  assert.match(results[0].message.content, /Web instructions/);
  assert.deepEqual(h.emitted.filter((item) => item.name === "mypi:nested-agents-changed").at(-1)?.data, {
    files: ["apps/web/AGENTS.md"],
  });
  assert.deepEqual(h.emitted.filter((item) => item.name === "mypi:skills-changed").at(-1)?.data, {
    skills: [{ name: "web", path: skills[0].filePath }],
  });
  assert.equal(h.confirmations(), 1);
  const status = await h.tools[0].execute("status", { action: "servers" });
  assert.match(status.content[0].text, /apps\/web:web/);
  assert.match(status.content[0].text, /transport: sse/);
  assert.match(status.content[0].text, /connected: no/);
});

test("unified mutation guards preserve skill, instruction, and approval ordering", async (t) => {
  const { root } = await fixture(t);
  const h = harness(root);
  t.after(() => h.emit("session_shutdown"));
  await h.emit("resources_discover", { cwd: root, reason: "startup" });
  await h.emit("session_start");
  await h.emit("turn_start", { turnIndex: 0 });
  const call = { toolName: "write", input: { path: "apps/web/src/page.ts" } };

  assert.match((await h.emit("tool_call", call))[0].reason, /Path-scoped skills/);
  assert.equal(h.confirmations(), 0);
  assert.match((await h.emit("tool_call", call))[0].reason, /Nested AGENTS.md/);
  assert.match((await h.emit("tool_call", { ...call, toolName: "edit" }))[0].reason, /Nested AGENTS.md/);
  assert.equal(h.confirmations(), 0);
  assert.deepEqual(h.messages.map((item) => item.message.customType), ["monorepo-skills-activated", "nested-agents-context"]);

  await h.emit("turn_start", { turnIndex: 1 });
  assert.match((await h.emit("tool_call", call))[0].reason, /Path-scoped MCP servers/);
  assert.equal(h.confirmations(), 1);
  assert.equal(h.entries[0].customType, "nested-mcp-approval");
  assert.deepEqual(await h.emit("tool_call", call), []);
  assert.equal(h.confirmations(), 1);
  assert.deepEqual(h.messages.map((item) => item.options), Array(3).fill({ deliverAs: "steer" }));
});

test("outside references do not activate nested resources", async (t) => {
  const { root, skills } = await fixture(t);
  const h = harness(root);
  t.after(() => h.emit("session_shutdown"));
  await h.emit("resources_discover", { cwd: root, reason: "startup" });
  await h.emit("session_start");
  const event = { prompt: "Inspect ../outside/src/page.ts", systemPromptOptions: { skills: [...skills] } };
  assert.deepEqual(await h.emit("before_agent_start", event), []);
  assert.deepEqual(event.systemPromptOptions.skills, []);
  assert.deepEqual(await h.emit("tool_call", { toolName: "write", input: { path: "../outside/src/page.ts" } }), []);
  assert.equal(h.confirmations(), 0);
  assert.equal(h.messages.length, 0);
});

for (const trusted of [false, true]) {
  test(`persisted MCP approvals remain trust-gated in RPC (trusted=${trusted})`, async (t) => {
    const { root, skills } = await fixture(t);
    const { servers } = await discoverNestedMcp(root);
    const server = servers[0]!;
    await saveMcpAutoApproval(root, server.id, mcpApprovalHash(server));
    const h = harness(root, { trusted, mode: "rpc" });
    t.after(() => h.emit("session_shutdown"));
    await h.emit("resources_discover", { cwd: root, reason: "startup" });
    await h.emit("session_start");
    const results = await h.emit("before_agent_start", { prompt: "Inspect apps/web/src/page.ts", systemPromptOptions: { skills } });
    assert.equal(results.some((result) => result.message.customType === "nested-mcp-activated"), trusted);
    assert.equal(h.confirmations(), 0);
  });
}

test("branch approval entries retain their legacy type and invalidate changed definitions", async (t) => {
  const { root, skills } = await fixture(t);
  const { servers } = await discoverNestedMcp(root);
  const server = servers[0]!;
  const branch = [{ type: "custom", customType: "nested-mcp-approval", data: { hash: mcpApprovalHash(server) } }];
  const h = harness(root, { mode: "rpc", branch });
  t.after(() => h.emit("session_shutdown"));
  await h.emit("resources_discover", { cwd: root, reason: "startup" });
  await h.emit("session_start");
  const run = () => h.emit("before_agent_start", { prompt: "Inspect apps/web/src/page.ts", systemPromptOptions: { skills: [...skills] } });
  assert.equal((await run()).some((result) => result.message.customType === "nested-mcp-activated"), true);

  await writeFile(server.configFile, JSON.stringify({ mcpServers: { web: { type: "sse", url: "http://localhost:9999/changed" } } }));
  await h.emit("session_start");
  assert.equal((await run()).some((result) => result.message.customType === "nested-mcp-activated"), false);
  assert.equal(h.confirmations(), 0);
});
