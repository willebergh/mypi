export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface UsageWindow {
  label: string;
  remainingPercent?: number;
  usedPercent?: number;
  resetAt?: number;
  resetAfterSeconds?: number;
  windowSeconds?: number;
}

export interface OpenAiUsageSnapshot {
  planType?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  updatedAt: number;
}

export type OpenAiUsageState =
  | { status: "inactive" }
  | { status: "loading" }
  | { status: "ready"; snapshot: OpenAiUsageSnapshot }
  | { status: "error"; message: string; updatedAt: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumber(
  source: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function windowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === 18_000) return "5h";
  if (seconds === 604_800) return "weekly";
  if (seconds && seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return fallback;
}

export function parseUsageWindow(
  value: unknown,
  fallbackLabel: string,
): UsageWindow | undefined {
  if (!isRecord(value)) return undefined;

  const usedPercent = firstNumber(value, [
    "used_percent",
    "usedPercent",
    "percent_used",
    "percentUsed",
  ]);
  const explicitRemaining = firstNumber(value, [
    "remaining_percent",
    "remainingPercent",
    "percent_left",
    "percentLeft",
    "left_percent",
    "leftPercent",
  ]);
  const windowSeconds = firstNumber(value, [
    "limit_window_seconds",
    "limitWindowSeconds",
    "window_seconds",
    "windowSeconds",
  ]);
  const resetAfterSeconds = firstNumber(value, [
    "reset_after_seconds",
    "resetAfterSeconds",
    "seconds_until_reset",
    "secondsUntilReset",
  ]);
  let resetAt = firstNumber(value, ["reset_at", "resetAt", "resets_at", "resetsAt"]);
  if (resetAt !== undefined && resetAt > 10_000_000_000) resetAt /= 1_000;

  const remainingPercent =
    explicitRemaining !== undefined
      ? clampPercent(explicitRemaining)
      : usedPercent !== undefined
        ? clampPercent(100 - usedPercent)
        : undefined;

  if (
    remainingPercent === undefined &&
    usedPercent === undefined &&
    resetAt === undefined &&
    resetAfterSeconds === undefined &&
    windowSeconds === undefined
  ) {
    return undefined;
  }

  return {
    label: windowLabel(windowSeconds, fallbackLabel),
    remainingPercent,
    usedPercent:
      usedPercent === undefined ? undefined : clampPercent(usedPercent),
    resetAt,
    resetAfterSeconds,
    windowSeconds,
  };
}

function firstWindow(
  source: Record<string, unknown> | undefined,
  keys: string[],
  fallbackLabel: string,
): UsageWindow | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const parsed = parseUsageWindow(source[key], fallbackLabel);
    if (parsed) return parsed;
  }
}

function windowByDuration(
  source: Record<string, unknown> | undefined,
  duration: number,
  fallbackLabel: string,
): UsageWindow | undefined {
  if (!source) return undefined;
  for (const value of Object.values(source)) {
    const parsed = parseUsageWindow(value, fallbackLabel);
    if (parsed?.windowSeconds === duration) return parsed;
  }
}

export function parseOpenAiUsage(
  value: unknown,
  now = Date.now(),
): OpenAiUsageSnapshot {
  if (!isRecord(value)) throw new Error("OpenAI usage response was not an object");
  const limits = isRecord(value.rate_limit)
    ? value.rate_limit
    : isRecord(value.rate_limits)
      ? value.rate_limits
      : undefined;

  const primary =
    firstWindow(
      limits,
      ["primary_window", "primary", "five_hour", "five_hour_limit", "fiveHour"],
      "5h",
    ) ?? windowByDuration(limits, 18_000, "5h");
  const secondary =
    firstWindow(
      limits,
      [
        "secondary_window",
        "secondary",
        "weekly",
        "weekly_limit",
        "seven_day",
        "seven_day_limit",
        "sevenDay",
      ],
      "weekly",
    ) ?? windowByDuration(limits, 604_800, "weekly");

  return {
    planType:
      typeof value.plan_type === "string"
        ? value.plan_type
        : typeof value.planType === "string"
          ? value.planType
          : undefined,
    primary,
    secondary:
      secondary?.windowSeconds === primary?.windowSeconds ? undefined : secondary,
    updatedAt: now,
  };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function accountIdFromToken(token: string): string | undefined {
  const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
  if (!isRecord(auth)) return undefined;
  return typeof auth.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
}

export function usageWindowResetSeconds(
  window: UsageWindow,
  now: number,
): number | undefined {
  if (window.resetAfterSeconds !== undefined) return window.resetAfterSeconds;
  if (window.resetAt !== undefined) return window.resetAt - now / 1_000;
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatWindow(window: UsageWindow, now: number): string {
  const remaining =
    window.remainingPercent === undefined
      ? "?%"
      : `${window.remainingPercent >= 10 ? window.remainingPercent.toFixed(0) : window.remainingPercent.toFixed(1)}%`;
  const reset = formatDuration(usageWindowResetSeconds(window, now));
  return `${window.label} ${remaining} left${reset ? ` ↻${reset}` : ""}`;
}

export function formatOpenAiUsageState(
  state: OpenAiUsageState,
  now = Date.now(),
): string | undefined {
  if (state.status === "inactive") return undefined;
  if (state.status === "loading") return "OpenAI limits: loading…";
  if (state.status === "error") return `OpenAI limits: ${state.message}`;

  const windows = [state.snapshot.primary, state.snapshot.secondary].filter(
    (window): window is UsageWindow => Boolean(window),
  );
  const plan = state.snapshot.planType ? ` (${state.snapshot.planType})` : "";
  return windows.length
    ? `OpenAI${plan}: ${windows.map((window) => formatWindow(window, now)).join(" · ")}`
    : `OpenAI${plan}: limits unavailable`;
}
