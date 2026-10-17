import assert from "node:assert/strict";
import test from "node:test";
import { isVagueTalkTask } from "../extensions/talk/handoff.ts";

test("recognizes bare acknowledgments and complete deictic commands", () => {
  for (const input of [
    "Okay, do it", "alright lets do it", "Do that", "go ahead", "go ahead with it",
    "continue", "proceed", "test it", "try that", "check that", "kör på",
    "gör det", "fortsätt", "Okay", "Yes", "uh... okay, go ahead with it!",
    "JA", "okej — fortsätt", "yeah, do that…",
  ]) assert.equal(isVagueTalkTask(input), true, input);
});

test("keeps concrete tasks, greetings, negation, and embedded labels intact", () => {
  for (const input of [
    "Inspect package.json", "Run questionnaire voice test", "Check the image pasted into Pi",
    "Do it by running npm test", "Hello", "Hello there", "Do not do it",
    "Do it, then explain the result", "test it in package.json", "okay, inspect package.json",
    "continue the migration", "go ahead and run npm test", "okay-go-ahead.ts",
  ]) assert.equal(isVagueTalkTask(input), false, input);
});

test("does not trim or rewrite the task and safely rejects oversized input", () => {
  assert.equal(isVagueTalkTask("  Okay.  "), true);
  assert.equal(isVagueTalkTask("x".repeat(8193)), false);
  assert.equal(isVagueTalkTask("😀".repeat(5000)), false);
});
