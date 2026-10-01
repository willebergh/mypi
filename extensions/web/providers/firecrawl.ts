import { Firecrawl } from "firecrawl";
import { PACKAGE_ENV_PATH } from "../config.ts";
import type { ScrapeClient } from "../core.ts";

export function createFirecrawlScrapeClient(): ScrapeClient {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `FIRECRAWL_API_KEY is not set. Add it to ${PACKAGE_ENV_PATH}`,
    );
  }

  return new Firecrawl({
    apiKey,
    apiUrl: process.env.FIRECRAWL_API_URL?.trim() || undefined,
  });
}
