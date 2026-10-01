import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPackageEnv,
  PACKAGE_ENV_PATH,
} from "../extensions/web/config.ts";
import {
  normalizeWebUrl,
  scrapeMarkdown,
  type ScrapeClient,
} from "../extensions/web/core.ts";

test("loads the package-scoped env file", () => {
  let loadedPath: string | undefined;
  assert.equal(
    loadPackageEnv((path) => {
      loadedPath = path;
    }),
    true,
  );
  assert.equal(loadedPath, PACKAGE_ENV_PATH);
  assert.match(PACKAGE_ENV_PATH, /mypi\/.env$/);
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
