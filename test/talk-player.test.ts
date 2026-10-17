import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { spawn } from "node:child_process";
import { startPlayer } from "../extensions/talk/player.ts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal: string) { this.killed.push(signal); return true; }
}
function setup() {
  const child = new FakeChild();
  let command = "";
  let args: readonly string[] = [];
  const spawnProcess = ((cmd: string, argv: readonly string[]) => {
    command = cmd; args = argv; return child;
  }) as unknown as typeof spawn;
  const errors: Error[] = [];
  const player = startPlayer((error) => errors.push(error), spawnProcess);
  return { child, errors, player, get command() { return command; }, get args() { return args; } };
}

test("spawns SoX playback with raw PCM and streams without persisting it", () => {
  const s = setup();
  assert.equal(s.command, "play");
  assert.deepEqual(s.args, ["-q", "--buffer", "1024", "-t", "raw", "-r", "24000", "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-"]);
  const chunks: Buffer[] = [];
  s.child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  const pcm = Buffer.from([1, 2]);
  s.player.append(pcm);
  assert.deepEqual(Buffer.concat(chunks), pcm);
  assert.equal(s.errors.length, 0);
});

test("rejects payloads beyond the five-second backlog and reports once", () => {
  const s = setup();
  s.child.stdin.cork();
  s.player.append(Buffer.alloc(240_000));
  assert.equal(s.errors.length, 0);
  s.player.append(Buffer.from([0]));
  s.player.append(Buffer.from([0]));
  assert.equal(s.errors.length, 1);
  s.child.emit("close", 1, null);
  assert.equal(s.errors.length, 1);
});

test("stop is idempotent, terminates promptly, and waits for close", async () => {
  const s = setup();
  const first = s.player.stop();
  const second = s.player.stop();
  assert.strictEqual(first, second);
  assert.deepEqual(s.child.killed, ["SIGTERM"]);
  let resolved = false;
  void first.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  s.child.emit("close", 0, null);
  await first;
  assert.equal(resolved, true);
  s.player.append(Buffer.from([1]));
  assert.deepEqual(s.child.killed, ["SIGTERM"]);
});

test("ENOENT is useful and child/stdin errors are safely reported once", async () => {
  const missing = setup();
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  missing.child.emit("error", error);
  assert.match(missing.errors[0].message, /brew install sox/);
  assert.equal(missing.errors.length, 1);
  await missing.player.stop();

  const failed = setup();
  failed.child.stdin.emit("error", new Error("pipe"));
  failed.child.emit("close", 1, null);
  assert.equal(failed.errors.length, 1);
});
