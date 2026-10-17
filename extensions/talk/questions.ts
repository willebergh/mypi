import { Buffer } from "node:buffer";
import type { AskUserResult, QuestionAnswer, SelectedAnswer, UserQuestion } from "../ask-user/core.ts";
import { parseTalkReply } from "./replies.ts";

// Over-limit requests fall back atomically: no question or option label is clipped.
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 12;
const MAX_PROMPT_BYTES = 450;
const MAX_INPUT_BYTES = 320;
const MAX_REQUEST_BYTES = 4096;
const IDLE_MS = 120_000;
const HELP = "Say a number, label, or free text. Commands: skip, repeat, cancel, keyboard.";
const CONFIRM = "Say Yes to confirm or No to change.";
const unsafe = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
const key = (text: string) => text.trim().toLowerCase();
const command = (text: string) => key(text).replace(/[.!?]+$/u, "");
const words = [
  ["one", "en", "ett"], ["two", "två"], ["three", "tre"], ["four", "fyra"],
  ["five", "fem"], ["six", "sex"], ["seven", "sju"], ["eight", "åtta"],
  ["nine", "nio"], ["ten", "tio"], ["eleven", "elva"], ["twelve", "tolv"],
];

function optionLines(question: UserQuestion): string[] {
  return question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
}
function prompt(question: UserQuestion): string {
  return [question.question, ...optionLines(question),
    question.mode === "multiple" ? "Choose one or more; separate with comma, and, or och." : "Choose one.", HELP].join("\n");
}

/** Never infer a partial/fuzzy match. Conflicting number/label interpretations are custom text. */
function selections(question: UserQuestion, text: string): SelectedAnswer[] {
  const match = (part: string): number[] => {
    const value = command(part);
    const number = value.replace(/^(?:option|alternativ|number|nummer)\s+/u, "");
    const indices = new Set<number>();
    question.options.forEach((option, index) => {
      if (command(option.label) === value || number === String(index + 1) || words[index]?.includes(number)) indices.add(index);
    });
    return [...indices];
  };
  const full = match(text);
  let indices = full.length === 1 ? full : undefined;
  let ambiguous = full.length > 1;
  if (question.mode === "multiple") {
    const parts = text.split(/,\s*(?:(?:and|och)\s+)?|\s+(?:and|och)\s+/iu).map((part) => part.trim());
    if (parts.length > 1) {
      const matches = parts.map(match);
      if (matches.every((values) => values.length === 1)) {
        const split = [...new Set(matches.map((values) => values[0]))];
        if (indices && (split.length !== 1 || split[0] !== indices[0])) ambiguous = true;
        else indices = split;
      } else if (!indices) ambiguous = true;
    }
  }
  return !ambiguous && indices
    ? indices.map((index) => ({ label: question.options[index].label, custom: false }))
    : [{ label: text, custom: true }];
}

// Explicit topic changes only in the answer phase: ordinary free text is still an answer.
function newTopic(text: string): boolean {
  return /^(?:never\s*mind\b|instead\b|i just sent\b|tell pi\b|look at\b|strunta i det\b|istället\b|jag har (?:just|precis) skickat\b|säg till pi\b|titta på(?=$|[\s,.!?;:]))/iu.test(text.trim()) ||
    /^(?:what|why|how|when|where|who|vad|varför|hur|när|var|vem)\b[^]*\?\s*$/iu.test(text.trim()) ||
    /^(?:(?:please|can you(?: please)?|could you(?: please)?|would you(?: please)?|kan du|snälla)\s+)?(?:inspect|check|read|open|show|explain|fix|run|test|review|look at|granska|kontrollera|läs|öppna|visa|förklara|fixa|kör|testa)\s+\S/iu.test(text.trim());
}

