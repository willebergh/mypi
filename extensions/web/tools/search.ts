import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OPENAI_CODEX_PROVIDER,
  OPENAI_WEB_SEARCH_MODEL,
  searchWithOpenAi,
  type WebSearchCitation,
} from "../providers/openai.ts";

interface SearchDetails {
  provider: "openai-codex";
  model: string;
  citations: WebSearchCitation[];
}

export function registerSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the live web and return a concise answer with clickable inline citations. Uses OpenAI hosted web search with the same Pi openai-codex login used for models.",
    parameters: Type.Object({
      query: Type.String({
        description: "The question or topic to search for",
      }),
    }),
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Web search was cancelled");
      const token = await ctx.modelRegistry.getApiKeyForProvider(
        OPENAI_CODEX_PROVIDER,
      );
      if (!token) {
        throw new Error(
          "Web search needs your existing Pi openai-codex login (/login).",
        );
      }

      const result = await searchWithOpenAi(token, parameters.query, { signal });
      const details: SearchDetails = {
        provider: OPENAI_CODEX_PROVIDER,
        model: OPENAI_WEB_SEARCH_MODEL,
        citations: result.citations,
      };

      return {
        content: [{ type: "text", text: result.text }],
        details,
        usage: result.usage,
      };
    },
  });
}
