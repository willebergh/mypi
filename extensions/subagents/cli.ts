import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

interface CliResolutionOptions {
  sdkVersion?: string;
  packageDir?: string;
  managedRoot?: string;
}

/** A child CLI must match the host RPC client, including after an installation moves. */
export function resolvePiCli(
  entrypoint = process.argv[1],
  moduleUrl = import.meta.resolve(PACKAGE_NAME),
  options: CliResolutionOptions = {},
): string {
  const sdkVersion = options.sdkVersion ?? VERSION;
  const packageDir = options.packageDir ?? getPackageDir();
  const managedRoot = options.managedRoot ?? process.env.PI_MANAGED_INSTALL_ROOT
    ?? path.join(getAgentDir(), "install");
  const candidates = [entrypoint, path.join(packageDir, "package.json")];
  const currentVersionFile = path.join(managedRoot, "current-version");
  if (existsSync(currentVersionFile)) {
    const version = readFileSync(currentVersionFile, "utf8").trim();
    if (/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version)) {
      candidates.push(path.join(managedRoot, "releases", version, "node_modules",
        "@earendil-works", "pi-coding-agent", "package.json"));
    }
  }
  candidates.push(fileURLToPath(moduleUrl));
  const mismatches = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    let directory = path.dirname(realpathSync(candidate));
    while (true) {
      const manifestPath = path.join(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.name === PACKAGE_NAME && manifest.version !== sdkVersion) {
          mismatches.add(String(manifest.version));
        }
        if (manifest.name === PACKAGE_NAME && manifest.version === sdkVersion) {
          const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
          if (typeof bin === "string") {
            const cli = path.resolve(directory, bin);
            if (existsSync(cli)) return cli;
          }
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const found = mismatches.size ? ` Found incompatible versions: ${[...mismatches].join(", ")}.` : "";
  throw new Error(`Cannot locate Pi's CLI matching RPC client ${sdkVersion}.${found} Restart Pi after updating; align the local SDK if needed.`);
}
