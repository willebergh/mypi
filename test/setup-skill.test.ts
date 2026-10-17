import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
  assert.ok(!Object.keys(manifest.scripts).some(name => /^(talk|probe):/.test(name)));
});

test("only the Talk monitor and context filter remain as standalone scripts", async () => {
  assert.deepEqual((await readdir(resolve(root, "scripts"))).sort(), ["talk-context.jq", "talk-monitor.mjs"]);
});

test("setup instructions link existing references/app metadata without hidden installer scripts", async () => {
  for (const relative of ["SKILL.md", "references/native-talk.md", "references/facetime-app.md"]) {
    const path = resolve(skill, relative);
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^https?:/.test(link)) continue;
      await access(resolve(dirname(path), link.split("#")[0]));
    }
  }
  const files = await readdir(skill, { recursive: true });
  assert.ok(!files.some(path => /\.(?:sh|mjs|js|ts)$/.test(path)), "setup is instructions, not relocated executable build scripts");
});

test("documented build blocks parse without executing builds or touching the machine", async () => {
  for (const relative of ["references/native-talk.md", "references/facetime-app.md"]) {
    const text = await readFile(resolve(skill, relative), "utf8");
    const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)];
    assert.equal(blocks.length, 1);
    const env = { ...process.env };
    delete env.BASH_ENV;
    delete env.ENV;
    const result = spawnSync("bash", ["-n"], { input: blocks[0][1], encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("build guidance retains static Opus, running-executable guards and verified staged replacement", async () => {
  const native = await readFile(resolve(skill, "references/native-talk.md"), "utf8");
  assert.match(native, /cargo build --release --locked/);
  assert.match(native, /OPUS_STATIC=1/);
  assert.match(native, /libopus\.a/);
  assert.match(native, /lipo -archs/);
  const app = await readFile(resolve(skill, "references/facetime-app.md"), "utf8");
  assert.match(app, /lsof -t/);
  assert.match(app, /Refusing non-directory or symlinked app/);
  assert.match(app, /Refusing unrelated app identity/);
  assert.match(app, /mv "\$APP" "\$BACKUP"/);
  assert.ok(app.indexOf('codesign --verify --strict --verbose=2 "$STAGED"') < app.indexOf('mv "$APP" "$BACKUP"'));
  assert.match(app, /No app was launched or permissions requested/);
});

test("app metadata preserves Swift identity and needs no microphone/automation entitlements", async () => {
  const plist = await read("extensions/talk/facetime/Info.plist");
  const application = await read("extensions/talk/facetime/Sources/FaceTimeObserver/Application.swift");
  const identifier = application.match(/let bridgeBundleIdentifier = "([^"]+)"/)![1];
  const executable = application.match(/let bridgeExecutableName = "([^"]+)"/)![1];
  assert.ok(plist.includes(`<key>CFBundleIdentifier</key><string>${identifier}</string>`));
  assert.ok(plist.includes(`<key>CFBundleExecutable</key><string>${executable}</string>`));
  assert.match(plist, /LSUIElement<\/key><true\/>/);
  assert.match(plist, /LSMultipleInstancesProhibited<\/key><true\/>/);
  assert.doesNotMatch(plist, /MicrophoneUsage|AppleEventsUsage|sandbox|entitlement/);
});
