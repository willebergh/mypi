const MESSAGES = {
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
} as const;

export type TalkRequestFailure = keyof typeof MESSAGES;

/** Never format, retain, or return upstream values, even for invalid runtime input. */
export function describeTalkRequestFailure(reason: TalkRequestFailure): string {
  if (typeof reason !== "string") return "request failed";
  return (ownValue(MESSAGES, reason) as string | undefined) ?? "request failed";
}

// Accessors (including Error subclass accessors) and custom coercions are not run.
// Descriptor traps on proxies may throw; such properties are simply unavailable.
function ownValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function httpFailure(status: unknown): TalkRequestFailure | undefined {
  if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
  switch (status) {
    case 400: case 422: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 429: return "rate_limited";
  }
  if (status >= 500 && status <= 599) return "server_error";
  if (status >= 400 && status <= 499) return "request_rejected";
  if (status >= 300 && status <= 399) return "redirect";
  return undefined;
}

function textFailure(value: unknown): TalkRequestFailure | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, 2048);
  // Only error prefixes, never arbitrary digits in URLs, JWTs, or bearer tokens.
  // Bare SDK statuses require whitespace/end/colon, not token punctuation.
  const status = /^\s*(?:HTTP(?:\/\d(?:\.\d)?)?\s+([345]\d{2})(?=\s|:|$)|status(?:\s+code)?\s*[:=]?\s*([345]\d{2})(?=\s|:|$)|([45]\d{2})(?=\s|:|$))/i.exec(text);
  if (status) return httpFailure(Number(status[1] ?? status[2] ?? status[3]));
  if (/\b(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL)\b|\b(?:DNS lookup failed|DNS resolution failed|getaddrinfo)\b/i.test(text)) return "dns";
  if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ERR_SOCKET_CONNECTION_TIMEOUT|TimeoutError)\b|\b(?:connect(?:ion)? timed? out|connect(?:ion)? timeout)\b/i.test(text)) return "connection_timeout";
  if (/\b(?:ECONNRESET|EPIPE|UND_ERR_SOCKET)\b|\b(?:connection reset|socket hang up|other side closed)\b/i.test(text)) return "connection_reset";
  if (/\bECONNREFUSED\b|\bconnection refused\b/i.test(text)) return "connection_refused";
  if (/\b(?:ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_UNTRUSTED|ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED)\b|\b(?:self[- ]signed certificate|certificate has expired|unable to verify (?:the )?(?:first |leaf )?certificate|TLS certificate validation failed)\b/i.test(text)) return "tls_certificate";
  if (/\b(?:ERR_FR_TOO_MANY_REDIRECTS|ERR_TOO_MANY_REDIRECTS)\b|\b(?:too many redirects|redirect count exceeded|unexpected redirect|request was redirected)\b/i.test(text)) return "redirect";
  if (/^\s*AbortError(?:\s|:|$)/.test(text) || /\b(?:operation|request) was aborted\b/i.test(text)) return "cancelled";
  if (/\b(?:fetch failed|failed to fetch|connection failed|network error|network request failed)\b/i.test(text)) return "network";
  return undefined;
}

function rank(reason: TalkRequestFailure | undefined): number {
  return reason === undefined ? 0 : reason === "network" ? 1 : reason === "cancelled" ? 2 : 3;
}

/**
 * Diagnostic hints only, not evidence for authorization/security decisions.
 * Inspect at most four cause/aggregate hops, four aggregate entries, and 64 nodes.
 * Specific nested causes beat generic wrappers. Callers must handle their own
 * deadline before classifying AbortError, which otherwise means cancellation.
 * No input or upstream text is retained after this synchronous call.
 */
export function classifyTalkRequestFailure(error: unknown): TalkRequestFailure | undefined {
  const seen = new WeakSet<object>();
  let budget = 64;
  function visit(value: unknown, depth: number): TalkRequestFailure | undefined {
    if (budget-- <= 0) return undefined;
    if (typeof value === "string") return textFailure(value);
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    let best: TalkRequestFailure | undefined;
    const consider = (reason: TalkRequestFailure | undefined) => {
      if (rank(reason) > rank(best)) best = reason;
    };
    // Deepest useful cause wins ties; generic nested failures cannot hide an
    // explicit outer HTTP status or transport error.
    if (depth < 4) {
      consider(visit(ownValue(value, "cause"), depth + 1));
      const errors = ownValue(value, "errors");
      // No iterator execution, length accessors, or unbounded aggregate walks.
      try {
        if (Array.isArray(errors)) {
          for (let i = 0; i < 4; i++) consider(visit(ownValue(errors, String(i)), depth + 1));
        }
      } catch { /* Revoked proxies are unknown failures. */ }
    }
    consider(httpFailure(ownValue(value, "status")));
    consider(httpFailure(ownValue(value, "statusCode")));
    for (const key of ["code", "message", "errorMessage", "name"]) {
      consider(textFailure(ownValue(value, key)));
    }
    return best;
  }
  return visit(error, 0);
}
