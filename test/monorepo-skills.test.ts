import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import monorepoSkills from "../extensions/monorepo-skills/index.ts";
import {
  discoverMonorepoSkills,
  findRepositoryRoot,
  readSkillName,
  skillsFromSettings,
} from "../extensions/monorepo-skills/core.ts";

async function makeSkill(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const skillFile = path.join(directory, "SKILL.md");
  await writeFile(
    skillFile,
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n`,
  );
  return skillFile;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "monorepo-skills-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "apps", "web", ".pi"), { recursive: true });
  await mkdir(path.join(root, "packages", "ui"), { recursive: true });
  return root;
}

test("finds the repository root from a nested working directory", async () => {
  const root = await fixture();
  assert.equal(
    await findRepositoryRoot(path.join(root, "apps", "web")),
    root,
  );
});

test("discovers nested .agents and .pi skill directories", async () => {
  const root = await fixture();
  const shadcn = await makeSkill(
    path.join(root, "packages", "ui", ".agents", "skills", "shadcn"),
    "shadcn",
  );
  const web = await makeSkill(
    path.join(root, "apps", "web", ".pi", "skills", "web-testing"),
    "web-testing",
  );

  const result = await discoverMonorepoSkills(path.join(root, "apps", "web"));
  assert.deepEqual(
    result.skillFiles,
    [await realpath(shadcn), await realpath(web)].sort(),
  );
});

test("resolves skill references relative to the containing .pi directory", async () => {
  const root = await fixture();
  const shadcn = await makeSkill(
    path.join(root, "packages", "ui", ".agents", "skills", "shadcn"),
    "shadcn",
  );
  const settings = path.join(root, "apps", "web", ".pi", "settings.json");
  await writeFile(
    settings,
    JSON.stringify({ skills: ["../../../packages/ui/.agents/skills"] }),
  );

  assert.deepEqual(await skillsFromSettings(settings), [shadcn]);
});

test("ignores generated dependency trees", async () => {
  const root = await fixture();
  await makeSkill(
    path.join(root, "node_modules", "dependency", ".agents", "skills", "hidden"),
    "hidden",
  );

  const result = await discoverMonorepoSkills(root);
  assert.deepEqual(result.skillFiles, []);
});

test("deduplicates a skill reached directly, through settings, and through a symlink", async () => {
  const root = await fixture();
  const skillDirectory = path.join(
    root,
    "packages",
    "ui",
    ".agents",
    "skills",
    "shadcn",
  );
  const shadcn = await makeSkill(skillDirectory, "shadcn");
  const settings = path.join(root, "apps", "web", ".pi", "settings.json");
  await writeFile(settings, JSON.stringify({ skills: ["../../../packages/ui/.agents/skills"] }));

  const linkedDirectory = path.join(root, ".agents", "skills", "shadcn");
  await mkdir(path.dirname(linkedDirectory), { recursive: true });
  await symlink(skillDirectory, linkedDirectory, "dir");

  const result = await discoverMonorepoSkills(root);
  assert.deepEqual(result.skillFiles, [await realpath(shadcn)]);
});

test("maps a shared skill to its owner and referring app scopes", async () => {
  const root = await fixture();
  const skill = await makeSkill(
    path.join(root, "packages", "ui", ".agents", "skills", "shadcn"),
    "shadcn",
  );
  await writeFile(
    path.join(root, "apps", "web", ".pi", "settings.json"),
    JSON.stringify({ skills: ["../../../packages/ui/.agents/skills"] }),
  );

  const result = await discoverMonorepoSkills(root);
  const canonicalSkill = await realpath(skill);
  const scoped = result.scopedSkills.find(
    (candidate) => candidate.file === canonicalSkill,
  );
  assert.deepEqual(scoped?.scopeRoots, [
    path.join(root, "apps", "web"),
    path.join(root, "packages", "ui"),
  ].sort());
});

test("reads the declared skill name", async () => {
  const root = await fixture();
  const skill = await makeSkill(
    path.join(root, "packages", "ui", ".agents", "skills", "folder-name"),
    "declared-name",
  );
  assert.equal(await readSkillName(skill), "declared-name");
});

test("advertises nested skills only after their scope is referenced", async () => {
  const root = await fixture();
  const shadcn = await makeSkill(
    path.join(root, "packages", "ui", ".agents", "skills", "shadcn"),
    "shadcn",
  );
  const database = await makeSkill(
    path.join(root, "packages", "database", ".agents", "skills", "database"),
    "database",
  );
  await writeFile(
    path.join(root, "apps", "web", ".pi", "settings.json"),
    JSON.stringify({ skills: ["../../../packages/ui/.agents/skills"] }),
  );

  const handlers = new Map<string, Array<(event: any) => Promise<any>>>();
  const emitted: Array<{ name: string; data: any }> = [];
  const sentMessages: any[] = [];
  const api = {
    events: { emit(name: string, data: any) { emitted.push({ name, data }); } },
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
    },
    on(name: string, handler: (event: any) => Promise<any>) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
      return () => undefined;
    },
  };
  monorepoSkills(api as any);

  const discover = handlers.get("resources_discover")![0];
  await discover({ cwd: root, reason: "startup" });
  const initial = emitted.filter((event) => event.name === "mypi:skills-changed").at(-1);
  assert.deepEqual(initial?.data.skills, []);

  const before = handlers.get("before_agent_start")![0];
  const event = {
    prompt: "Update apps/web/src/page.ts",
    systemPromptOptions: {
      skills: [
        { name: "shadcn", filePath: await realpath(shadcn) },
        { name: "database", filePath: await realpath(database) },
      ],
    },
  };
  await before(event);

  assert.deepEqual(event.systemPromptOptions.skills.map((skill: any) => skill.name), ["shadcn"]);
  const activated = emitted.filter((item) => item.name === "mypi:skills-changed").at(-1);
  assert.deepEqual(activated?.data.skills.map((skill: any) => skill.name), ["shadcn"]);

  const toolCall = handlers.get("tool_call")![0];
  const result = await toolCall({
    toolName: "read",
    input: { path: "packages/database/schema.ts" },
  });
  assert.equal(result, undefined);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message.content, /database/);
});

test("registers discovered files through resources_discover", async () => {
  const root = await fixture();
  const shadcn = await makeSkill(
    path.join(root, "packages", "ui", ".agents", "skills", "shadcn"),
    "shadcn",
  );
  let handler: ((event: any) => Promise<any>) | undefined;
  const api = {
    events: { emit() {} },
    on(name: string, registered: (event: any) => Promise<any>) {
      if (name === "resources_discover") handler = registered;
      return () => undefined;
    },
  };
  monorepoSkills(api as any);

  const result = await handler!({ cwd: root, reason: "startup" });
  assert.deepEqual(result, { skillPaths: [await realpath(shadcn)] });
});
