#!/usr/bin/env node

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  OPENAI_WEB_SEARCH_ENDPOINT,
  OPENAI_WEB_SEARCH_MODEL,
  searchWithOpenAi,
} from "../extensions/web/providers/openai.ts";

const query = process.argv.slice(2).join(" ") ||
  "What is the latest stable Node.js release? Give the version and cite the official source.";

const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const auth = await runtime.getAuth("openai-codex");
const token = auth?.auth.apiKey;
if (!token) throw new Error("No Pi openai-codex login found. Run /login in Pi first.");

const result = await searchWithOpenAi(token, query);
console.log(JSON.stringify({
  ok: true,
  endpoint: OPENAI_WEB_SEARCH_ENDPOINT,
  model: OPENAI_WEB_SEARCH_MODEL,
  citations: result.citations,
  usage: result.usage,
  outputText: result.text,
}, null, 2));
