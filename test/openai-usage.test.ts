import assert from "node:assert/strict";
import test from "node:test";
import {
  accountIdFromToken,
  formatOpenAiUsageState,
  parseOpenAiUsage,
} from "../extensions/openai-usage/core.ts";

function jwt(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("extracts the ChatGPT account id from an OAuth token", () => {
  const token = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
  });
  assert.equal(accountIdFromToken(token), "account-123");
  assert.equal(accountIdFromToken("not-a-jwt"), undefined);
});

test("parses primary and secondary subscription windows", () => {
  const snapshot = parseOpenAiUsage(
    {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_after_seconds: 7_200,
        },
        secondary_window: {
          remaining_percent: 40,
          limit_window_seconds: 604_800,
          reset_after_seconds: 259_200,
        },
      },
    },
    1_000,
  );

  assert.equal(snapshot.planType, "plus");
  assert.deepEqual(snapshot.primary, {
    label: "5h",
    remainingPercent: 75,
    usedPercent: 25,
    resetAt: undefined,
    resetAfterSeconds: 7_200,
    windowSeconds: 18_000,
  });
  assert.equal(snapshot.secondary?.remainingPercent, 40);
  assert.equal(snapshot.updatedAt, 1_000);
});

test("formats subscription limits for the status widget", () => {
  const text = formatOpenAiUsageState({
    status: "ready",
    snapshot: {
      planType: "plus",
      updatedAt: 0,
      primary: {
        label: "5h",
        remainingPercent: 75,
        resetAfterSeconds: 7_200,
      },
      secondary: {
        label: "weekly",
        remainingPercent: 40,
        resetAfterSeconds: 259_200,
      },
    },
  });
  assert.equal(
    text,
    "OpenAI (plus): 5h 75% left ↻2h · weekly 40% left ↻3d",
  );
});
