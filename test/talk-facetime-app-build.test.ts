import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
// @ts-expect-error Standalone development build script is intentionally JavaScript.
import { APP_NAME, BUNDLE_ID, infoPlist, assertExecutableStopped, packageFaceTimeApp, buildFaceTimeApp } from "../scripts/build-talk-facetime.mjs";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "facetime-app-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "binary");
  await writeFile(binary, "synthetic executable");
  return { root, binary, destination: join(root, "applications", APP_NAME) };
}

test("app metadata has fixed identity and no microphone or automation entitlements", () => {
  assert.equal(BUNDLE_ID, "dev.mypi.facetime-bridge");
  assert.ok(infoPlist.includes(`<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>`));
  assert.match(infoPlist, /CFBundleExecutable<\/key><string>facetime-observer/);
  assert.match(infoPlist, /LSUIElement<\/key><true\/>/);
  assert.match(infoPlist, /LSMultipleInstancesProhibited<\/key><true\/>/);
  assert.doesNotMatch(infoPlist, /MicrophoneUsage|AppleEventsUsage|sandbox|entitlement/);
});

test("packaging creates, ad-hoc signs and verifies an app without launching or requesting permissions", async (t) => {
  const { root, binary, destination } = await fixture(t);
  const commands: { command: string; args: string[] }[] = [];
  const execute = (command: string, args: string[]) => { commands.push({ command, args }); return ""; };
  await packageFaceTimeApp({ binary, destination, execute, checkStopped() {} });
  assert.equal(await readFile(join(destination, "Contents", "Info.plist"), "utf8"), infoPlist);
  assert.equal(await readFile(join(destination, "Contents", "MacOS", "facetime-observer"), "utf8"), "synthetic executable");
  assert.equal((await stat(join(destination, "Contents", "MacOS", "facetime-observer"))).mode & 0o777, 0o755);
  assert.deepEqual(commands.map(call => call.command), ["/usr/bin/plutil", "/usr/bin/codesign", "/usr/bin/codesign"]);
  assert.deepEqual(commands[1].args.slice(0, 6), ["--force", "--sign", "-", "--identifier", BUNDLE_ID, "--timestamp=none"]);
  assert.ok(commands[2].args.includes("--verify"));
  assert.deepEqual(await readdir(dirname(destination)), [APP_NAME]);
  assert.ok(!commands.some(call => /open|tccutil|osascript/.test(call.command)));
  await packageFaceTimeApp({ binary, destination, execute, checkStopped() {} });
  assert.deepEqual(await readdir(dirname(destination)), [APP_NAME]);
  assert.ok((await readdir(root)).includes("binary"));
});

test("failed signing preserves an installed app and cleans temporary bundles", async (t) => {
  const { binary, destination } = await fixture(t);
  await packageFaceTimeApp({ binary, destination, execute() {}, checkStopped() {} });
  await writeFile(binary, "replacement");
  await assert.rejects(packageFaceTimeApp({ binary, destination, checkStopped() {}, execute(command: string) {
    if (command.endsWith("codesign")) throw new Error("synthetic signing failure");
  } }), /signing failure/);
  assert.equal(await readFile(join(destination, "Contents", "MacOS", "facetime-observer"), "utf8"), "synthetic executable");
  assert.deepEqual(await readdir(dirname(destination)), [APP_NAME]);
});

test("running apps, unrelated destinations, and symlinks are not replaced", async (t) => {
  const { root, binary, destination } = await fixture(t);
  await packageFaceTimeApp({ binary, destination, execute() {}, checkStopped() {} });
  await assert.rejects(packageFaceTimeApp({ binary, destination, execute() {}, checkStopped() { throw new Error("running"); } }), /running/);
  await writeFile(join(destination, "Contents", "Info.plist"), "unrelated app");
  await assert.rejects(packageFaceTimeApp({ binary, destination, execute() {}, checkStopped() {} }), /unknown bundle/);
  const linked = join(root, "linked", APP_NAME);
  await mkdir(dirname(linked)); await symlink(destination, linked);
  await assert.rejects(packageFaceTimeApp({ binary, destination: linked, execute() {}, checkStopped() {} }), /symlinked/);
});

test("running executable detection fails closed without killing anything", () => {
  const calls: string[] = [];
  assert.doesNotThrow(() => assertExecutableStopped("/binary", (command: string) => { calls.push(command); return { status: 1 }; }));
  assert.throws(() => assertExecutableStopped("/binary", () => ({ status: 0, stdout: "123\n" })), /running/);
  assert.throws(() => assertExecutableStopped("/binary", () => ({ status: 2 })), /Could not check/);
  assert.throws(() => assertExecutableStopped("/binary", () => ({ status: 1, stderr: "permission denied" })), /Could not check/);
  assert.throws(() => assertExecutableStopped("/binary", () => ({ error: new Error("missing") })), /Could not check/);
  assert.deepEqual(calls, ["/usr/sbin/lsof"]);
});

test("a running CLI prevents the build before its executable can be replaced", async (t) => {
  const { root, binary } = await fixture(t);
  const binPath = join(root, "products");
  await mkdir(binPath); await writeFile(join(binPath, "facetime-observer"), await readFile(binary));
  const commands: string[][] = [];
  await assert.rejects(buildFaceTimeApp({ projectRoot: root, platform: "darwin", checkStopped() { throw new Error("running CLI"); },
    execute(_command: string, args: string[]) { commands.push(args); return binPath; },
  }), /running CLI/);
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("--show-bin-path"), "only discovery, no actual Swift compilation");
});

test("build/install uses argument arrays, a stable user app path, and no launch command", async (t) => {
  const { root } = await fixture(t);
  const binaryDirectory = join(root, "products");
  await mkdir(binaryDirectory); await writeFile(join(binaryDirectory, "facetime-observer"), "synthetic executable");
  const commands: { command: string; args: string[] }[] = [];
  const path = await buildFaceTimeApp({ projectRoot: root, home: join(root, "home"), platform: "darwin", install: true,
    identity: "Local developer identity", scratchPath: join(root, "cache with spaces"), checkStopped() {},
    execute(command: string, args: string[]) { commands.push({ command, args }); return args.includes("--show-bin-path") ? binaryDirectory + "\n" : ""; },
  });
  assert.equal(path, join(root, "home", "Applications", APP_NAME));
  assert.equal(await readFile(join(path, "Contents", "Info.plist"), "utf8"), infoPlist);
  assert.ok(commands[0].args.includes("--scratch-path"));
  assert.ok(commands.some(call => call.args.includes("Local developer identity")));
  assert.ok(!commands.some(call => /open|tccutil|osascript|security/.test(call.command)));
  await assert.rejects(buildFaceTimeApp({ platform: "linux" }), /requires macOS/);
});
