/** Show useful API rejections without dumping events, headers, or credentials. */
export function liveServiceError(
  error: unknown,
  headers: Record<string, string>,
  stage: string,
): string {
  const secrets = Object.entries(headers)
    .filter(([name]) => /authorization|api[-_]key|token|account[-_]id/i.test(name))
    .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, "")])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  function safe(value: unknown, limit: number): string {
    if (typeof value !== "string") return "";
    let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    // Redact before truncating, otherwise a cut-off token prefix could leak.
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    text = text
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
      .replace(/([?&](?:access_token|refresh_token|api_key|token)=)[^&\s"'<>]+/gi, "$1[redacted]")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
    return Array.from(text).slice(0, limit).join("").trim();
  }

  const details = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown> : {};
  const code = safe(details.code, 80);
  const type = safe(details.type, 80);
  const param = safe(details.param, 120);
  const message = safe(details.message, 400);
  const fields = [type && `type=${type}`, param && `param=${param}`].filter(Boolean);
  return `Live service error${code ? ` (${code})` : ""} during ${stage}` +
    (fields.length ? ` [${fields.join(", ")}]` : "") + (message ? `: ${message}` : "");
}
