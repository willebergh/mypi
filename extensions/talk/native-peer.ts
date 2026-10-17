import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { PeerCallbacks, RtcPeer } from "./peer.ts";
import { parseNativeAudioDevices, validateNativeAudioSelection, type NativeAudioDevices, type NativeAudioSelection } from "./native-devices.ts";
export type { NativeAudioDevice, NativeAudioDevices, NativeAudioSelection } from "./native-devices.ts";

export interface NativePeerOptions extends NativeAudioSelection {
  /** Default true. False queues both audio gates before any answer can be applied. */
  initialAudioEnabled?: boolean;
  binary?: string;
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
}

type NativeProcessOptions = Pick<NativePeerOptions, "binary" | "spawnProcess" | "platform">;

const KiB = 1024;
const LINE_LIMIT = 512 * KiB;
const SDP_LIMIT = 256 * KiB;

function validSdp(value: unknown): value is string {
  return typeof value === "string" && /^v=0(?:\r?\n|$)/.test(value)
    && Buffer.byteLength(value) <= SDP_LIMIT;
}

function safe(callback: () => void) {
  try { callback(); } catch { /* Consumer exceptions must not escape process handlers. */ }
}

/** One helper per call. Only SDP/control data cross IPC, never the Codex OAuth token. */
export async function createNativePeer(
  callbacks: PeerCallbacks,
  signal: AbortSignal,
  options: NativePeerOptions = {},
): Promise<RtcPeer> {
  return runNativeHelper(callbacks, signal, options, false);
}

/** Enumerate without opening microphone streams or starting WebRTC; reap before settling. */
export async function listNativeDevices(
  signal: AbortSignal,
  options: NativeProcessOptions = {},
): Promise<NativeAudioDevices> {
  return runNativeHelper({ onEvent() {}, onReady() {}, onError() {}, onClosed() {} }, signal, options, true);
}

