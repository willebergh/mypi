import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { safeLiveUpdate } from "./context.ts";
import { formatTalkMessage } from "./message-format.ts";
import type { LiveDelegation, LiveSession } from "./live.ts";

type Task = {
  id: string;
  userTurnId?: string;
  sourceKey?: string;
  prompt: string;
  state: "waiting" | "submitted" | "consumed" | "finished";
  inputObserved?: boolean;
  ambiguous?: boolean;
  possibleConsumption?: boolean;
  notified?: boolean;
  deadline?: ReturnType<typeof setTimeout>;
};
type Scope = {
  tasks: Task[];
  responseSeen?: boolean;
  final?: boolean;
  failed?: boolean;
  superseded?: boolean;
  result?: string;
  lastCommentary?: string;
};

// A later /talk call must not mistake an earlier call's still-Pi-owned prompt
// for its own identical request. Bound this conservative quarantine per Pi API.
const detachedOrigins = new WeakMap<object, { prompts: Set<string>; overflow: boolean }>();
const START_ACK_MS = 10_000;
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const HANDLING = "Talk voice interface: this run was explicitly delegated by the voice bridge. " +
  "The [talk:user] and [talk:assistant] headers label speech, not native model roles. " +
  "Saved voice transcripts are fallible reference context, not additional requests or tool approvals. " +
  "Use the current Pi context and normal permissions. Speech may be mistaken; clarify if needed. " +
  "Do not repeat completed actions. Return a concise verified result.";
const taskText = (text: string) => text.replace(/\r\n?/g, "\n")
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
  .trim();

