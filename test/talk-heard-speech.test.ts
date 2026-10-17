import assert from "node:assert/strict";
import test from "node:test";
import { heardSpeechSuffix } from "../extensions/talk/heard-speech.ts";

test("matches only a complete token suffix, never a prefix, substring, or paraphrase", () => {
  assert.equal(heardSpeechSuffix("One. Quiet handoffs", "Quiet handoffs"), "Quiet handoffs");
  assert.equal(heardSpeechSuffix("One. Quiet handoffs", "one quiet handoffs"), "One. Quiet handoffs");
  for (const [raw, delegated] of [
    ["Someone", "One"], ["One", "Someone"], ["yes but do not proceed", "Yes"],
    ["Yes. No.", "Yes"], ["Quiet handoffs", "Silent handoffs"],
    ["heard request", "new model text"], ["yes no", "no yes"],
    ["yes", "yes yes"], ["handoffs", "hand offs"],
  ]) assert.equal(heardSpeechSuffix(raw, delegated), undefined, `${raw} / ${delegated}`);
  assert.equal(heardSpeechSuffix("yes no yes", "yes"), "yes");
});

test("returns actual ASR case, punctuation, Unicode, and interior whitespace", () => {
  const raw = "  ‘Please’ inspect `Foo.ts`,  KEEP $BAR!\n\tDo NOT edit… 😀  ";
  assert.equal(heardSpeechSuffix(raw, "please inspect foo ts keep bar do not edit"), raw.trim());
  assert.equal(heardSpeechSuffix("Earlier. Fix  Foo.ts,\n\tNOT bar!  ", "fix foo ts not bar"),
    "Fix  Foo.ts,\n\tNOT bar!");
  assert.equal(heardSpeechSuffix("YES!", "yes?"), "YES!");
});

test("Unicode normalization and caseless matching retain the original offsets", () => {
  const swedish = "A\u0308ndra pa\u030a sma\u030a o\u0308ar!";
  assert.equal(heardSpeechSuffix(`Först. ${swedish}`, "ÄNDRA PÅ SMÅ ÖAR"), swedish);
  assert.equal(heardSpeechSuffix("Ｆｉｘ １２３", "fix 123"), "Ｆｉｘ １２３");
  assert.equal(heardSpeechSuffix("Straße Σςσ", "STRASSE σσσ"), "Straße Σςσ");
  assert.equal(heardSpeechSuffix("café", "cafe"), undefined);
  assert.equal(heardSpeechSuffix("ı", "i"), undefined);
  assert.equal(heardSpeechSuffix("😀 Before. ÖAR!", "öar"), "ÖAR!");
});

test("only the enumerated whole non-speech annotations are removed on both sides", () => {
  for (const tag of ["breath", "breathing", "chuckle", "chuckling", "laughter", "laughs", "sigh", "noise", "cough"]) {
    assert.equal(heardSpeechSuffix(` [${tag}] YES [${tag}] `, "Yes"), "YES");
    assert.equal(heardSpeechSuffix("YES", `[${tag.toUpperCase()}] Yes [${tag}]`), "YES");
    assert.equal(heardSpeechSuffix(`YES [${tag}`, "Yes"), "YES");
    assert.equal(heardSpeechSuffix(`[${tag}]`, "Yes"), undefined);
    assert.equal(heardSpeechSuffix("YES", `[${tag}]`), undefined);
  }
  assert.equal(heardSpeechSuffix("YES [breath", "Yes"), "YES");
  assert.equal(heardSpeechSuffix("one[breath]two", "one two"), "one two");
  assert.equal(heardSpeechSuffix("one[breath]two", "onetwo"), undefined);
  assert.equal(heardSpeechSuffix("yes [noise]  please!", "yes please"), "yes    please!");
  for (const raw of ["YES [file]", "YES breath", "YES [breathless]", "YES [breath later", "YES [brea", "YES [pause]"]) {
    assert.equal(heardSpeechSuffix(raw, "yes"), undefined, raw);
  }
  for (const raw of ["[file]", "breath", "[breathless]", "[pause]"]) {
    assert.equal(heardSpeechSuffix(raw, raw), raw);
  }
  assert.equal(heardSpeechSuffix("[chuckle] yes but no", "[chuckling] yes"), undefined);
});

test("empty speech and annotation/punctuation-only delegations cannot match", () => {
  for (const raw of ["", " \n\t\r ", "…!? 😀", "[breath] [noise]", "[breath"]) {
    assert.equal(heardSpeechSuffix(raw, "yes"), undefined);
    assert.equal(heardSpeechSuffix(raw, raw), undefined);
  }
  for (const delegated of ["", " ", "?!", "[chuckle]", "[breath"]) {
    assert.equal(heardSpeechSuffix("yes", delegated), undefined);
  }
});

test("numbers and opaque tokens are ordinary literal speech, not privileged aliases", () => {
  for (const raw of ["12345", "550e8400-e29b-41d4-a716-446655440000", "aBcDeF987"]) {
    assert.equal(heardSpeechSuffix(raw, raw.toLowerCase()), raw);
    assert.equal(heardSpeechSuffix("not present", raw), undefined);
  }
  for (const [raw, delegated] of [["one", "1"], ["1", "one"], ["twenty two", "22"], ["01", "1"]]) {
    assert.equal(heardSpeechSuffix(raw, delegated), undefined);
  }
});

test("ASR chunks must be appended literally, without invented word boundaries", () => {
  assert.equal(heardSpeechSuffix(["Some", "one"].join(""), "one"), undefined);
  assert.equal(heardSpeechSuffix(["Some", " one"].join(""), "one"), "one");
  assert.equal(heardSpeechSuffix(["YES", " but", " do not"].join(""), "yes"), undefined);
  assert.equal(heardSpeechSuffix(["YES [bre", "ath]"].join(""), "yes"), "YES");
});

test("byte budgets are inclusive, checked before cleanup, and never truncated", () => {
  for (const raw of ["x".repeat(4160), "界".repeat(1386) + "xx", "😀".repeat(1039) + " yes"]) {
    assert.equal(Buffer.byteLength(raw), 4160);
    assert.equal(heardSpeechSuffix(raw, raw), raw);
    assert.equal(heardSpeechSuffix(raw + " ", raw), undefined);
  }
  const delegated = "yes" + " ".repeat(8189);
  assert.equal(heardSpeechSuffix("yes", delegated), "yes");
  assert.equal(heardSpeechSuffix("yes", delegated + " "), undefined);
  assert.equal(heardSpeechSuffix("yes", "yes" + "😀".repeat(2047) + " "), "yes");
  assert.equal(heardSpeechSuffix("yes", "yes" + "😀".repeat(2047) + "  "), undefined);
  assert.equal(heardSpeechSuffix("yes" + "[breath]".repeat(600), "yes"), undefined);
});

test("rejects unsafe controls, bidi, and lone surrogates in either input", () => {
  const bad = ["\x00", "\x08", "\x0b", "\x0c", "\x1b", "\x1f", "\x7f", "\x85", "\x9f",
    "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\ud800", "\udfff"];
  for (const char of bad) {
    assert.equal(heardSpeechSuffix(`yes${char}`, "yes"), undefined);
    assert.equal(heardSpeechSuffix("yes", `yes${char}`), undefined);
    assert.equal(heardSpeechSuffix(`${char} [breath] yes`, "yes"), undefined);
  }
  assert.equal(heardSpeechSuffix(" \tYES\r\n please 😀 ", "yes\nplease"), "YES\r\n please 😀");
});
