export type FaceTimeCallMedia = "audio" | "video";

/** Default only when omitted; unknown values must never select another medium. */
export function faceTimeCallMedia(value: unknown): FaceTimeCallMedia {
  if (value === undefined) return "audio";
  if (value === "audio" || value === "video") return value;
  throw new Error("FaceTime call media must be audio or video");
}

export function validateFaceTimeCallPurpose(purpose: unknown): asserts purpose is string | undefined {
  if (purpose !== undefined && (typeof purpose !== "string" || !purpose.trim() || Buffer.byteLength(purpose) > 300 ||
    Buffer.from(purpose).toString("utf8") !== purpose || /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(purpose))) {
    throw new Error("FaceTime call purpose must be nonempty safe text, at most 300 UTF-8 bytes");
  }
}

export const FACETIME_CALL_USAGE = "Usage: /talk facetime call [--audio|--video] [--reason CALL_PURPOSE]";

/** Media must precede --reason, which consumes the remaining plain text. No recipient argument. */
export function parseFaceTimeCallArguments(input: string): { media: FaceTimeCallMedia; purpose?: string } {
  if (Buffer.byteLength(input) > 1024) throw new Error(FACETIME_CALL_USAGE);
  const tokens = input.trim() ? input.trim().split(/\s+/) : [];
  let media: FaceTimeCallMedia = "audio";
  if (/^--(?:audio|video)$/i.test(tokens[0] ?? "")) media = tokens.shift()!.toLowerCase().slice(2) as FaceTimeCallMedia;
  if (!tokens.length) return { media };
  if (tokens.shift()?.toLowerCase() !== "--reason" || !tokens.length || tokens.some(token => token.startsWith("--"))) {
    throw new Error(FACETIME_CALL_USAGE);
  }
  const purpose = tokens.join(" ");
  validateFaceTimeCallPurpose(purpose);
  return { media, purpose };
}
