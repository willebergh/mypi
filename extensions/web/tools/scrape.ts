import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { scrapeMarkdown } from "../core.ts";
import { createFirecrawlScrapeClient } from "../providers/firecrawl.ts";

interface ScrapeDetails {
  url: string;
  provider: "firecrawl";
  characters: number;
  truncated: boolean;
  fullOutputPath?: string;
}

export function registerScrapeTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_scrape",
    label: "Web scrape",
    description:
      `Fetch a known HTTP(S) URL and return its main content as Markdown. ` +
      `Currently powered by Firecrawl. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temporary file when needed.`,
    parameters: Type.Object({
      url: Type.String({
        description: "The existing HTTP(S) URL to scrape",
      }),
    }),

    async execute(_toolCallId, parameters, signal) {
      if (signal?.aborted) throw new Error("Web scrape was cancelled");

      const result = await scrapeMarkdown(
        createFirecrawlScrapeClient(),
        parameters.url,
      );
      if (signal?.aborted) throw new Error("Web scrape was cancelled");

      const truncation = truncateHead(result.markdown, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const details: ScrapeDetails = {
        url: result.url,
        provider: "firecrawl",
        characters: result.markdown.length,
        truncated: truncation.truncated,
      };
      let text = truncation.content;

      if (truncation.truncated) {
        const directory = await mkdtemp(join(tmpdir(), "pi-web-scrape-"));
        const outputPath = join(directory, "scrape.md");
        await withFileMutationQueue(outputPath, () =>
          writeFile(outputPath, result.markdown, "utf8"),
        );
        details.fullOutputPath = outputPath;
        text += `\n\n[Markdown truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
      }

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });
}
