import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadPackageEnv,
  PACKAGE_ENV_PATH,
} from "../extensions/web/config.ts";
import {
  normalizeWebUrl,
  scrapeMarkdown,
  type ScrapeClient,
} from "../extensions/web/core.ts";
import {
  accountIdFromCodexToken,
  OPENAI_WEB_SEARCH_ENDPOINT,
  OPENAI_WEB_SEARCH_MODEL,
  parseResponseEvents,
  searchWithOpenAi,
} from "../extensions/web/providers/openai.ts";

function fakeCodexToken(accountId = "acct-test"): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

test("loads the package-scoped env file", () => {
  let loadedPath: string | undefined;
  assert.equal(
    loadPackageEnv((path) => {
      loadedPath = path;
    }),
    true,
  );
  assert.equal(loadedPath, PACKAGE_ENV_PATH);
  assert.equal(PACKAGE_ENV_PATH, fileURLToPath(new URL("../.env", import.meta.url)));
});

test("allows the package-scoped env file to be absent", () => {
  assert.equal(
    loadPackageEnv(() => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }),
    false,
  );
});

test("normalizes HTTP(S) URLs and rejects other inputs", () => {
  assert.equal(normalizeWebUrl(" https://example.com/docs "), "https://example.com/docs");
  assert.equal(normalizeWebUrl("http://example.com"), "http://example.com/");
  assert.throws(() => normalizeWebUrl("example.com"), /Invalid URL/);
  assert.throws(() => normalizeWebUrl("file:///tmp/page.html"), /http or https/);
});

test("scrapes one URL as main-content markdown", async () => {
  const calls: unknown[][] = [];
  const client: ScrapeClient = {
    async scrape(...args) {
      calls.push(args);
      return { markdown: "# Example\n\nScraped content." };
    },
  };

  const result = await scrapeMarkdown(client, "https://example.com");

  assert.deepEqual(calls, [
    [
      "https://example.com/",
      { formats: ["markdown"], onlyMainContent: true },
    ],
  ]);
  assert.deepEqual(result, {
    url: "https://example.com/",
    markdown: "# Example\n\nScraped content.",
  });
});

test("rejects an empty Firecrawl result", async () => {
  const client: ScrapeClient = {
    async scrape() {
      return {};
    },
  };

  await assert.rejects(
    scrapeMarkdown(client, "https://example.com"),
    /returned no markdown/,
  );
});

test("extracts the ChatGPT account ID from a Codex token", () => {
  assert.equal(accountIdFromCodexToken(fakeCodexToken()), "acct-test");
  assert.equal(accountIdFromCodexToken("not-a-token"), undefined);
});

test("parses JSON events from a Responses SSE body", () => {
  assert.deepEqual(
    parseResponseEvents(
      'data: {"type":"response.created"}\n\n' +
        'data: {"type":"response.output_text.done","text":"answer"}\n\n' +
        "data: [DONE]\n\n",
    ),
    [
      { type: "response.created" },
      { type: "response.output_text.done", text: "answer" },
    ],
  );
});

test("searches through the Codex Responses endpoint with Pi auth", async () => {
  const token = fakeCodexToken();
  let requestUrl: string | undefined;
  let request: RequestInit | undefined;
  const sse = [
    'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://nodejs.org/","title":"Node.js"}}',
    'data: {"type":"response.output_text.done","text":"Node 26 ([nodejs.org](https://nodejs.org/))"}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":25},"output_tokens":20,"total_tokens":120},"output":[]}}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  const result = await searchWithOpenAi(token, " latest Node release ", {
    fetch: async (input, init) => {
      requestUrl = String(input);
      request = init;
      return new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  assert.equal(requestUrl, OPENAI_WEB_SEARCH_ENDPOINT);
  assert.equal(new Headers(request?.headers).get("authorization"), `Bearer ${token}`);
  assert.equal(new Headers(request?.headers).get("chatgpt-account-id"), "acct-test");
  const body = JSON.parse(String(request?.body));
  assert.equal(body.model, OPENAI_WEB_SEARCH_MODEL);
  assert.deepEqual(body.tools, [
    { type: "web_search", search_context_size: "medium" },
  ]);
  assert.equal(body.input[0].content[0].text, "latest Node release");
  assert.deepEqual(result, {
    text: "Node 26 ([nodejs.org](https://nodejs.org/))",
    citations: [{ url: "https://nodejs.org/", title: "Node.js" }],
    usage: {
      input: 75,
      output: 20,
      cacheRead: 25,
      cacheWrite: 0,
      totalTokens: 120,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  });
});

test("surfaces HTTP and streamed OpenAI web-search errors", async () => {
  await assert.rejects(
    searchWithOpenAi(fakeCodexToken(), "query", {
      fetch: async () => new Response("denied", { status: 403 }),
    }),
    /403.*denied/,
  );

  await assert.rejects(
    searchWithOpenAi(fakeCodexToken(), "query", {
      fetch: async () =>
        new Response(
          'data: {"type":"response.failed","response":{"error":{"message":"search unavailable"}}}\n\n',
          { status: 200 },
        ),
    }),
    /search unavailable/,
  );
});
