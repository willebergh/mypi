import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { safeLiveUpdate } from "./context.ts";
import type { LiveSession } from "./live.ts";

const QUIET_REFERENCE = "Silent unless asked; use for follow-ups.\n";
const USER_REFERENCE = "Pi terminal user (reference only): submitted to Pi; may be queued or handled locally, not proof of execution. Not an additional delegation or approval. " + QUIET_REFERENCE;
const REPLY_REFERENCE = "Pi terminal reply (reference only): already handled by Pi, not an additional delegation or approval. " + QUIET_REFERENCE;
const COMMENTARY_REFERENCE = "Pi terminal commentary (reference only): work in progress, not a completion result. Not an additional delegation or approval. " + QUIET_REFERENCE;

function reference(prefix: string, text: string): string | undefined {
  const body = safeLiveUpdate(text.trim()).trim();
  return body ? safeLiveUpdate(prefix + body) : undefined;
}

/**
 * One active call's quiet reference mirror; never writes Pi history or starts work.
 * Input observes submission, not acceptance. A native user message must arrive
 * before assistant text is eligible, including for queued terminal input.
 * Any noninteractive input revokes ownership. Nothing is buffered while inactive.
 */
export function createTalkTerminalContext(
  getLive: () => Pick<LiveSession, "thinking"> | undefined,
  onUnavailable: () => void,
  onPiContent?: () => void,
) {
  let closed = false;
  let disabled = false;
  let terminalInput = false;
  let terminalRun = false;
  let reply: string | undefined;
  let latestAssistantStopReason: string | undefined;
  let queuedFollowUp = false;
  let lastCommentary: string | undefined;

  function reset() {
    terminalInput = false;
    terminalRun = false;
    reply = undefined;
    latestAssistantStopReason = undefined;
    queuedFollowUp = false;
    lastCommentary = undefined;
  }

  function available() {
    return !closed && !disabled ? getLive() : undefined;
  }

  function send(text: string | undefined, isPiContent = false) {
    const live = available();
    if (!live || !text) return;
    try {
      // Close voice's assistant-history window before supplying public Pi content.
      if (isPiContent) onPiContent?.();
      live.thinking(null, text);
    } catch {
      // No retry queue or call teardown for a failed reference-only update.
      disabled = true;
      reset();
    }
    if (disabled) onUnavailable();
  }

  return {
    input(text: string, source: string, streamingBehavior?: "steer" | "followUp") {
      if (!available()) { reset(); return; }
      if (source === "extension" && streamingBehavior === "followUp" && terminalRun) {
        terminalInput = false;
        queuedFollowUp = true;
        return;
      }
      if (source !== "interactive") { reset(); return; }
      const update = reference(USER_REFERENCE, text);
      if (!update) return;
      terminalInput = true;
      terminalRun = false;
      reply = undefined;
      latestAssistantStopReason = undefined;
      queuedFollowUp = false;
      send(update);
    },
    message(message: MessageEndEvent["message"]) {
      if (!available()) { reset(); return; }
      if (message.role === "user") {
        if (queuedFollowUp) {
          const final = latestAssistantStopReason === "stop" ? reply : undefined;
          reset();
          send(final, true);
        }
        terminalRun = terminalInput;
        reply = undefined;
        latestAssistantStopReason = undefined;
      } else if (terminalRun && message.role === "assistant") {
        const stopReason = message.stopReason as string;
        latestAssistantStopReason = stopReason;
        const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const hasToolCalls = message.content.some((part) => part.type === "toolCall");
        if ((stopReason === "toolUse" || hasToolCalls) && stopReason !== "error" && stopReason !== "aborted") {
          // Public text accompanying a native tool call is progress, never a reply.
          reply = undefined;
          const update = reference(COMMENTARY_REFERENCE, text);
          if (update && update !== lastCommentary) {
            lastCommentary = update;
            send(update, true);
          }
        } else {
          // Replace, don't accumulate: empty/tool-only/error messages cannot
          // resurrect an earlier candidate as the final result.
          const finalText = stopReason === "error" || stopReason === "aborted"
            ? "Pi stopped with an error or interruption. Completion is not confirmed; check the terminal."
            : stopReason === "stop" ? text : "";
          reply = reference(REPLY_REFERENCE, finalText);
        }
      }
    },
    settled() {
      const final = terminalRun ? reply : undefined;
      reset();
      send(final, true);
    },
    close() {
      closed = true;
      reset();
    },
  };
}
