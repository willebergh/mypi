import { execFile as nodeExecFile } from "node:child_process";
import { access as nodeAccess } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WebcamLauncherOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  repoRoot?: string;
  agentDir?: string;
  homeDir?: string;
  access?: (path: string) => Promise<void>;
  execFile?: (file: string, args: string[]) => Promise<void>;
}

export interface WebcamLaunchResult {
  appPath: string;
  socketPath: string;
  message: string;
}

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function launchPrebuiltWebcam(options: WebcamLauncherOptions = {}): Promise<WebcamLaunchResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("The prebuilt Talk webcam launcher is supported only on macOS.");

  const arch = options.arch ?? process.arch;
  const appPath = path.resolve(options.repoRoot ?? defaultRoot,
    `extensions/talk/webcam/out/pi-talk-webcam-darwin-${arch}/pi-talk-webcam.app`);
  const executablePath = path.join(appPath, "Contents", "MacOS", "pi-talk-webcam");
  try {
    await (options.access ?? nodeAccess)(appPath);
    await (options.access ?? nodeAccess)(executablePath);
  } catch {
    throw new Error(`Prebuilt Talk webcam app is missing or incomplete at ${appPath}. Build it from the repository with: pnpm --dir extensions/talk/webcam package`);
  }

  const home = options.homeDir ?? homedir();
  const configured = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
  const agentDir = configured === "~" ? home : configured.startsWith("~/") ? path.join(home, configured.slice(2)) : configured;
  const socketPath = path.join(agentDir, "webcam", "hud.sock");
  if (!path.isAbsolute(socketPath)) throw new Error("The webcam HUD needs an absolute Pi agent directory.");
  const execFile = options.execFile ?? ((file, args) => new Promise<void>((resolve, reject) => {
    nodeExecFile(file, args, { timeout: 10_000, maxBuffer: 8192, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  }));
  try {
    // A transient secondary process hands the exact endpoint to Electron's
    // single-instance owner and exits before opening windows/audio. Without -n,
    // LaunchServices ignores new environment for an already-running application.
    await execFile("/usr/bin/open", ["-g", "-n", "-a", appPath,
      "--env", `PI_TALK_HUD_SOCKET=${socketPath}`, "--env", "PI_TALK_LAUNCH_SOURCE=talk"]);
  } catch {
    throw new Error("Could not ask macOS LaunchServices to open the prebuilt Talk webcam app.");
  }
  return { appPath, socketPath, message: "Requested the prebuilt Talk webcam app; its single-instance owner receives this Pi session's HUD endpoint." };
}
