import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const skill = resolve(root, ".pi/skills/setup");
const read = (path: string) => readFile(resolve(root, path), "utf8");

test("setup skill loads through Pi and is explicitly exported by the package", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.ok(manifest.pi.skills.includes("./.pi/skills/setup"));
  const loaded = loadSkillsFromDir({ dir: skill, source: "test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0].name, "setup");
  assert.equal(loaded.skills[0].filePath, resolve(skill, "SKILL.md"));
  assert.match(loaded.skills[0].description, /myPi|mypi/);
});