function runNativeHelper(callbacks: PeerCallbacks, signal: AbortSignal, options: NativePeerOptions, discovery: false): Promise<RtcPeer>;
function runNativeHelper(callbacks: PeerCallbacks, signal: AbortSignal, options: NativeProcessOptions, discovery: true): Promise<NativeAudioDevices>;
async function runNativeHelper(
  callbacks: PeerCallbacks,
  signal: AbortSignal,
  options: NativePeerOptions,
  discovery: boolean,
): Promise<RtcPeer | NativeAudioDevices> {
  if (signal.aborted) throw new Error("Native audio aborted");
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Native audio is only supported on macOS");
  }
  const selection = discovery ? {} : validateNativeAudioSelection(options);
  const initialAudioEnabled = options.initialAudioEnabled === undefined ? true : options.initialAudioEnabled;
  if (!discovery && typeof initialAudioEnabled !== "boolean") throw new Error("Invalid native initial audio gate");
  const binary = options.binary ?? fileURLToPath(new URL(
    `./native/bin/darwin-${process.arch}/pi-codex-voice`, import.meta.url,
  ));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnProcess ?? spawn)(binary, [], { stdio: ["pipe", "pipe", "pipe"], env }) as ChildProcessWithoutNullStreams;
  } catch {
    const error = new Error("Could not launch native audio helper. Run npm run talk:build in the mypi package first");
    safe(() => callbacks.onError(error));
    safe(() => callbacks.onClosed());
    throw error;
  }

  let stopped = false;
  let reaped = false;
  let launched = false;
  let offered = false;
  let answered = false;
  let ready = false;
  let audioEnabled = true;
  let speakerEpoch = 0;
  let errorNotified = false;
  let devices: NativeAudioDevices | undefined;
  let closing: Promise<void> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveLaunch!: () => void;
  let rejectLaunch!: (error: Error) => void;
  const launch = new Promise<void>((resolve, reject) => { resolveLaunch = resolve; rejectLaunch = reject; });
  let resolveOffer!: (sdp: string) => void;
  let rejectOffer!: (error: Error) => void;
  const offer = new Promise<string>((resolve, reject) => { resolveOffer = resolve; rejectOffer = reject; });
  void offer.catch(() => {});
  let resolveReaped!: () => void;
  const didReap = new Promise<void>((resolve) => { resolveReaped = resolve; });
  const launchTimer = setTimeout(() => fail("Native audio helper startup timed out"), 5_000);

  function fail(message: string) {
    if (stopped) return;
    const error = new Error(message);
    rejectLaunch(error);
    rejectOffer(error);
    // Mark terminal before calling user code, which may reenter close().
    void close();
    if (!errorNotified) {
      errorNotified = true;
      safe(() => callbacks.onError(error));
    }
  }

  function write(command: unknown, limit = 64 * KiB) {
    if (stopped) throw new Error("Native audio peer is closed");
    let line: string;
    try { line = `${JSON.stringify(command)}\n`; }
    catch { throw new Error("Could not encode native audio command"); }
    if (Buffer.byteLength(line) > limit) throw new Error("Native audio command exceeds size limit");
    if (!child.stdin.writable || child.stdin.writableLength + Buffer.byteLength(line) > LINE_LIMIT) {
      fail("Native audio input queue is unavailable or full");
      throw new Error("Native audio input queue is unavailable or full");
    }
    try {
      child.stdin.write(line, (error) => { if (error) fail("Native audio input failed"); });
    } catch {
      fail("Native audio input failed");
      throw new Error("Native audio input failed");
    }
  }

  function setAudioEnabled(enabled: boolean) {
    if (stopped) throw new Error("Native audio peer is closed");
    try {
      if (typeof enabled !== "boolean") throw new Error("Invalid native audio gate");
      if (enabled === audioEnabled) return;
      const epoch = speakerEpoch + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error("Native audio speaker epoch exhausted");
      write({ type: "set_input_muted", muted: !enabled });
      write({ type: "set_speaker_suppressed", suppressed: !enabled, epoch });
      if (stopped) throw new Error("Native audio peer is closed");
      audioEnabled = enabled;
      speakerEpoch = epoch;
    } catch (error) {
      // A partial gate must never leave a usable, potentially audible peer.
      fail("Native audio gate failed");
      throw error;
    }
  }

  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    clearTimeout(launchTimer);
    clearTimeout(offerTimer);
    signal.removeEventListener("abort", abort);
    const error = new Error("Native audio peer closed");
    rejectLaunch(error);
    rejectOffer(error);
    closing = didReap;
    if (reaped) return closing;
    // Never wait for a stopped acknowledgement: shutdown exits the process.
    shutdownTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* Still wait for close. */ }
      if (reaped) return;
      shutdownTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* close is the only reaping signal. */ }
      }, 1_000);
    }, 1_500);
    try {
      if (child.stdin.writable) {
        if (child.stdin.writableLength + 20 <= LINE_LIMIT) child.stdin.write('{"type":"shutdown"}\n', () => {});
        child.stdin.end();
      }
    } catch { /* EPIPE during shutdown is expected; escalation still runs. */ }
    return closing;
  }
  function abort() { void close(); }

  function event(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const message = value as Record<string, unknown>;
    if (typeof message.type !== "string") throw new Error();
    if (message.type === "error") {
      // Classify only; never echo helper text, which can contain SDP or secrets.
      const permission = typeof message.message === "string" && /permission|denied|not authorized/i.test(message.message);
      fail(permission
        ? "Native audio microphone access denied. Enable microphone access for your terminal in System Settings > Privacy & Security > Microphone."
        : "Native audio helper reported an audio error");
      return;
    }
    if (!launched) {
      if (message.type !== "ready" || message.version !== 6) throw new Error();
      launched = true;
      clearTimeout(launchTimer);
      write(discovery ? { type: "list_devices" } : { type: "start_v3", ...selection });
      // Rust awaits start_v3 creation before reading the next stdin command.
      // Queue gates now, not after the offer/answer round trip can connect audio.
      if (!discovery) setAudioEnabled(initialAudioEnabled);
      offerTimer = setTimeout(() => fail(discovery ? "Native audio device discovery timed out" : "Native audio offer timed out"), discovery ? 5_000 : 15_000);
      if (!discovery) resolveLaunch();
      return;
    }
    if (discovery) {
      if (message.type !== "devices") throw new Error();
      devices = parseNativeAudioDevices(message);
      resolveLaunch();
      void close();
      return;
    }
    switch (message.type) {
      case "offer":
        if (offered || !validSdp(message.sdp)) throw new Error();
        offered = true;
        clearTimeout(offerTimer);
        resolveOffer(message.sdp);
        break;
      case "state":
        if (typeof message.state !== "string") throw new Error();
        if (["failed", "disconnected", "closed"].includes(message.state)) {
          fail("Native audio connection closed unexpectedly");
        } else if (answered && !ready && ["ready", "listening"].includes(message.state)) {
          ready = true;
          safe(() => callbacks.onReady());
        }
        break;
      // Normal native speaker diagnostics, not signaling messages or failures.
      case "playback_activity":
      case "playout_stats":
        break;
      case "data":
        if (!("message" in message) || Buffer.byteLength(JSON.stringify(message.message)) > 64 * KiB) throw new Error();
        if (answered) safe(() => callbacks.onEvent(message.message));
        break;
      default: throw new Error();
    }
  }

  // Scan bytes BEFORE decoding/concatenating: one huge chunk or many short lines
  // cannot bypass the per-line bound. StringDecoder preserves split UTF-8.
  let decoder = new StringDecoder("utf8");
  let line = "";
  let lineBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopped) return;
    let start = 0;
    while (start < chunk.length && !stopped) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const size = end - start;
      if (lineBytes + size > LINE_LIMIT) { fail("Native audio event exceeds size limit"); return; }
      lineBytes += size;
      line += decoder.write(chunk.subarray(start, end));
      if (newline !== -1) {
        line += decoder.end();
        try { event(JSON.parse(line)); }
        catch { fail("Invalid native audio helper protocol (requires version 6)"); }
        line = "";
        lineBytes = 0;
        decoder = new StringDecoder("utf8");
      }
      start = newline === -1 ? chunk.length : newline + 1;
    }
  });
  child.stdout.on("end", () => {
    if (!stopped) fail(lineBytes ? "Incomplete native audio helper protocol" : "Native audio output closed unexpectedly");
  });
  child.stdout.on("error", () => fail("Native audio output failed"));
  // Drain immediately, retaining no raw diagnostics at all.
  child.stderr.on("data", () => {});
  child.stderr.on("error", () => fail("Native audio diagnostics stream failed"));
  child.stdin.on("error", () => fail("Native audio input failed"));
  child.on("error", () => fail("Could not launch or run native audio helper. Run npm run talk:build in the mypi package first"));
  child.once("close", () => {
    reaped = true;
    clearTimeout(shutdownTimer);
    if (!stopped) fail("Native audio helper exited unexpectedly");
    resolveReaped();
    safe(() => callbacks.onClosed());
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  try {
    await launch;
    if (discovery && devices) {
      await close();
      return devices;
    }
    if (stopped) throw new Error("Native audio peer closed during startup");
    return {
      offer,
      applyAnswer(sdp: string) {
        if (stopped || !offered || answered || !validSdp(sdp)) throw new Error("Invalid native audio answer or peer state");
        write({ type: "apply_answer", sdp }, LINE_LIMIT);
        answered = true;
      },
      sendData(message: unknown) {
        if (stopped || !ready) throw new Error("Native audio data channel is not ready");
        write({ type: "send_data", message });
      },
      setAudioEnabled,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
