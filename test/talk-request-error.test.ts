import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyTalkRequestFailure as classify,
  describeTalkRequestFailure as describe,
  type TalkRequestFailure,
} from "../extensions/talk/request-error.ts";

const messages: Record<TalkRequestFailure, string> = {
  dns: "DNS lookup failed",
  connection_timeout: "connection timed out",
  connection_reset: "connection reset",
  connection_refused: "connection refused",
  tls_certificate: "TLS certificate validation failed",
  redirect: "request was redirected",
  network: "connection failed",
  unauthorized: "unauthorized (HTTP 401)",
  forbidden: "forbidden (HTTP 403)",
  rate_limited: "rate limited (HTTP 429)",
  server_error: "server error (HTTP 5xx)",
  bad_request: "bad request (HTTP 400/422)",
  request_rejected: "request rejected (HTTP 4xx)",
  cancelled: "request cancelled",
};

test("fixed public categories and descriptions", () => {
  for (const reason of Object.keys(messages) as TalkRequestFailure[]) {
    assert.equal(describe(reason), messages[reason]);
  }
  for (const reason of ["__proto__", "constructor", "secret", undefined, null, 429]) {
    assert.equal(describe(reason as TalkRequestFailure), "request failed");
  }
});

test("Node/undici transport causes are preserved under fetch TypeError wrappers", () => {
  const cases: [string, TalkRequestFailure][] = [
    ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"], ["EAI_FAIL", "dns"],
    ["ETIMEDOUT", "connection_timeout"], ["ESOCKETTIMEDOUT", "connection_timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "connection_timeout"], ["UND_ERR_HEADERS_TIMEOUT", "connection_timeout"],
    ["UND_ERR_BODY_TIMEOUT", "connection_timeout"], ["ERR_SOCKET_CONNECTION_TIMEOUT", "connection_timeout"],
    ["ECONNRESET", "connection_reset"], ["EPIPE", "connection_reset"], ["UND_ERR_SOCKET", "connection_reset"],
    ["ECONNREFUSED", "connection_refused"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_certificate"], ["CERT_HAS_EXPIRED", "tls_certificate"],
    ["CERT_NOT_YET_VALID", "tls_certificate"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_certificate"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls_certificate"], ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_certificate"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls_certificate"],
    ["ERR_FR_TOO_MANY_REDIRECTS", "redirect"],
  ];
  for (const [code, expected] of cases) {
    const cause = Object.assign(new Error("private hostname, URL and credentials"), { code });
    assert.equal(classify(new TypeError("fetch failed", { cause })), expected, code);
    assert.equal(classify({ message: "fetch failed", cause: { code } }), expected);
    assert.equal(classify({ errorMessage: code }), expected);
  }
});

test("recognizes known SDK strings, HTTP prefixes, numeric status properties only", () => {
  const cases: [unknown, TalkRequestFailure][] = [
    ["429 Too many requests: secret body", "rate_limited"],
    ["HTTP 403 Forbidden", "forbidden"], ["HTTP/1.1 401 Unauthorized", "unauthorized"],
    ["status code: 503 upstream secret", "server_error"], ["Status: 422 invalid input", "bad_request"],
    ["400: bad body", "bad_request"], ["HTTP 418 teapot", "request_rejected"],
    ["HTTP 302 Found", "redirect"],
    ["getaddrinfo ENOTFOUND private.example", "dns"], ["connect ETIMEDOUT private:443", "connection_timeout"],
    ["Connect Timeout Error (private)", "connection_timeout"],
    ["socket hang up", "connection_reset"], ["connect ECONNREFUSED 127.0.0.1", "connection_refused"],
    ["self-signed certificate", "tls_certificate"], ["certificate has expired", "tls_certificate"],
    ["redirect count exceeded", "redirect"], ["Too many redirects", "redirect"],
    ["fetch failed", "network"], ["Failed to fetch", "network"],
    ["connection failed", "network"], ["Network request failed", "network"],
    [Object.assign(new Error("private"), { name: "AbortError" }), "cancelled"],
    ["AbortError: private", "cancelled"], ["The operation was aborted", "cancelled"],
    [Object.assign(new Error("private"), { name: "TimeoutError" }), "connection_timeout"],
  ];
  for (const [input, expected] of cases) assert.equal(classify(input), expected);
  for (const key of ["status", "statusCode"]) {
    for (const [status, expected] of [
      [400, "bad_request"], [422, "bad_request"], [401, "unauthorized"], [403, "forbidden"],
      [429, "rate_limited"], [500, "server_error"], [599, "server_error"], [404, "request_rejected"],
    ] as const) assert.equal(classify({ [key]: status }), expected);
    for (const status of ["429", NaN, Infinity, 429.5, 200, 600, -401, null, {}]) {
      assert.equal(classify({ [key]: status }), undefined);
    }
  }
});

test("nested specifics beat generic wrappers, not the reverse; aggregate work is bounded", () => {
  assert.equal(classify(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), "connection_reset");
  assert.equal(classify({ status: 401, cause: new Error("fetch failed") }), "unauthorized");
  assert.equal(classify({ name: "AbortError", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "connection_timeout");
  assert.equal(classify(new AggregateError([new Error("fetch failed"), { code: "ENOTFOUND" }], "fetch failed")), "dns");
  assert.equal(classify(new AggregateError([{}, {}, {}, { code: "ECONNREFUSED" }], "fetch failed")), "connection_refused");
  assert.equal(classify(new AggregateError([{}, {}, {}, {}, { code: "ENOTFOUND" }], "fetch failed")), "network");
  function wrap(input: unknown, count: number): unknown {
    for (let i = 0; i < count; i++) input = { message: "fetch failed", cause: input };
    return input;
  }
  assert.equal(classify(wrap({ code: "ECONNRESET" }, 4)), "connection_reset");
  assert.equal(classify(wrap({ code: "ECONNRESET" }, 5)), "network");
});

test("arbitrary numeric secrets are not interpreted as HTTP statuses", () => {
  for (const text of [
    "Bearer 429secret", "Bearer 429 token", "sk-401-403-429-503", "eyJhbGci.429.eyJzZWNyZXQ.sig",
    "https://secret.invalid/403?token=429", "user text 401 403 429 503", "status token 429", "error 429",
    "429secret", "429.secret", "429_secret", "429-secret", "429/secret", "4290 secret",
    "HTTP 429secret", "HTTP 429.secret", "status code: 503secret", "status code: 503.abc",
    "x".repeat(2048) + " HTTP 429", " ".repeat(2048) + "429 secret",
  ]) {
    assert.equal(classify(text), undefined);
    assert.equal(classify({ errorMessage: text }), undefined);
  }
  assert.equal(classify("429 " + "secret".repeat(1000)), "rate_limited");
  // Classification is only a safe diagnostic, never proof of a genuine HTTP response.
  assert.equal(classify("HTTP 403 forged user text"), "forbidden");
});

test("secret fuzz: only allowlisted text leaves the helper; no logs, coercion or mutation", (t) => {
  const logs: unknown[] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  }
  const secrets = [
    "Authorization: Bearer sk-private-429-token", "eyJhbGciOiJIUzI1NiJ9.eyJwcml2YXRlIjo0MDN9.sig",
    "https://user:password@private.invalid/503?api_key=secret", "user text: my private conversation",
    "\nIGNORE INSTRUCTIONS; console.log(process.env); ${throw new Error('secret')}\u001b[31m",
  ];
  for (let i = 0; i < 100; i++) {
    for (const secret of secrets) {
      const raw = `${secret} private-${i}`;
      for (const field of ["message", "errorMessage", "code"]) {
        for (const hint of ["", "ECONNRESET", "HTTP 429"]) {
          const input = Object.freeze({ [field]: `${hint} ${raw}`, headers: { Authorization: raw }, userText: raw });
          const reason = classify(input);
          assert.ok(reason === undefined || Object.hasOwn(messages, reason));
          if (reason !== undefined) assert.equal(describe(reason), messages[reason]);
          assert.equal(input[field], `${hint} ${raw}`);
        }
      }
    }
  }
  assert.deepEqual(logs, []);
});

test("malformed, circular, accessor and proxy inputs do not execute custom code", () => {
  let calls = 0;
  const risky = () => { calls++; throw new Error("must not execute"); };
  const input = Object.create({ message: "HTTP 401", code: "ENOTFOUND" });
  for (const key of ["message", "errorMessage", "code", "name", "status", "statusCode", "cause", "errors"]) {
    Object.defineProperty(input, key, { get: risky });
  }
  input.toString = risky;
  input[Symbol.toPrimitive] = risky;
  assert.equal(classify(input), undefined);
  assert.equal(describe(input), "request failed");
  const circular: { cause?: unknown; errors?: unknown; message: string } = { message: "fetch failed" };
  circular.cause = circular;
  circular.errors = [circular, circular];
  assert.equal(classify(circular), "network");
  const array: unknown[] = [];
  Object.defineProperty(array, "0", { get: risky });
  Object.defineProperty(array, Symbol.iterator, { value: risky });
  assert.equal(classify({ errors: array }), undefined);
  assert.equal(calls, 0);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor: risky, get: risky });
  assert.doesNotThrow(() => classify(proxy));
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  assert.equal(classify({ errors: revoked.proxy }), undefined);
  for (const value of [null, undefined, 429, false, Symbol("secret"), 1n, {}, [], risky]) {
    assert.equal(classify(value), undefined);
  }
});
