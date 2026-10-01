export interface ScrapeClient {
  scrape(
    url: string,
    options: { formats: ["markdown"]; onlyMainContent: true },
  ): Promise<{ markdown?: string }>;
}

export function normalizeWebUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("A URL is required");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }

  return url.href;
}

export async function scrapeMarkdown(
  client: ScrapeClient,
  value: string,
): Promise<{ url: string; markdown: string }> {
  const url = normalizeWebUrl(value);
  const document = await client.scrape(url, {
    formats: ["markdown"],
    onlyMainContent: true,
  });
  const markdown = document.markdown;

  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new Error(`Firecrawl returned no markdown for ${url}`);
  }

  return { url, markdown };
}
