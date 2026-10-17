import assert from "node:assert/strict";
import test from "node:test";
import { liveServiceError } from "../extensions/talk/diagnostics.ts";

const token = "current-codex-credential";
const headers = { Authorization: `Bearer ${token}`, "chatgpt-account-id": "private-account-id" };

test("Live diagnostics distinguish scope errors from invalid session parameters", () => {
  const auth = liveServiceError({
    code: "missing_scope", type: "authorization_error", message: "The credential lacks Live session access.",
  }, headers, "startup");
  assert.match(auth, /missing_scope/);
  assert.match(auth, /authorization_error/);
  assert.match(auth, /lacks Live session access/);
  const config = liveServiceError({
    code: "invalid_value", type: "invalid_request_error", param: "session.audio.output.voice",
    message: "Unsupported voice selection.",
  }, headers, "startup");
  assert.match(config, /param=session.audio.output.voice/);
  assert.match(config, /Unsupported voice selection/);
});

test("Live diagnostics redact known credentials from every server field", () => {
  const error = liveServiceError({
    code: token, type: `Bearer ${token}`, param: "private-account-id",
    message: `Rejected Authorization: Bearer ${token}, account private-account-id.`,
  }, headers, "startup");
  assert.doesNotMatch(error, /current-codex-credential|private-account-id/);
  assert.match(error, /\[redacted\]/);
});

test("Live diagnostics redact credential patterns and terminal control sequences", () => {
  const error = liveServiceError({ message:
    "\x1b[31mBearer another-credential eyJhbGciOiJub25l.eyJzdWIiOiJ4In0.signature123 " +
    "sk-proj-1234567890 https://example.test/?access_token=private-query-token&ok=1\nproblem",
  }, headers, "active");
  assert.doesNotMatch(error, /another-credential|eyJhbGci|sk-proj|private-query-token|[\x00-\x1f\x7f]/);
  assert.match(error, /problem/);
});

test("redaction precedes truncation and malformed diagnostics cannot dump event objects", () => {
  const error = liveServiceError({ message: "x".repeat(395) + token + "tail", nested: headers }, headers, "startup");
  assert.doesNotMatch(error, /current-codex/);
  assert.ok(error.length < 500);
  for (const value of [undefined, null, [], token, { message: headers, code: {} }]) {
    assert.equal(liveServiceError(value, headers, "startup"), "Live service error during startup");
  }
});
