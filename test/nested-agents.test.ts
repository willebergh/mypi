import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import nestedAgents from "../extensions/nested-agents/index.ts";
import {
  extractPathMentions,
  findApplicableAgentsFiles,
  pathsFromToolCall,
} from "../extensions/nested-agents/core.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nested-agents-"));
  await mkdir(path.join(root, "apps", "web", "src"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "root");
  await writeFile(path.join(root, "apps", "AGENTS.md"), "apps");
  await writeFile(path.join(root, "apps", "web", "AGENTS.md"), "web");
  return root;
}

test("finds applicable nested files from broadest to most specific", async () => {
  const root = await fixture();
  const files = await findApplicableAgentsFiles(
    root,
    "apps/web/src/page.ts",
    "file",
  );

  assert.deepEqual(
    files.map((file) => path.relative(root, file)),
    [path.join("apps", "AGENTS.md"), path.join("apps", "web", "AGENTS.md")],
  );
});

test("excludes the root AGENTS.md because Pi loads it natively", async () => {
  const root = await fixture();
  assert.deepEqual(
    await findApplicableAgentsFiles(root, "package.json", "file"),
    [],
  );
});

test("ignores paths outside the working directory", async () => {
  const root = await fixture();
  assert.deepEqual(
    await findApplicableAgentsFiles(root, "../elsewhere/file.ts", "file"),
    [],
  );
});

test("discovers instruction files created after session startup", async () => {
  const root = await fixture();
  const directory = path.join(root, "apps", "web", "src");
  await writeFile(path.join(directory, "AGENTS.md"), "src");

  const files = await findApplicableAgentsFiles(
    root,
    "apps/web/src/new.ts",
    "file",
  );
  assert.equal(path.relative(root, files.at(-1)!), path.join("apps", "web", "src", "AGENTS.md"));
});

test("extracts path mentions from prompts and shell commands", () => {
  assert.deepEqual(
    extractPathMentions("Update `apps/web/src/page.ts` and @docs/guide.md."),
    ["apps/web/src/page.ts", "docs/guide.md"],
  );
});

test("classifies built-in tool paths", () => {
  assert.deepEqual(pathsFromToolCall("write", { path: "apps/web/new.ts" }), [
    { path: "apps/web/new.ts", kind: "file" },
  ]);
  assert.deepEqual(pathsFromToolCall("find", { path: "apps/web", pattern: "*.ts" }), [
    { path: "apps/web", kind: "directory" },
  ]);
  assert.deepEqual(pathsFromToolCall("bash", { command: "pnpm --dir apps/web test" }), [
    { path: "apps/web", kind: "unknown" },
  ]);
});

test("blocks mutations until newly queued instructions reach the next turn", async () => {
  const root = await fixture();
  const handlers = new Map<string, Array<(event: any, context?: any) => Promise<any>>>();
  const messages: any[] = [];
  const emitted: Array<{ name: string; data: any }> = [];
  const api = {
    events: {
      emit(name: string, data: any) {
        emitted.push({ name, data });
      },
    },
    on(name: string, handler: (event: any, context?: any) => Promise<any>) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
      return () => undefined;
    },
    sendMessage(message: any, options: any) {
      messages.push({ message, options });
    },
  };
  nestedAgents(api as any);

  const emit = async (name: string, event: any, context?: any) => {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      result = await handler(event, context);
    }
    return result;
  };

  await emit("session_start", {}, { cwd: root });
  await emit("turn_start", { turnIndex: 0 });

  const first = await emit("tool_call", {
    toolName: "write",
    input: { path: "apps/web/new.ts" },
  });
  const parallel = await emit("tool_call", {
    toolName: "edit",
    input: { path: "apps/web/existing.ts" },
  });

  assert.equal(first.block, true);
  assert.equal(parallel.block, true);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].message.details.files, [
    "apps/AGENTS.md",
    "apps/web/AGENTS.md",
  ]);
  assert.deepEqual(
    emitted.filter((event) => event.name === "mypi:nested-agents-changed").at(-1)?.data,
    { files: ["apps/AGENTS.md", "apps/web/AGENTS.md"] },
  );

  await emit("turn_start", { turnIndex: 1 });
  const retry = await emit("tool_call", {
    toolName: "write",
    input: { path: "apps/web/new.ts" },
  });
  assert.equal(retry, undefined);
});
