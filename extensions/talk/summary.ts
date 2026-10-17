import { createHash } from "node:crypto";
import { buildContextEntries, buildSessionContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyTalkRequestFailure, describeTalkRequestFailure, type TalkRequestFailure } from "./request-error.ts";
import { runTalkSummaryProcess, SummaryProcessError } from "./summary-process.ts";

const PROVIDER = "openai-codex";
const MODEL = "gpt-6-luna";
// Full-history summaries can exceed eight seconds even when tiny probes succeed.
const DEADLINE_MS = 15_000;
const INPUT_BYTES = 32 * 1024;
const OUTPUT_BYTES = 3 * 1024;
const cache = new Map<string, string>();
const FAILURE_MESSAGES = {
  context_read: "Couldn't read conversation context for the summary.",
  cli_unavailable: "The installed Pi CLI is unavailable for conversation summaries.",
  provider_error: `Pi summary command failed for ${PROVIDER}/${MODEL}.`,
  output_limit: "The Pi conversation summary exceeded its output limit.",
  empty_response: `Summary model ${PROVIDER}/${MODEL} returned no summary text.`,
  timeout: `Conversation summary timed out after 15 seconds (${PROVIDER}/${MODEL}).`,
  cancelled: "Conversation summary was cancelled.",
} as const;
export type TalkSummaryErrorCode = keyof typeof FAILURE_MESSAGES;

/** Only fixed, local diagnostics: never attach upstream errors, text, or credentials. */
export class TalkSummaryError extends Error {
  readonly code: TalkSummaryErrorCode;
  readonly requestFailure?: TalkRequestFailure;

  constructor(code: TalkSummaryErrorCode, requestFailure?: TalkRequestFailure) {
    super(summaryFailureMessage(code, requestFailure));
    this.name = "TalkSummaryError";
    this.code = code;
    this.requestFailure = requestFailure;
  }
}

function summaryFailureMessage(code: TalkSummaryErrorCode, reason?: TalkRequestFailure): string {
  return FAILURE_MESSAGES[code] + (reason ? ` Cause: ${describeTalkRequestFailure(reason)}.` : "");
}

export function getTalkSummaryFailure(error: unknown): string {
  return error instanceof TalkSummaryError ? summaryFailureMessage(error.code, error.requestFailure) : "unknown summary error";
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n").trim();
}

// UTF-8 byte limits without splitting a code point (also repairs lone surrogates).
function bounded(text: string, bytes: number, tail = false): string {
  const safe = text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  const buffer = Buffer.from(safe);
  if (buffer.length <= bytes) return safe;
  if (tail) {
    let start = buffer.length - bytes;
    while ((buffer[start] & 0xc0) === 0x80) start++;
    return buffer.subarray(start).toString("utf8");
  }
  let end = bytes;
  while ((buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function snapshot(ctx: ExtensionContext) {
  const manager = ctx.sessionManager;
  const entries = manager.getEntries();
  const leaf = manager.getLeafId();
  const active = buildContextEntries(entries, leaf);
  const checkpoint = active.find((entry) => entry.type === "compaction");
  const details = checkpoint?.type === "compaction" ? checkpoint.details : undefined;
  const opaque = details && typeof details === "object" && "strategy" in details &&
    (details.strategy === "openai-responses-compaction-v2" || details.strategy === "openai-native-compact-v1");
  // Native encrypted provider compaction is not conversation text. Never serialize
  // its system item/details; readable turns after it are still useful.
  const source = opaque ? entries.map((entry) => entry === checkpoint ? { ...entry, summary: "" } : entry) : entries;
  const turns: string[] = [];
  for (const message of buildSessionContext(source, leaf).messages) {
    let label: string;
    let text: string;
    if (message.role === "custom" && message.customType === "talk-history") {
      label = "voiceTranscript";
      text = textContent(message.content);
    } else if (message.role === "user" || message.role === "assistant") {
      label = message.role;
      text = textContent(message.content);
    } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
      label = message.role;
      text = message.summary.trim();
    } else continue;
    if (text) turns.push(`[${label}]: ${text}`);
  }
  const serialized = turns.join("\n\n");
  const notice = "[Older context omitted]\n";
  const input = Buffer.byteLength(serialized) > INPUT_BYTES
    ? notice + bounded(serialized, INPUT_BYTES - Buffer.byteLength(notice), true) : bounded(serialized, INPUT_BYTES);
  const hash = createHash("sha256").update(input).digest("hex");
  return { input, key: JSON.stringify([manager.getSessionId(), leaf, PROVIDER, MODEL, hash, "pi-print"]) };
}

/** Read-only snapshot via the installed CLI; no parent UI or transcript persistence. */
export async function summarizeTalkContext(
  ctx: ExtensionContext,
  signal: AbortSignal,
  runner: (history: string, signal: AbortSignal, cwd: string) => Promise<string> = runTalkSummaryProcess,
): Promise<string | undefined> {
  if (signal.aborted) throw new TalkSummaryError("cancelled");
  const controller = new AbortController();
  const expires = Date.now() + DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  let stopCode: "timeout" | "cancelled" | undefined;
  const stage: { code: TalkSummaryErrorCode } = { code: "context_read" };
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      // Record the cause before abort listeners can synchronously fail the provider.
      stopCode ??= signal.aborted ? "cancelled" : "timeout";
      reject(new TalkSummaryError(stopCode));
      controller.abort();
    };
    timer = setTimeout(cancel, DEADLINE_MS);
    signal.addEventListener("abort", cancel, { once: true });
  });
  const check = () => {
    if (stopCode || signal.aborted || Date.now() >= expires) {
      throw new TalkSummaryError(stopCode ?? (signal.aborted ? "cancelled" : "timeout"));
    }
  };
  try {
    const original = snapshot(ctx);
    check();
    if (!original.input) return undefined;
    const hit = cache.get(original.key);
    if (hit !== undefined) return hit;
    const work = async () => {
      check();
      const cwd = ctx.cwd;
      stage.code = "provider_error";
      const completed = await runner(original.input, controller.signal, cwd);
      check();
      const summary = bounded(completed, OUTPUT_BYTES).trim();
      if (!summary) throw new TalkSummaryError("empty_response");
      return summary;
    };
    // Cache only on the winning side of the race, never in late runner work.
    const summary = await Promise.race([work(), stopped]);
    check();
    stage.code = "context_read";
    if (snapshot(ctx).key === original.key) {
      check();
      cache.set(original.key, summary);
      while (cache.size > 8) cache.delete(cache.keys().next().value!);
    }
    return summary;
  } catch (error) {
    check();
    if (error instanceof TalkSummaryError) throw error;
    if (stage.code === "provider_error" && error instanceof SummaryProcessError) {
      throw new TalkSummaryError(error.code, error.requestFailure);
    }
    const reason = stage.code === "provider_error" ? classifyTalkRequestFailure(error) : undefined;
    throw new TalkSummaryError(reason === "cancelled" ? "cancelled" : stage.code, reason);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}
