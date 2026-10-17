type Role = "user" | "assistant";
type EscapeState = "text" | "escape" | "intermediate" | "csi" | "string" | "stringEscape";

/** Remove terminal commands and invisible direction/control characters, not spoken text. */
export function sanitizeTalkText(input: string): string {
  let state: EscapeState = "text";
  let text = "";
  for (const char of input.replace(/\r\n/g, "\n")) {
    const code = char.codePointAt(0)!;
    if (state === "string" || state === "stringEscape") {
      if (char === "\x07" || char === "\x9c" || (state === "stringEscape" && char === "\\")) state = "text";
      else state = char === "\x1b" ? "stringEscape" : "string";
      continue;
    }
    if (char === "\x1b") { state = "escape"; continue; }
    if (char === "\x9b") { state = "csi"; continue; }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { state = "string"; continue; }
    if (state === "escape") {
      if (char === "[") state = "csi";
      else if ("]PX^_".includes(char)) state = "string";
      else state = code >= 0x20 && code <= 0x2f ? "intermediate" : "text";
      continue;
    }
    if (state === "intermediate") {
      if (code >= 0x30 && code <= 0x7e) state = "text";
      continue;
    }
    if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) state = "text";
      continue;
    }
    if ((code < 0x20 && char !== "\n" && char !== "\t") || (code >= 0x7f && code <= 0x9f)) continue;
    if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u.test(char)) continue;
    // Discard invalid Unicode and noncharacters.
    if ((code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) continue;
    text += char;
  }
  return text;
}

/** One literal, text-only Talk turn; provenance belongs in message details. */
export function formatTalkMessage(role: Role, text: string): string {
  const body = sanitizeTalkText(text).trim().replace(/\[\/?talk:(?:user|assistant)\]/g, "\\$&");
  return `[talk:${role}]\n${body}`;
}
