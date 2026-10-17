import { Buffer } from "node:buffer";

// Allow ordinary transcript whitespace, but never hidden controls, bidi overrides,
// or malformed Unicode (the /u flag leaves valid surrogate pairs alone).
const unsafe = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
const annotations = /\[(?:breath|breathing|chuckle|chuckling|laughter|laughs|sigh|noise|cough)(?:\]|(?=\s*$))/giu;

function clean(text: string): string {
  // A separator avoids manufacturing a word from speech on either side of a tag.
  return text.replace(annotations, " ").trim();
}

function fold(text: string): string {
  // Upper/lower expansion handles Unicode caseless pairs and expansions (ß,
  // ligatures, Greek sigma), without incorrectly equating dotless ı with i.
  return Array.from(text.normalize("NFKC"), (char) =>
    char === "ı" ? char : char.toUpperCase().toLowerCase(),
  ).join("").replace(/ß/gu, "ss").normalize("NFKC");
}

function tokens(text: string): { word: string; offset: number }[] {
  // Keep combining marks attached to their base, including decomposed Swedish.
  return Array.from(text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu), (match) => ({
    word: fold(match[0]), offset: match.index,
  }));
}

/**
 * Verify ordinary delegated reply text against the exact ASR captured since the
 * prompt. Callers must append ASR chunks verbatim, including server whitespace;
 * this matcher neither infers chunk boundaries nor grants any authorization.
 */
export function heardSpeechSuffix(raw: string, delegated: string): string | undefined {
  if (typeof raw !== "string" || typeof delegated !== "string" ||
    raw.length > 4160 || delegated.length > 8192 ||
    Buffer.byteLength(raw, "utf8") > 4160 || Buffer.byteLength(delegated, "utf8") > 8192 ||
    unsafe.test(raw) || unsafe.test(delegated)) return undefined;

  const heard = clean(raw);
  const actual = tokens(heard);
  const proposed = tokens(clean(delegated));
  if (!proposed.length || proposed.length > actual.length) return undefined;
  const start = actual.length - proposed.length;
  if (!proposed.every((token, i) => token.word === actual[start + i].word)) return undefined;

  // Never return model spelling, punctuation, or spacing. For a whole-transcript
  // match, retain leading punctuation as well as everything after the last word.
  return heard.slice(start === 0 ? 0 : actual[start].offset).trim();
}
