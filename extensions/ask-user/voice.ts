import type { AskUserResult, UserQuestion } from "./core.ts";

export const ASK_USER_VOICE_REQUEST_EVENT = "mypi:ask-user-voice-request";

export interface VoiceQuestionRequest {
  questions: UserQuestion[];
  signal?: AbortSignal;
  claim(handler: () => Promise<AskUserResult | undefined>): boolean;
}

/** Only a synchronous listener may claim; the first claim wins. */
export function requestVoiceQuestions(
  events: { emit(name: string, data: unknown): void },
  questions: UserQuestion[],
  signal?: AbortSignal,
): Promise<AskUserResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let accepting = true;
    let handler: (() => Promise<AskUserResult | undefined>) | undefined;
    const cancelled = (): AskUserResult => ({ questions, answers: [], cancelled: true });
    const finish = (result: AskUserResult | undefined) => {
      if (settled) return;
      settled = true;
      accepting = false;
      signal?.removeEventListener("abort", abort);
      resolve(signal?.aborted ? cancelled() : result);
    };
    const abort = () => finish(cancelled());
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      events.emit(ASK_USER_VOICE_REQUEST_EVENT, {
        questions,
        signal,
        claim(candidate) {
          if (!accepting || settled || handler) return false;
          handler = candidate;
          return true;
        },
      } satisfies VoiceQuestionRequest);
    } catch {
      finish(undefined);
      return;
    } finally {
      accepting = false;
    }
    if (settled) return;
    if (!handler) { finish(undefined); return; }
    try {
      Promise.resolve(handler()).then(finish, () => finish(undefined));
    } catch {
      finish(undefined);
    }
  });
}
