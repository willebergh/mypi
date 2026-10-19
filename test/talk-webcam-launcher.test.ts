import assert from "node:assert/strict";
import test from "node:test";
import { launchPrebuiltWebcam } from "../extensions/talk/webcam-launcher.ts";

const ok = async () => {};

test("launches prebuilt app in background with explicit socket path and no shell", async () => {
  const calls: { file: string; args: string[] }[] = [];
  const result = await launchPrebuiltWebcam({
    repoRoot: "/repo with spaces", platform: "darwin", arch: "arm64", agentDir: "/agent dir",
    access: ok,
    execFile: async (file, args) => { calls.push({ file, args }); },
  });
  const appPath = "/repo with spaces/extensions/talk/webcam/out/pi-talk-webcam-darwin-arm64/pi-talk-webcam.app";
  assert.equal(result.appPath, appPath);
  assert.equal(result.socketPath, "/agent dir/webcam/hud.sock");
  assert.deepEqual(calls, [{ file: "/usr/bin/open", args: ["-g", "-n", "-a", appPath, "--env", "PI_TALK_HUD_SOCKET=/agent dir/webcam/hud.sock", "--env", "PI_TALK_LAUNCH_SOURCE=talk"] }]);
});

test("rejects non-macOS before touching the app", async () => {
  let accessed = false;
  await assert.rejects(launchPrebuiltWebcam({ platform: "linux", access: async () => { accessed = true; } }), /only on macOS/);
  assert.equal(accessed, false);
});

test("reports a bounded build hint for a missing or incomplete prebuilt", async () => {
  await assert.rejects(launchPrebuiltWebcam({
    platform: "darwin", repoRoot: "/repo", access: async (target) => {
      if (target.endsWith("/Contents/MacOS/pi-talk-webcam")) throw new Error("private path detail");
    }, execFile: async () => assert.fail("must not launch"),
  }), (error: Error) => {
    assert.match(error.message, /pnpm --dir extensions\/talk\/webcam package/);
    assert.match(error.message, /pi-talk-webcam\.app/);
    assert.doesNotMatch(error.message, /private path detail/);
    return true;
  });
});

test("sanitizes LaunchServices errors", async () => {
  await assert.rejects(launchPrebuiltWebcam({
    platform: "darwin", repoRoot: "/repo", access: ok,
    execFile: async () => { throw new Error("secret token"); },
  }), (error: Error) => {
    assert.match(error.message, /LaunchServices/);
    assert.doesNotMatch(error.message, /secret token/);
    return true;
  });
});

test("tilde agent directories expand like Pi and relative directories fail clearly", async () => {
  const options = { platform: "darwin" as const, repoRoot: "/repo", homeDir: "/home/test", access: ok,
    execFile: async () => {} };
  assert.equal((await launchPrebuiltWebcam({ ...options, agentDir: "~/custom-agent" })).socketPath,
    "/home/test/custom-agent/webcam/hud.sock");
  await assert.rejects(launchPrebuiltWebcam({ ...options, agentDir: "relative" }), /absolute Pi agent directory/);
});

test("repeated requests are safe LaunchServices open requests", async () => {
  const calls: string[][] = [];
  const options = { platform: "darwin" as const, repoRoot: "/repo", access: ok,
    execFile: async (_file: string, args: string[]) => { calls.push(args); } };
  const first = await launchPrebuiltWebcam(options);
  const second = await launchPrebuiltWebcam(options);
  assert.deepEqual(first, second);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => args[0] === "-g" && args[1] === "-n" && args[2] === "-a"));
});
