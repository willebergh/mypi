import { createTalkReplyChannel } from "./reply-channel.ts";
import { createTalkTaskConfirmation } from "./task-confirmation.ts";

type Task = { id: string; offset: number; input: string };

/** The original task parser and fixed deadline, behind the shared raw-speech gate. */
export function createTalkTaskChannel(callbacks: {
  speak(text: string): void;
  context(text: string): void;
  changed(): void;
  confirmed(task: Task): void;
  interrupted?(text: string): void;
}): {
  propose(id: string, offset: number, input: string): void;
  transcript(role: "user" | "assistant", delta: string): void;
  turn(role: "user" | "assistant", text: string): void;
  delegate(input: string): boolean;
  cancel(): void;
  readonly pending: boolean;
  view(): string[];
  readonly commits: number;
} {
  const channel = createTalkReplyChannel("talk_task_answer", () => ({
    get pending() { return task.pending; },
    get phase() { return task.pending ? "confirm" as const : undefined; },
    answer: task.answer,
    cancel: task.cancel,
    view: task.view,
  }), callbacks);
  const task = createTalkTaskConfirmation({
    speak: (text) => channel.onPrompt(text, "confirm"),
    changed: () => channel.onChanged(),
    confirmed: (value) => callbacks.confirmed(value),
    interrupted: (text) => callbacks.interrupted?.(text),
  });
  return {
    propose: task.propose,
    transcript: channel.transcript,
    turn: channel.turn,
    delegate: channel.delegate,
    cancel: channel.cancel,
    get pending() { return task.pending; },
    get commits() { return channel.commits; },
    view: channel.view,
  };
}
