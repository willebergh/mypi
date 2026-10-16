import type { Usage } from "@earendil-works/pi-ai";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_WEB_SEARCH_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_WEB_SEARCH_MODEL = "gpt-6-luna";

export interface WebSearchCitation {
  url: string;
  title?: string;
}

export interface OpenAiWebSearchResult {
  text: string;
  citations: WebSearchCitation[];
  usage?: Usage;
}

type Fetch = typeof globalThis.fetch;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function accountIdFromCodexToken(token: string): string | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;

  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const payload: unknown = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    );
    if (!isRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    return typeof auth.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseResponseEvents(body: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event: unknown = JSON.parse(data);
      if (isRecord(event)) events.push(event);
    } catch {
      // Ignore non-JSON keepalive or diagnostic frames.
    }
  }
  return events;
}

function completedResponse(events: JsonRecord[]): JsonRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "response.completed" && isRecord(event.response)) {
      return event.response;
    }
  }
}

function outputText(events: JsonRecord[], completed: JsonRecord | undefined): string {
  const done = events
    .filter(
      (event) =>
        event.type === "response.output_text.done" &&
        typeof event.text === "string",
    )
    .map((event) => event.text as string)
    .join("\n")
    .trim();
  if (done) return done;

  const chunks: string[] = [];
  const output = completed?.output;
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function addCitation(
  citations: Map<string, WebSearchCitation>,
  value: unknown,
): void {
  if (!isRecord(value) || typeof value.url !== "string") return;
  citations.set(value.url, {
    url: value.url,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  });
}

function citationsFromEvents(
  events: JsonRecord[],
  completed: JsonRecord | undefined,
): WebSearchCitation[] {
  const citations = new Map<string, WebSearchCitation>();

  for (const event of events) {
    if (event.type === "response.output_text.annotation.added") {
      addCitation(citations, event.annotation);
    }
  }

  const output = completed?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) continue;
      if (Array.isArray(item.content)) {
        for (const content of item.content) {
          if (!isRecord(content) || !Array.isArray(content.annotations)) continue;
          for (const annotation of content.annotations) {
            addCitation(citations, annotation);
          }
        }
      }
      const action = item.action;
      if (isRecord(action) && Array.isArray(action.sources)) {
        for (const source of action.sources) addCitation(citations, source);
      }
    }
  }

  return [...citations.values()];
}

function usageFromResponse(response: JsonRecord | undefined): Usage | undefined {
  const raw = response?.usage;
  if (!isRecord(raw)) return undefined;
  const details = raw.input_tokens_details;
  const cacheRead = isRecord(details) ? numberValue(details.cached_tokens) : 0;
  const input = Math.max(0, numberValue(raw.input_tokens) - cacheRead);
  const output = numberValue(raw.output_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: numberValue(raw.total_tokens) || input + cacheRead + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function responseError(events: JsonRecord[]): string | undefined {
  for (const event of events) {
    if (event.type !== "error" && event.type !== "response.failed") continue;
    const response = isRecord(event.response) ? event.response : undefined;
    const error = isRecord(event.error)
      ? event.error
      : response && isRecord(response.error)
        ? response.error
        : undefined;
    if (error && typeof error.message === "string") return error.message;
    if (typeof event.message === "string") return event.message;
    return "OpenAI web search failed";
  }
}

export async function searchWithOpenAi(
  token: string,
  query: string,
  options: { signal?: AbortSignal; fetch?: Fetch } = {},
): Promise<OpenAiWebSearchResult> {
  const input = query.trim();
  if (!input) throw new Error("A search query is required");

  const accountId = accountIdFromCodexToken(token);
  if (!accountId) throw new Error("Account ID missing from Pi's OpenAI Codex token");

  const response = await (options.fetch ?? globalThis.fetch)(
    OPENAI_WEB_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": accountId,
        "Content-Type": "application/json",
        "OpenAI-Beta": "responses=experimental",
        "User-Agent": "mypi-web-search",
        originator: "pi",
      },
      body: JSON.stringify({
        model: OPENAI_WEB_SEARCH_MODEL,
        store: false,
        stream: true,
        instructions:
          "Search the live web and answer the query concisely. Preserve inline citations in the answer.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: input }],
          },
        ],
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
        tools: [{ type: "web_search", search_context_size: "medium" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
      }),
      signal: options.signal,
    },
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI web search request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${body.slice(0, 2_000)}`,
    );
  }

  const events = parseResponseEvents(body);
  const error = responseError(events);
  if (error) throw new Error(error);

  const completed = completedResponse(events);
  const text = outputText(events, completed);
  if (!text) throw new Error("OpenAI web search returned no answer");

  return {
    text,
    citations: citationsFromEvents(events, completed),
    usage: usageFromResponse(completed),
  };
}
