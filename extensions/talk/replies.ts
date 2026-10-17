import { Buffer } from "node:buffer";

export interface TalkReply {
  kind: "confirm" | "reject" | "repeat" | "cancel" | "keyboard" | "other";
  remainder?: string;
}

const affirmative = /^(?:yes please|that's right|that’s right|that is right|det stämmer|ja tack|yes|yeah|yep|correct|confirm|javisst|japp|ja)(?=$|[\s,.!?;:])/iu;
const negative = /^(?:no thanks|no thank you|nej tack|no|nej|change|ändra)(?=$|[\s,.!?;:])/iu;
const cancellation = /^(?:never mind|nevermind|cancel|avbryt|strunta i det)(?=$|[\s,.!?;:])/iu;
// Deliberately conservative: a qualified/contradictory yes is NOT approval.
const qualification = /(?<![\p{L}\p{N}_])(?:but|if|unless|except|maybe|perhaps|possibly|probably|guess|no|nope|not|never|don['’]t|do not|can['’]t|won['’]t|instead|rather|actually|cancel|stop|wait|change|men|om|inte|nej|aldrig|kanske|avbryt|istället|hellre|vänta|ändra)(?![\p{L}\p{N}_])/iu;

/** Bounded, context-free recognition of final USER speech, not assistant text.
 * `other` retains the whole actual utterance; split remainders only remove the
 * recognized prefix and its punctuation/spacing, never paraphrase the request.
 * Callers own phase/option interpretation and the 4 KiB transport limit.
 */
export function parseTalkReply(text: string): TalkReply {
  const other = (): TalkReply => ({ kind: "other", remainder: text });
  if (Buffer.byteLength(text) > 4096 + 64) return other();
  const value = text.trimStart();
  const pure = value.trim().replace(/[.!]+$/u, "").trim().toLowerCase();
  if (["repeat", "repeat please", "upprepa", "upprepa tack", "säg igen"].includes(pure)) return { kind: "repeat" };
  if (["keyboard", "terminal", "tangentbord", "tangentbordet"].includes(pure)) return { kind: "keyboard" };
  const split = (match: RegExpMatchArray, kind: TalkReply["kind"]): TalkReply => {
    const rest = value.slice(match[0].length);
    if (/^[\s,.!;:]*\?/u.test(rest)) return other();
    const remainder = rest.replace(/^[\s,.!;:]+/u, "");
    return remainder.trim() ? { kind, remainder } : { kind };
  };
  if (/^(?:(?:yes|yeah|yep)[,\s]+please|ja[,\s]+tack|(?:yes|yeah|yep|ja|japp|javisst)[,\s]+(?:that's right|that’s right|correct|det stämmer))$/iu.test(pure)) return { kind: "confirm" };
  if (/^(?:no[,\s]+(?:thanks|thank you)|nej[,\s]+tack)$/iu.test(pure)) return { kind: "reject" };
  const cancel = value.match(cancellation);
  if (cancel) return split(cancel, "cancel");
  const yes = value.match(affirmative);
  if (yes) {
    if (qualification.test(value.slice(yes[0].length))) return other();
    return split(yes, "confirm");
  }
  const no = value.match(negative);
  if (no) return split(no, "reject");
  return other();
}
