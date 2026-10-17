import { spawn } from "node:child_process";

export interface Player {
  append(pcm: Buffer): void;
  stop(): Promise<void>;
}

const MAX_BACKLOG = 240_000;

/** Stream mono PCM16 at 24 kHz to SoX without creating an audio file. */
export function startPlayer(onError: (e: Error) => void, spawnProcess: typeof spawn = spawn): Player {
  const child = spawnProcess("play", [
    "-q", "--buffer", "1024", "-t", "raw", "-r", "24000", "-e", "signed-integer",
    "-b", "16", "-c", "1", "-L", "-",
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stopping = false;
  let closed = false;
  let reported = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void;
  const completion = new Promise<void>((resolve) => { done = resolve; });
  const fail = (message: string) => {
    if (stopping || reported) return;
    reported = true;
    try { onError(new Error(message)); } catch { /* User error handlers must not escape child events. */ }
  };
  child.stdin?.on("error", () => fail("Could not stream audio to SoX playback"));
  child.stderr?.resume();
  child.on("error", (error: NodeJS.ErrnoException) => {
    fail(error.code === "ENOENT"
      ? "Audio playback needs SoX ('play'). Install it with: brew install sox"
      : "Could not start audio playback");
    closed = true;
    clearTimeout(killTimer);
    done();
  });
  child.on("close", () => {
    closed = true;
    clearTimeout(killTimer);
    done();
    fail("Audio playback stopped unexpectedly");
  });
  return {
    append(pcm) {
      if (stopping || closed || reported || pcm.length === 0) return;
      const input = child.stdin;
      if (!input || input.destroyed || input.writableLength + pcm.length > MAX_BACKLOG) {
        fail("Audio playback backlog exceeded 5 seconds");
        return;
      }
      try { input.write(pcm, (error) => { if (error) fail("Could not stream audio to SoX playback"); }); }
      catch { fail("Could not stream audio to SoX playback"); }
    },
    stop() {
      if (!stopping && !closed) {
        stopping = true;
        try { child.kill("SIGTERM"); } catch { /* Wait for close/error regardless. */ }
        killTimer = setTimeout(() => { if (!closed) { try { child.kill("SIGKILL"); } catch { /* Safe during shutdown. */ } } }, 1_000);
      }
      return completion;
    },
  };
}
