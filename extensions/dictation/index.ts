import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKittyProtocolActive } from "@earendil-works/pi-tui";
import { createSpaceHold, isModifierOnlyEvent } from "./hold-space.ts";
import { createTranscriptPreview } from "./preview.ts";
import { accountIdFromToken } from "../openai-usage/core.ts";
import { announceExtension, DICTATION_CHANGED_EVENT, type DictationState } from "../resource-status/protocol.ts";
import { startRecorder, type Recorder } from "./recorder.ts";
import { openTranscriber, type Transcriber } from "./transcriber.ts";

const MAX_RECORDING_MS = 120_000;

interface Recording {
  ctx: ExtensionContext;
  controller: AbortController;
  state: "starting" | "listening" | "finishing";
  recorder?: Recorder;
  transcriber?: Transcriber;
  timer?: ReturnType<typeof setTimeout>;
  stopped?: Promise<void>;
  cleanup?: Promise<void>;
  preview: ReturnType<typeof createTranscriptPreview>;
  audioBytes: number;
}

export function registerDictation(pi: ExtensionAPI, dependencies = { startRecorder, openTranscriber }) {
  let active: Recording | undefined;
  let removeInput: (() => void) | undefined;
  let spaceHold: ReturnType<typeof createSpaceHold> | undefined;
  let keyboardPushed = false;
  let promptOpen = false;
  const publish = (state: DictationState) => pi.events.emit(DICTATION_CHANGED_EVENT, state);

  function enableSpaceEvents() {
    if (!isKittyProtocolActive()) return false;
    if (!keyboardPushed) {
      // Include unmodified text keys in press/repeat/release reports.
      process.stdout.write("\x1b[>15u");
      keyboardPushed = true;
    }
    return true;
  }

  function stopCapture(recording: Recording) {
    return recording.stopped ??= recording.recorder?.stop() ?? Promise.resolve();
  }

  async function dispose(recording: Recording) {
    if (recording.cleanup) return recording.cleanup;
    if (active === recording) {
      active = undefined;
      recording.ctx.ui.setStatus("dictation", undefined);
      publish("idle");
    }
    recording.preview.rollback();
    clearTimeout(recording.timer);
    recording.controller.abort();
    recording.transcriber?.close();
    recording.cleanup = stopCapture(recording);
    await recording.cleanup;
  }

  function fail(recording: Recording, error: unknown) {
    if (active !== recording) return;
    recording.ctx.ui.notify(error instanceof Error ? error.message : "Dictation failed", "error");
    void dispose(recording);
  }

  async function toggle(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Dictation requires Pi's interactive terminal mode.", "warning");
      return;
    }
    if (active) {
      const recording = active;
      if (recording.state === "starting") {
        await dispose(recording);
      } else if (recording.state === "listening") {
        recording.state = "finishing";
        publish("finishing");
        clearTimeout(recording.timer);
        ctx.ui.setStatus("dictation", "Dictation: transcribing…");
        try {
          // Drain the final microphone chunks before committing the audio buffer.
          await stopCapture(recording);
          if (active !== recording) return;
          const text = await recording.transcriber!.finish();
          if (active !== recording) return;
          if (!recording.preview.update(text)) throw new Error("Dictation cancelled because the prompt was edited.");
          recording.preview.accept();
          if (!text) ctx.ui.notify(recording.audioBytes === 0
            ? "No microphone audio arrived before release."
            : `No transcript returned for ${(recording.audioBytes / 48_000).toFixed(2)} seconds of captured audio.`, "info");
        } catch (error) {
          fail(recording, error);
        } finally {
          await dispose(recording);
        }
      }
      return;
    }

    const recording: Recording = {
      ctx, controller: new AbortController(), state: "starting",
      preview: createTranscriptPreview(ctx.ui), audioBytes: 0,
    };
    active = recording;
    publish("connecting");
    ctx.ui.setStatus("dictation", "Dictation: connecting…");
    try {
      // Pi owns credential storage and refresh. Never create a voice-specific login.
      const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
      if (active !== recording) return;
      if (!token) throw new Error("Dictation needs your existing Pi openai-codex login (/login).");
      const accountId = accountIdFromToken(token);
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        originator: "pi",
        "user-agent": "mypi-dictation",
        "x-session-id": ctx.sessionManager.getSessionId(),
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      };
      const transcriber = await dependencies.openTranscriber(
        headers, recording.controller.signal, (error) => fail(recording, error),
        (text) => {
          if (active !== recording) return;
          if (!recording.preview.update(text)) fail(recording, new Error("Dictation cancelled because the prompt was edited."));
        },
      );
      if (active !== recording) { transcriber.close(); return; }
      recording.transcriber = transcriber;
      recording.state = "listening";
      let captureReady = false;
      recording.recorder = dependencies.startRecorder(
        (pcm) => {
          if (active !== recording) return;
          recording.audioBytes += pcm.length;
          if (!captureReady && pcm.length > 0) {
            captureReady = true;
            if (recording.state === "listening") {
              publish("listening");
              ctx.ui.setStatus("dictation", "● Listening — release Space to stop");
            }
          }
          transcriber.append(pcm);
        }, (error) => fail(recording, error),
      );
      if (active !== recording) { await recording.recorder.stop(); return; }
      recording.timer = setTimeout(() => { if (active === recording) void toggle(ctx); }, MAX_RECORDING_MS);
    } catch (error) {
      fail(recording, error);
    }
  }

  pi.registerCommand("dictate", {
    description: "Start/stop dictation; /dictate cancel discards it",
    handler: async (args, ctx) => {
      if (args.trim() === "cancel") {
        spaceHold?.cancel();
        if (active) await dispose(active);
      } else if (!args.trim()) {
        await toggle(ctx);
      } else {
        ctx.ui.notify("Usage: /dictate [cancel]", "warning");
      }
    },
  });
  pi.on("session_start", (_event, ctx) => {
    announceExtension(pi.events, { id: "dictation", label: "dictation" });
    publish("idle");
    if (ctx.mode !== "tui") return;
    let heldRecording: Recording | undefined;
    spaceHold = createSpaceHold({
      start: () => {
        heldRecording = undefined;
        if (!active) {
          void toggle(ctx);
          heldRecording = active;
        }
      },
      stop: () => {
        if (active && active === heldRecording) void toggle(ctx);
        heldRecording = undefined;
      },
      tap: () => ctx.ui.pasteToEditor(" "),
    });
    enableSpaceEvents();
    removeInput = ctx.ui.onTerminalInput((data) => {
      // Enhanced keyboard reporting includes standalone Shift/Ctrl/etc. Pi's
      // printable decoder otherwise inserts their private-use key codes.
      // Filter these even while a dialog temporarily owns terminal input.
      if (isModifierOnlyEvent(data)) return { consume: true };
      if (promptOpen || !enableSpaceEvents()) return;
      return spaceHold?.input(data);
    });
  });
  pi.on("ui_prompt_start", async () => {
    promptOpen = true;
    spaceHold?.cancel();
    if (active) await dispose(active);
  });
  pi.on("ui_prompt_end", () => { promptOpen = false; });
  pi.on("session_shutdown", async () => {
    removeInput?.();
    removeInput = undefined;
    spaceHold?.cancel();
    if (keyboardPushed) process.stdout.write("\x1b[<u");
    keyboardPushed = false;
    if (active) await dispose(active);
  });
  pi.on("session_before_tree", async () => {
    spaceHold?.cancel();
    if (active) await dispose(active);
  });
}

export default function dictation(pi: ExtensionAPI) {
  registerDictation(pi);
}
