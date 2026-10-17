#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const native = fileURLToPath(new URL("../extensions/talk/native/", import.meta.url));

function probe(command, args, env) {
  return spawnSync(command, args, { cwd: native, env, encoding: "utf8" });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("The talk native helper requires macOS (CoreAudio).");
  if (!["arm64", "x64"].includes(process.arch)) throw new Error(`Unsupported macOS architecture: ${process.arch}`);
  const env = { ...process.env };
  // The checked-in rustup file, not a caller's toolchain override, selects Rust.
  delete env.RUSTUP_TOOLCHAIN;
  const toolchain = (await readFile(join(native, "rust-toolchain.toml"), "utf8")).match(/channel\s*=\s*"([^"]+)"/)?.[1];
  if (!toolchain) throw new Error("Missing channel in native/rust-toolchain.toml.");
  const installed = probe("rustup", ["toolchain", "list"], env);
  if (installed.error || installed.status !== 0) throw new Error("rustup is required. Install the pinned Rust toolchain manually; this script installs nothing.");
  if (!installed.stdout.split("\n").some(line => line.startsWith(`${toolchain}-`))) {
    throw new Error(`Rust ${toolchain} is not installed. Install it manually with rustup toolchain install ${toolchain} --profile minimal.`);
  }
  const version = probe("cargo", ["--version"], env);
  if (version.status !== 0 || !version.stdout.startsWith(`cargo ${toolchain} `)) {
    throw new Error(`Put rustup's cargo proxy on PATH so native/rust-toolchain.toml selects Rust ${toolchain}.`);
  }
  // Prefer an installed Opus over audiopus_sys's CMake source-build fallback.
  if (probe("pkg-config", ["--exists", "opus"], env).status !== 0) {
    const brew = probe("brew", ["--prefix", "opus"], env);
    const prefixes = [brew.status === 0 ? brew.stdout.trim() : "", "/opt/homebrew/opt/opus", "/usr/local/opt/opus"];
    for (const prefix of prefixes) {
      if (!prefix || !existsSync(join(prefix, "lib/pkgconfig/opus.pc"))) continue;
      env.PKG_CONFIG_PATH = [join(prefix, "lib/pkgconfig"), env.PKG_CONFIG_PATH].filter(Boolean).join(delimiter);
      if (probe("pkg-config", ["--exists", "opus"], env).status === 0) break;
    }
  }
  const opus = probe("pkg-config", ["--modversion", "opus"], env);
  if (opus.status !== 0) throw new Error("Opus and pkg-config are required (optional Homebrew: brew install opus pkg-config). No CMake fallback or automatic installation is performed.");
  const libdir = probe("pkg-config", ["--variable=libdir", "opus"], env);
  if (libdir.status !== 0 || !existsSync(join(libdir.stdout.trim(), "libopus.a"))) {
    throw new Error("The installed Opus must include libopus.a for static linking. Install a static Opus build manually.");
  }
  // Do not let inherited bypass flags force audiopus_sys into its CMake fallback.
  delete env.LIBOPUS_NO_PKG;
  delete env.OPUS_NO_PKG;
  delete env.OPUS_NO_PKG_CONFIG;
  env.OPUS_STATIC = "1";
  // Keep output predictable even if the calling project overrides Cargo's target.
  env.CARGO_TARGET_DIR = join(native, "target");
  delete env.CARGO_BUILD_TARGET;
  console.log(`Building talk helper: ${version.stdout.trim()}, Opus ${opus.stdout.trim()}, darwin-${process.arch}`);
  const result = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: native, env, stdio: "inherit" });
  if (result.error) throw new Error(`Could not start cargo: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Cargo build failed${result.signal ? ` (${result.signal})` : ` (exit ${result.status})`}. Check the diagnostics above and your Xcode SDK (xcrun --show-sdk-path).`);
  const directory = join(native, "bin", `darwin-${process.arch}`);
  const artifact = join(directory, "pi-codex-voice");
  await mkdir(directory, { recursive: true });
  await copyFile(join(native, "target/release/pi-codex-voice"), artifact);
  await chmod(artifact, 0o755);
  console.log(`Built local helper: ${artifact}`);
}

main().catch(error => {
  console.error(`Talk native build: ${error.message}`);
  process.exitCode = 1;
});
