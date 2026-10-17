#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_NAME = "Pi FaceTime Bridge.app";
export const BUNDLE_ID = "dev.mypi.facetime-bridge";
const root = fileURLToPath(new URL("../", import.meta.url));
export const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Pi FaceTime Bridge</string>
  <key>CFBundleDisplayName</key><string>Pi FaceTime Bridge</string>
  <key>CFBundleExecutable</key><string>facetime-observer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw new Error(`Could not run ${command}. Install Xcode command-line tools manually; nothing is installed automatically.`);
  if (result.status !== 0) throw new Error(`${basename(command)} failed (exit ${result.status ?? result.signal}). ${result.stderr?.trim() ?? "Check the diagnostics above."}`);
  return result.stdout ?? "";
}
async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

/** lsof checks mapped executables too; never terminate a process to install. */
export function assertExecutableStopped(path, spawn = spawnSync) {
  const result = spawn("/usr/sbin/lsof", ["-t", "--", path], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1) || (result.status === 1 && result.stderr?.trim())) throw new Error("Could not check whether the FaceTime helper is running; quit it before rebuilding and check lsof is available.");
  if (result.status === 0 && result.stdout?.trim()) throw new Error("FaceTime helper is running. Quit its app/CLI service before rebuilding or replacing it; no process was stopped.");
}

/** Assemble/sign/verify before replacing a previous bundle. Never launch it. */
export async function packageFaceTimeApp({ binary, destination, identity = "-", execute = run, checkStopped = assertExecutableStopped }) {
  destination = resolve(destination);
  if (basename(destination) !== APP_NAME) throw new Error(`App destination must end in ${APP_NAME}`);
  const executable = join(destination, "Contents", "MacOS", "facetime-observer");
  const original = await exists(destination);
  if (original) {
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("Refusing to replace a non-directory or symlinked app destination");
    const previousInfo = await readFile(join(destination, "Contents", "Info.plist"), "utf8");
    if (!previousInfo.includes(`<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>`)) throw new Error("Refusing to replace an app with an unknown bundle identity");
    checkStopped(executable);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const temporary = join(dirname(destination), `.Pi FaceTime Bridge.build-${token}.app`);
  const backup = join(dirname(destination), `.Pi FaceTime Bridge.previous-${token}.app`);
  let backedUp = false;
  let installed = false;
  try {
    await mkdir(join(temporary, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(temporary, "Contents", "Info.plist"), infoPlist);
    await copyFile(binary, join(temporary, "Contents", "MacOS", "facetime-observer"));
    await chmod(join(temporary, "Contents", "MacOS", "facetime-observer"), 0o755);
    execute("/usr/bin/plutil", ["-lint", join(temporary, "Contents", "Info.plist")]);
    execute("/usr/bin/codesign", ["--force", "--sign", identity, "--identifier", BUNDLE_ID, "--timestamp=none", temporary]);
    execute("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", temporary]);
    if (original) {
      checkStopped(executable); // Recheck immediately before replacement.
      await rename(destination, backup);
      backedUp = true;
    } else if (await exists(destination)) throw new Error("App destination appeared during build; retry after checking it");
    try { await rename(temporary, destination); installed = true; }
    catch (error) {
      if (backedUp) { await rename(backup, destination); backedUp = false; }
      throw error;
    }
    if (backedUp) { await rm(backup, { recursive: true }); backedUp = false; }
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    // Keep a backup for manual recovery if restoring/replacing failed.
    if (backedUp && !installed) console.error(`Previous app preserved at ${backup}`);
  }
}

export async function buildFaceTimeApp({ install = false, identity = "-", scratchPath, projectRoot = root, home = homedir(), platform = process.platform, execute = run, checkStopped = assertExecutableStopped } = {}) {
  if (platform !== "darwin") throw new Error("The FaceTime bridge app requires macOS");
  const packagePath = join(projectRoot, "extensions", "talk", "facetime");
  const common = ["--package-path", packagePath, "-c", "release", ...(scratchPath ? ["--scratch-path", resolve(scratchPath)] : [])];
  const binPath = execute("/usr/bin/swift", ["build", ...common, "--show-bin-path"]).trim();
  if (!binPath || !binPath.startsWith("/")) throw new Error("Swift did not return an absolute release binary path");
  const binary = join(binPath, "facetime-observer");
  const staged = join(packagePath, ".build", APP_NAME);
  const destination = join(home, "Applications", APP_NAME);
  // Avoid overwriting either a running CLI binary or a running bundled app.
  for (const path of [binary, join(staged, "Contents", "MacOS", "facetime-observer"), ...(install ? [join(destination, "Contents", "MacOS", "facetime-observer")] : [])]) {
    if (await exists(path)) checkStopped(path);
  }
  console.log("Building Swift FaceTime helper and locally signed app…");
  execute("/usr/bin/swift", ["build", ...common], { stdio: "inherit" });
  await packageFaceTimeApp({ binary, destination: staged, identity, execute, checkStopped });
  console.log(`Built app: ${staged}`);
  if (install) {
    await packageFaceTimeApp({ binary, destination, identity, execute, checkStopped });
    console.log(`Installed app: ${destination}`);
    console.log(`Open through macOS LaunchServices: open '${destination.replace(/'/g, "'\\''")}'`);
  }
  console.log("No app was launched and no Accessibility permissions were requested or changed.");
  console.log("Ad-hoc signing needs no developer account; changed builds may require a fresh manual Accessibility grant.");
  return install ? destination : staged;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/build-talk-facetime.mjs [--install] [--identity ID] [--scratch-path PATH]\n\nBuild Swift CLI + Pi FaceTime Bridge.app, ad-hoc signed by default.\n--install       Also install under ~/Applications (never launches or prompts)\n--identity ID   Optional local signing identity; default '-' needs no certificate\n--scratch-path  Separate Swift build cache (useful while an older CLI remains running)");
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--install") options.install = true;
    else if (["--identity", "--scratch-path"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) {
      options[args[i] === "--identity" ? "identity" : "scratchPath"] = args[++i];
    } else throw new Error("Unknown or missing argument; use --help");
  }
  await buildFaceTimeApp(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`FaceTime app build: ${error.message}`); process.exitCode = 1; });
}