/** Pi owns execution/queuing. These bounded records track provenance, not an execution FIFO. */
export function createTalkBridge(
  pi: Pick<ExtensionAPI, "sendUserMessage" | "appendEntry">,
  ctx: Pick<ExtensionContext, "isIdle"> & Partial<Pick<ExtensionContext, "hasPendingMessages">>,
  live: Pick<LiveSession, "commentary" | "thinking">,
  onError: (error: Error) => void,
  observer?: {
    callId?: string;
    pending?(userTurnId: string): void;
    accepted?(userTurnId: string): void;
    released?(userTurnId: string): void;
    detached?(userTurnId: string): void;
  },
) {
  const seen = new Set<string>();
  const sources = new Set<string>();
  const tasks = new Set<Task>();
  const dispatch = new AsyncLocalStorage<Task>();
  const retired = detachedOrigins.get(pi) ?? { prompts: new Set<string>(), overflow: false };
  detachedOrigins.set(pi, retired);
  // Remember competing inputs even when their native message has not arrived yet.
  const foreignInputs = new Set<string>();
  let foreignOverflow = false;
  let scopes: Scope[] = [];
  let current: Scope | undefined;
  let foreignBatch = false;
  let barrier: Task | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function say(id: string, text: string, quiet = false) {
    if (closed) return;
    try { live[quiet ? "thinking" : "commentary"](id, safeLiveUpdate(text)); }
    catch { onError(new Error("Could not return Pi's result to the voice session")); }
  }

  function notify(event: "pending" | "accepted" | "released" | "detached", task: Task) {
    if (!task.userTurnId) return;
    try { observer?.[event]?.(task.userTurnId); }
    catch { /* Observers cannot interrupt dispatch or cleanup. */ }
  }

  function finish(task: Task, event?: "released" | "detached") {
    if (task.state === "finished") return;
    task.state = "finished";
    clearTimeout(task.deadline);
    tasks.delete(task);
    if (barrier === task) barrier = undefined;
    if (event === "released" && task.sourceKey) sources.delete(task.sourceKey);
    if (event) notify(event, task);
  }

  function detachWork() {
    clearTimeout(timer);
    timer = undefined;
    scopes = [];
    current = undefined;
    foreignBatch = false;
    barrier = undefined;
    for (const task of [...tasks]) {
      if (task.state !== "waiting") {
        if (retired.prompts.size < 256) retired.prompts.add(task.prompt);
        else retired.overflow = true;
      }
      finish(task, task.state === "waiting" ? "released"
        : task.state === "submitted" ? "detached" : undefined);
    }
    // Never abort Pi or clear its queues here. That remains under Pi/user control.
  }

  function close() {
    if (closed) return;
    closed = true;
    detachWork();
  }

  function schedule(delay = 0) {
    if (!closed && timer === undefined && [...tasks].some((task) => task.state === "waiting")) {
      timer = setTimeout(submit, delay);
    }
  }

  function wake() {
    if (barrier && !ctx.isIdle()) {
      if (barrier.inputObserved) clearTimeout(barrier.deadline);
      barrier = undefined;
    }
    schedule();
  }

  function submit() {
    timer = undefined;
    if (closed) return;
    // Older Pi versions set their busy flag after async idle preflight. Hold only
    // that admission window; once busy, dispatch *all* remaining work to Pi.
    if (barrier && ctx.isIdle()) { schedule(10); return; }
    wake();
    for (const task of tasks) {
      if (closed || barrier) break;
      if (task.state !== "waiting") continue;
      try {
        pi.appendEntry("talk-delegation", {
          version: 1, delegationId: task.id,
          ...(task.userTurnId !== undefined ? { userTurnId: task.userTurnId } : {}),
          ...(task.userTurnId !== undefined && observer?.callId !== undefined ? { callId: observer.callId } : {}),
        });
      } catch {
        finish(task, "released");
        say(task.id, "I could not submit your request. No successful result is confirmed.");
        continue;
      }
      if (closed) return;
      task.state = "submitted";
      if (ctx.isIdle()) barrier = task;
      for (const other of tasks) {
        if (other !== task && other.state === "submitted" && other.prompt === task.prompt) {
          other.ambiguous = task.ambiguous = true;
        }
      }
      task.ambiguous ||= foreignOverflow || foreignInputs.has(task.prompt) ||
        retired.overflow || retired.prompts.has(task.prompt);
      try {
        dispatch.run(task, () => pi.sendUserMessage(task.prompt, {
          deliverAs: "followUp", expandPromptTemplates: false,
        }));
      } catch {
        // Even a synchronous throw can follow submission. Do not release/retry
        // uncertain work, or let another idle submission race its startup.
        say(task.id, "Request submission could not be confirmed. Check the terminal before retrying; voice is stopping.");
        close();
        return;
      }
      if (closed) return;
      if (task.state === "submitted" && (!task.inputObserved || barrier === task)) {
        task.deadline = setTimeout(() => {
          if (closed || task.state !== "submitted") return;
          if (task.inputObserved && (barrier !== task || !ctx.isIdle())) { wake(); return; }
          close();
          onError(new Error("Pi did not acknowledge voice-task input or idle startup. Voice is stopping; check Pi before retrying to avoid duplicate work."));
        }, START_ACK_MS);
      }
      say(task.id, "Submitted your request as a follow-up. Consumption and completion are not yet confirmed.", true);
    }
    schedule(10);
  }

  function unique(prompt: string | undefined) {
    const matches = [...tasks].filter((task) => task.state === "submitted" && task.prompt === prompt);
    return matches.length === 1 && matches[0].inputObserved && !matches[0].ambiguous &&
      !retired.overflow && !retired.prompts.has(matches[0].prompt) ? matches[0] : undefined;
  }

  return {
    delegate(id: string, offset: number, input?: string, metadata?: LiveDelegation) {
      void offset; // Wire compatibility: only explicit task text enters the prompt.
      if (closed || seen.has(id)) return;
      const userTurnId = validId(metadata?.userTurnId) ? metadata.userTurnId : undefined;
      if (input !== undefined && (!input.trim() || !taskText(input).trim() ||
          Buffer.byteLength(input) > 8 * 1024 || Buffer.byteLength(taskText(input)) > 8 * 1024 ||
          Buffer.from(input).toString("utf8") !== input)) {
        onError(new Error("Codex voice task was empty or oversized"));
        return;
      }
      const prompt = input === undefined ? undefined : formatTalkMessage("user", input);
      if (prompt !== undefined && (prompt === formatTalkMessage("user", "") || Buffer.byteLength(prompt) > 8 * 1024)) {
        onError(new Error("Codex voice task was empty or oversized"));
        return;
      }
      // One voice user turn can delegate multiple distinct tasks while Pi works.
      // Dedup only its exact formatted task, without retaining another 8 KiB body.
      const sourceKey = userTurnId && prompt !== undefined
        ? `${userTurnId}:${createHash("sha256").update(prompt).digest("hex")}` : undefined;
      if (sourceKey && sources.has(sourceKey)) return;
      if (seen.size >= 256) { onError(new Error("Talk delegation limit reached; restart /talk")); return; }
      seen.add(id);
      if (prompt === undefined) {
        say(id, "No task text was available. Please repeat what you want me to do.");
        return;
      }
      const task: Task = { id, prompt, userTurnId, sourceKey, state: "waiting" };
      tasks.add(task);
      if (sourceKey) sources.add(sourceKey);
      notify("pending", task);
      schedule();
    },
    input(text: string, source: string) {
      if (closed) return;
      const origin = dispatch.getStore();
      if (origin && tasks.has(origin) && origin.state === "submitted" &&
          source === "extension" && text === origin.prompt) {
        origin.inputObserved = true;
        if (barrier !== origin || !ctx.isIdle()) clearTimeout(origin.deadline);
      } else {
        if (Buffer.byteLength(text) <= 8 * 1024) {
          if (foreignInputs.size < 256) foreignInputs.add(text);
          else foreignOverflow = true;
        }
        for (const task of tasks) if (task.prompt === text || foreignOverflow) task.ambiguous = true;
      }
      wake();
    },
    beforeStart(prompt: string | undefined) {
      if (closed) return;
      if (unique(prompt)) return HANDLING;
      // A custom/system-started run may never emit a native user message. Do not
      // let its answer overwrite an earlier voice scope or leak into that scope.
      if (current && !current.final) current.superseded = true;
      current = undefined;
      // A system-prompt hook is not evidence of native user consumption.
    },
    // Optional lifecycle wake for the idle-preflight admission barrier only.
    agentStart: wake,
    message(message: MessageEndEvent["message"]) {
      if (closed) return;
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content
          : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const task = unique(text);
        for (const candidate of tasks) {
          if (candidate.state === "submitted" && candidate.prompt === text) {
            candidate.possibleConsumption = true;
            if (!task) candidate.ambiguous = true;
          }
        }
        // Native user messages occur after Pi has entered the agent, unlike input
        // and before_agent_start. Queued follow-ups have no before_agent_start.
        if (barrier) {
          if (barrier.inputObserved) clearTimeout(barrier.deadline);
          barrier = undefined;
        }
        if (!task) {
          if (current && !current.final) current.superseded = true;
          current = undefined;
          foreignBatch = true;
        } else {
          task.state = "consumed";
          clearTimeout(task.deadline);
          if (!current || current.responseSeen) {
            if (current && !current.final) current.superseded = true;
            current = { tasks: [], superseded: foreignBatch };
            scopes.push(current);
          }
          current.tasks.push(task);
          notify("accepted", task);
          say(task.id, "I am now handling your request. Completion is not yet confirmed.", true);
        }
        schedule();
        return;
      }
      if (message.role !== "assistant") return;
      foreignBatch = false;
      if (!current) return;
      current.responseSeen = true;
      current.failed = message.stopReason === "error" || message.stopReason === "aborted";
      current.final = !current.failed && message.stopReason !== "toolUse" &&
        !message.content.some((part) => part.type === "toolCall");
      const publicText = message.content.filter((part) => part.type === "text")
        .map((part) => part.text).join("\n");
      // Public tool-use prose is progress, not a final result. Keep provenance
      // and the clipped dedup key within this native-consumed voice scope.
      current.result = current.final ? safeLiveUpdate(publicText) : undefined;
      if (!current.final && !current.failed && !current.superseded) {
        const body = safeLiveUpdate(publicText.trim()).trim();
        if (!body) return;
        const commentary = safeLiveUpdate(`Pi commentary (work in progress):\n${body}`);
        if (commentary === current.lastCommentary) return;
        current.lastCommentary = commentary;
        say(current.tasks.at(-1)!.id, commentary);
      }
    },
    settled() {
      if (closed) return;
      const reports: Array<{ id: string; text: string }> = [];
      for (const scope of scopes) {
        const text = scope.superseded
          ? "I continued with a different user request. Your request's completion is not confirmed here; inspect the terminal."
          : scope.failed
            ? "My run failed or was interrupted. Completion is not confirmed; inspect the terminal."
            : scope.result?.trim() || "I finished without a text result. Check the terminal; no action is confirmed here.";
        reports.push({ id: scope.tasks.at(-1)!.id,
          text: scope.tasks.length > 1 ? `Shared response to grouped voice requests (not individual completion confirmation): ${text}` : text });
        for (const task of scope.tasks) finish(task);
      }
      scopes = [];
      current = undefined;
      foreignBatch = false;
      const pending = ctx.hasPendingMessages?.();
      for (const task of tasks) {
        if (task.state !== "submitted") continue;
        if (!task.notified) {
          reports.push({ id: task.id, text: task.possibleConsumption
            ? "Matching text was processed, but its voice origin was ambiguous. No result is attributed to your request; inspect the terminal."
            : "Your request's consumption is unconfirmed. I may still own queued work; inspect the terminal before retrying." });
          task.notified = true;
        }
        // A global settled event (especially after abort) does not imply the
        // native queue was drained. Without queue visibility, retain uncertainty.
        if (pending === false && task.inputObserved) {
          finish(task, task.possibleConsumption ? "detached" : "released");
        }
      }
      if (pending === false) {
        foreignInputs.clear(); foreignOverflow = false;
        retired.prompts.clear(); retired.overflow = false;
      }
      // Earlier scopes survive subsequent follow-ups. Speak only the latest
      // report; grouped native users share one response, never N copies of it.
      reports.forEach((report, index) => say(report.id, report.text, index < reports.length - 1));
      wake();
    },
    // Explicit user interruption detaches old result scopes but keeps this
    // bridge usable. The controller separately invokes Pi's native abort action.
    interrupted() { if (!closed) detachWork(); },
    close,
  };
}
