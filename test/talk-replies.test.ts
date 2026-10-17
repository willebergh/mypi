import assert from "node:assert/strict";
import test from "node:test";
import { parseTalkReply } from "../extensions/talk/replies.ts";

test("natural pure English and Swedish acknowledgements", () => {
  for (const text of ["Yes", "Yeah!", "yep", "Yes please.", "Yes, please!", "Ja, tack.", "That's right", "That’s right!", "Correct", "confirm", "Ja", "japp", "javisst", "Ja tack", "Det stämmer."]) {
    assert.deepEqual(parseTalkReply(text), { kind: "confirm" }, text);
  }
  for (const text of ["No", "No thanks.", "No, thanks!", "No thank you", "Nej, tack.", "Nej", "Nej tack!", "change", "ändra"]) {
    assert.deepEqual(parseTalkReply(text), { kind: "reject" }, text);
  }
});

test("commands in both languages and cancellation with a request", () => {
  for (const text of ["Repeat", "upprepa", "säg igen", "upprepa tack!"]) assert.deepEqual(parseTalkReply(text), { kind: "repeat" });
  for (const text of ["Cancel", "avbryt", "never mind", "strunta i det"]) assert.deepEqual(parseTalkReply(text), { kind: "cancel" });
  for (const text of ["Keyboard", "terminal", "tangentbord", "tangentbordet"]) assert.deepEqual(parseTalkReply(text), { kind: "keyboard" });
  assert.deepEqual(parseTalkReply("Cancel, look at the image."), { kind: "cancel", remainder: "look at the image." });
  assert.deepEqual(parseTalkReply("No Green"), { kind: "reject", remainder: "Green" });
});

test("affirmation splits without paraphrasing substantive speech", () => {
  for (const prefix of ["Yes, ", "Yes ", "Yeah. ", "Ja tack, ", "Det stämmer. "]) {
    const remainder = 'I just sent an image. Tell Pi to look at the image — "original".  ';
    assert.deepEqual(parseTalkReply(prefix + remainder), { kind: "confirm", remainder });
  }
});

test("ambiguous/conditional/contradictory affirmations retain full speech without approval", () => {
  for (const text of ["yes but don't run it", "yes if it is safe", "yeah no", "yes?", "Yes!?", "yes, unless it deletes data", "ja men inte det", "ja om det fungerar", "yesterday", "yesn't", "yes maybe", "yes I guess", "ja kanske", "I think yes", "yes no thanks", "Yes, instead choose Beta", "Ja, avbryt", "Yes, cancel", "Ja, ändra svaret", "Yes actually choose the other option"]) {
    assert.deepEqual(parseTalkReply(text), { kind: "other", remainder: text }, text);
  }
});

test("unrecognized speech and over-limit input are not rewritten or parsed as approval", () => {
  for (const text of ["", "  Tell Pi what happened?  ", "<think>yes</think>", "Yes " + "界".repeat(4096)]) {
    assert.deepEqual(parseTalkReply(text), { kind: "other", remainder: text });
  }
});
