import type { AskUserResult, UserQuestion } from "../ask-user/core.ts";
import { createTalkQuestions } from "./questions.ts";
import { createTalkReplyChannel } from "./reply-channel.ts";

/** Delegation commits raw user speech; assistant text and user finals are not answers. */
export function createTalkQuestionChannel(callbacks: {
  speak(text: string): void;
  context(text: string): void;
  changed(): void;
}): {
  ask(questions: UserQuestion[], signal?: AbortSignal): Promise<AskUserResult | undefined>;
  transcript(role: "user" | "assistant", delta: string): void;
  turn(role: "user" | "assistant", text: string): void;
  delegate(input: string): boolean;
  cancel(): void;
  endCall(): void;
  readonly pending: boolean;
  readonly commits: number;
  view(): string[];
} {
  const channel = createTalkReplyChannel("talk_answer", () => q, callbacks);
  const q = createTalkQuestions({
    speak: (text) => channel.onPrompt(text, q.phase),
    changed: () => channel.onChanged(),
  });
  return {
    ask: (questions, signal) => q.ask(questions, signal),
    transcript: channel.transcript,
    turn: channel.turn,
    delegate: channel.delegate,
    cancel: channel.cancel,
    endCall: () => q.cancelWithResult(),
    get pending() { return q.pending; },
    get commits() { return channel.commits; },
    view: channel.view,
  };
}
