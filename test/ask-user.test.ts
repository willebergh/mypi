import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAskUserResult,
  normalizeQuestions,
} from "../extensions/ask-user/core.ts";

test("normalizes single and multiple-answer questions", () => {
  assert.deepEqual(
    normalizeQuestions([
      {
        id: "framework",
        question: "Which framework?",
        options: [{ label: "React", description: "Web UI" }],
      },
      {
        id: "features",
        label: "Features",
        question: "Which features?",
        mode: "multiple",
        options: [{ label: "Auth" }, { label: "Billing" }],
      },
    ]),
    [
      {
        id: "framework",
        label: "Q1",
        question: "Which framework?",
        mode: "single",
        options: [{ label: "React", description: "Web UI" }],
      },
      {
        id: "features",
        label: "Features",
        question: "Which features?",
        mode: "multiple",
        options: [
          { label: "Auth", description: undefined },
          { label: "Billing", description: undefined },
        ],
      },
    ],
  );
});

test("rejects malformed questionnaires", () => {
  assert.throws(() => normalizeQuestions([]), /At least one/);
  assert.throws(
    () =>
      normalizeQuestions([
        { id: "same", question: "First?" },
        { id: "same", question: "Second?" },
      ]),
    /Duplicate question id/,
  );
  assert.throws(
    () =>
      normalizeQuestions([
        {
          id: "duplicate-options",
          question: "Choose",
          options: [{ label: "A" }, { label: "A" }],
        },
      ]),
    /duplicate option/,
  );
});

test("formats selected, free-text, and skipped answers", () => {
  const text = formatAskUserResult({
    questions: [],
    cancelled: false,
    answers: [
      {
        id: "scope",
        question: "Scope?",
        skipped: false,
        answers: [
          { label: "API", custom: false },
          { label: "And docs", custom: true },
        ],
      },
      {
        id: "deadline",
        question: "Deadline?",
        skipped: true,
        answers: [],
      },
    ],
  });
  assert.equal(text, "scope: API, And docs (free text)\ndeadline: skipped");
});
