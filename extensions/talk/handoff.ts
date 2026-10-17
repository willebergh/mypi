/** True when a delegated task is only an acknowledgment or deictic command. */
export function isVagueTalkTask(input: string): boolean {
  if (typeof input !== "string" || input.length > 8 * 1024) return false;

  // Only normalize for classification: preserve the original task at the call site.
  const task = input.normalize("NFC").toLocaleLowerCase("sv-SE").trim();
  if (!task) return false;

  // Restrict the accepted vocabulary and punctuation so concrete instructions,
  // negations, greetings, and labels embedded in larger tasks are unaffected.
  const filler = String.raw`(?:(?:uh|um|okay|ok|alright|yeah|yes|so|ja|okej)[\s\p{P}]*)*`;
  const atom = String.raw`(?:do\s+(?:it|that)|go\s+ahead(?:\s+with\s+it)?|let'?s\s+do\s+it|continue|proceed|test\s+it|try\s+that|check\s+that|kör\s+på|gör\s+det|fortsätt)`;
  return new RegExp(`^${filler}(?:${atom})?[\\s\\p{P}]*$`, "iu").test(task);
}
