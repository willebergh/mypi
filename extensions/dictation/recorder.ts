import { spawn } from "node:child_process";

export interface Recorder {
  stop(): Promise<void>;
}

/** Stream mono PCM16 at 24 kHz; no audio files are written. */
export function startRecorder(
  onAudio: (pcm: Buffer) => void,
  onError: (error: Error) => void,
  spawnProcess: typeof spawn = spawn,
): Recorder {
  const child = spawnProcess("rec", [
    "-q", "--buffer", "1024", "-t", "raw", "-r", "24000", "-e", "signed-integer",
    "-b", "16", "-c", "1", "-L", "-",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stopping = false;
  let closed = false;
  let reported = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let done!: () => void;
  const completion = new Promise<void>((resolve) => { done = resolve; });
  const fail = (message: string) => {
    if (stopping || reported) return;
    reported = true;
    onError(new Error(message));
  };
  child.stdout?.on("data", (pcm: Buffer) => {
    try { onAudio(pcm); }
    catch { fail("Could not stream microphone audio"); }
  });
  // Drain diagnostics without printing them into Pi's terminal or retaining audio.
  child.stderr?.resume();
  child.on("error", (error: NodeJS.ErrnoException) => {
    fail(error.code === "ENOENT"
      ? "Microphone capture needs SoX ('rec'). Install it with: brew install sox"
      : "Could not start microphone capture");
    closed = true;
    clearTimeout(killTimer);
    done();
  });
  child.on("close", () => {
    closed = true;
    clearTimeout(killTimer);
    done();
    fail("Microphone capture stopped unexpectedly. Check your default input device and terminal microphone permission.");
  });
  return {
    stop() {
      if (!closed && !stopping) {
        stopping = true;
        child.kill("SIGINT");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      }
      return completion;
    },
  };
}