interface Pending {
  questions: UserQuestion[];
  index: number;
  answers: QuestionAnswer[];
  candidate?: QuestionAnswer;
  resolve(result: AskUserResult | undefined): void;
  signal?: AbortSignal;
  abort(): void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createTalkQuestions(callbacks: {
  speak(text: string): void;
  changed(): void;
}): {
  ask(questions: UserQuestion[], signal?: AbortSignal): Promise<AskUserResult | undefined>;
  answer(text: string): boolean;
  cancel(): void;
  cancelWithResult(): void;
  readonly pending: boolean;
  readonly phase: "answer" | "confirm" | undefined;
  view(): string[];
} {
  let active: Pending | undefined;
  let notifying = false;
  const result = (state: Pending, cancelled: boolean): AskUserResult => ({
    questions: state.questions,
    cancelled,
    answers: state.questions.map((question, index) => state.answers[index] ?? {
      id: question.id, question: question.question, skipped: false, answers: [],
    }),
  });
  const finish = (state: Pending, value: AskUserResult | undefined) => {
    if (active !== state) return;
    active = undefined; // Clear ownership before callbacks or promise continuations can reenter.
    clearTimeout(state.timer);
    state.signal?.removeEventListener("abort", state.abort);
    state.resolve(value);
    const previous = notifying;
    notifying = true;
    try { callbacks.changed(); } catch { /* UI failure cannot strand a tool. */ }
    finally { notifying = previous; }
  };
  const touch = (state: Pending) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => finish(state, undefined), IDLE_MS);
    state.timer.unref?.();
  };
  const readback = (state: Pending) => {
    const candidate = state.candidate!;
    const labels = candidate.skipped ? "skip this question" : candidate.answers.map((answer) => answer.label).join(", ");
    return `You chose: ${labels}. ${CONFIRM}`;
  };
  const interrupt = (state: Pending, userRequest: string) => {
    if (Buffer.byteLength(userRequest) > MAX_REQUEST_BYTES) { finish(state, undefined); return; }
    finish(state, { ...result(state, state.index < state.questions.length), userRequest });
  };
  const publish = (state: Pending, text: string) => {
    if (active !== state) return;
    if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) { finish(state, undefined); return; }
    notifying = true;
    try {
      callbacks.speak(text);
      if (active === state) callbacks.changed();
    } catch {
      finish(state, undefined);
    } finally { notifying = false; }
  };

  return {
    ask(questions, signal) {
      if (signal?.aborted) return Promise.resolve({ questions, answers: [], cancelled: true });
      if (active || notifying) return Promise.resolve(undefined);
      if (!questions.length || questions.length > MAX_QUESTIONS || questions.some((question) =>
        question.options.length > MAX_OPTIONS ||
        [question.id, question.label, question.question, ...question.options.flatMap((option) => [option.label, option.description ?? ""])]
          .some((text) => Buffer.byteLength(text) > 1024 || unsafe.test(text)) ||
        Buffer.byteLength(prompt(question)) > MAX_PROMPT_BYTES
      )) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const state: Pending = {
          questions, index: 0, answers: [], resolve, signal,
          abort: () => finish(state, result(state, true)),
        };
        active = state;
        signal?.addEventListener("abort", state.abort, { once: true });
        touch(state);
        publish(state, prompt(questions[0]));
      });
    },
    answer(text) {
      const state = active;
      if (!state) return false;
      if (notifying) return true; // Callbacks cannot manufacture a separate confirmation turn.
      if (Buffer.byteLength(text) > MAX_REQUEST_BYTES + 64 || unsafe.test(text)) {
        finish(state, undefined);
        return true;
      }
      const actual = text;
      text = text.trim();
      if (!text) return true;
      touch(state);
      const reply = parseTalkReply(actual);
      const question = state.questions[state.index];
      const setCandidate = (answers: SelectedAnswer[], skipped = false) => {
        state.candidate = { id: question.id, question: question.question, skipped, answers };
        publish(state, readback(state));
      };
      if (reply.kind === "keyboard") { finish(state, undefined); return true; }
      if (reply.kind === "cancel") {
        if (reply.remainder) interrupt(state, reply.remainder);
        else finish(state, result(state, true));
        return true;
      }
      if (reply.kind === "repeat") {
        publish(state, prompt(question));
        if (active === state && state.candidate) publish(state, readback(state));
        return true;
      }
      if (state.candidate) {
        if (reply.kind === "confirm") {
          state.answers.push(state.candidate);
          state.candidate = undefined;
          state.index += 1;
          if (reply.remainder) interrupt(state, reply.remainder);
          else if (state.index === state.questions.length) finish(state, result(state, false));
          else publish(state, prompt(state.questions[state.index]));
        } else if (reply.kind === "reject" && !reply.remainder) {
          state.candidate = undefined;
          publish(state, prompt(question));
        } else {
          const alternative = selections(question, reply.kind === "reject" ? reply.remainder! : text);
          // Only exact, unambiguous options can replace a readback. Unknown speech
          // ends the group rather than trapping the waiting tool in a Yes/No loop.
          if (alternative.every((answer) => !answer.custom)) setCandidate(alternative);
          else interrupt(state, actual);
        }
        return true;
      }
      // Exact option labels take precedence over topic heuristics, not commands.
      const selected = selections(question, text);
      if (selected.some((answer) => answer.custom) && (newTopic(text) || (reply.kind === "confirm" && reply.remainder))) {
        interrupt(state, actual);
        return true;
      }
      if (Buffer.byteLength(text) > MAX_INPUT_BYTES) { finish(state, undefined); return true; }
      const skipped = ["skip", "hoppa över"].includes(command(text));
      setCandidate(skipped ? [] : selected, skipped);
      return true;
    },
    cancel() { if (active) finish(active, undefined); },
    cancelWithResult() { if (active) finish(active, result(active, true)); },
    get pending() { return active !== undefined; },
    get phase() { return active ? (active.candidate ? "confirm" : "answer") : undefined; },
    view() {
      if (!active) return [];
      const question = active.questions[active.index];
      return [
        `Question ${active.index + 1}/${active.questions.length}: ${question.question.replace(/\s+/gu, " ")}`,
        ...optionLines(question).map((line) => line.replace(/\s+/gu, " ")),
        ...(active.candidate ? [readback(active).replace(/\s+/gu, " ")] : []),
        active.candidate ? "Yes / Confirm / Ja · No / change / Nej" : "Answer by label, number, or free text",
        "skip · repeat · cancel · keyboard / terminal",
      ];
    },
  };
}
