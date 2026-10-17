#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { accountIdFromCodexToken } from "../extensions/web/providers/openai.ts";

const DEFAULT_CODEX_IMAGE_MODEL = "gpt-image-2";
const IMAGE_MODELS = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
  "chatgpt-image-latest",
];
const RESPONSE_ENDPOINTS = [
  "https://chatgpt.com/backend-api/codex/responses",
  "https://api.openai.com/v1/responses",
];
const IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const CODEX_IMAGE_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/images/generations";
const OUTPUT_DIR = resolve("tmp/openai-image-probe");
const prompt = "A simple red circle centered on a plain white background.";

function parseArgs(args) {
  const selected = [];
  let route = "codex-images";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--route") route = args[++index] ?? "";
    else if (arg === "--model") selected.push(args[++index] ?? "");
    else if (arg === "--help") {
      console.log("Usage: node scripts/probe-openai-image-generation.mjs [--route all|codex-images|images|responses] [--model MODEL]...");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["all", "codex-images", "images", "responses"].includes(route)) {
    throw new Error(`Unknown route: ${route}`);
  }
  return { route, models: selected.filter(Boolean) };
}

function headers(token, accountId, accept = "application/json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "ChatGPT-Account-Id": accountId,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    "User-Agent": "mypi-image-probe",
    originator: "pi",
  };
}

function errorMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message ?? parsed?.message ?? body.slice(0, 500);
  } catch {
    const event = body.match(/data:\s*(\{[^\n]+\})/g)?.map((line) => {
      try { return JSON.parse(line.replace(/^data:\s*/, "")); } catch { return undefined; }
    }).find((item) => item?.type === "error" || item?.type === "response.failed");
    return event?.error?.message ?? event?.response?.error?.message ?? body.slice(0, 500);
  }
}

async function saveImage(model, route, base64, mimeType = "image/png") {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const path = resolve(OUTPUT_DIR, `${route}-${safeModel}.${extension}`);
  await writeFile(path, Buffer.from(base64, "base64"));
  return path;
}

async function probeImagesApi(token, accountId, model, endpoint = IMAGE_ENDPOINT) {
  const isCodex = endpoint === CODEX_IMAGE_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: headers(token, accountId),
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      quality: isCodex ? "auto" : "low",
      size: isCodex ? "auto" : "1024x1024",
      background: "opaque",
    }),
  });
  const body = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: errorMessage(body) };
  const parsed = JSON.parse(body);
  const image = parsed?.data?.[0];
  if (!image?.b64_json) return { ok: false, status: response.status, error: "Successful response contained no base64 image" };
  return {
    ok: true,
    status: response.status,
    output: await saveImage(model, isCodex ? "codex-images" : "images", image.b64_json, "image/png"),
    revisedPrompt: image.revised_prompt,
    reported: {
      background: parsed.background,
      outputFormat: parsed.output_format,
      quality: parsed.quality,
      size: parsed.size,
    },
    usage: parsed.usage,
  };
}

function responsePayload(model) {
  return {
    model: "gpt-6-luna",
    store: false,
    stream: true,
    instructions: "Use the image generation tool exactly once.",
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
    tools: [{ type: "image_generation", model, action: "generate", quality: "low", size: "1024x1024" }],
    tool_choice: "required",
  };
}

async function probeResponsesApi(token, accountId, endpoint, model) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: headers(token, accountId, "text/event-stream"),
    body: JSON.stringify(responsePayload(model)),
  });
  const body = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: errorMessage(body) };

  const events = body.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => { try { return JSON.parse(line.slice(5).trim()); } catch { return undefined; } })
    .filter(Boolean);
  const failed = events.find((event) => event.type === "error" || event.type === "response.failed");
  if (failed) return { ok: false, status: response.status, error: errorMessage(`data: ${JSON.stringify(failed)}`) };
  const completed = events.findLast((event) => event.type === "response.completed")?.response;
  const imageCall = completed?.output?.find((item) => item.type === "image_generation_call");
  if (!imageCall?.result) {
    const outputSummary = (completed?.output ?? []).map((item) => ({
      type: item.type,
      status: item.status,
      error: item.error,
      text: item.content?.map((content) => content.text).filter(Boolean).join("\n"),
    }));
    return {
      ok: false,
      status: response.status,
      error: "Response completed without an image_generation_call result",
      responseStatus: completed?.status,
      responseError: completed?.error,
      incompleteDetails: completed?.incomplete_details,
      output: outputSummary,
    };
  }
  return {
    ok: true,
    status: response.status,
    output: await saveImage(model, endpoint.includes("chatgpt.com") ? "codex-responses" : "public-responses", imageCall.result),
    revisedPrompt: imageCall.revised_prompt,
  };
}

const { route, models: selectedModels } = parseArgs(process.argv.slice(2));
const models = selectedModels.length
  ? selectedModels
  : route === "codex-images"
    ? [DEFAULT_CODEX_IMAGE_MODEL]
    : IMAGE_MODELS;
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const auth = await runtime.getAuth("openai-codex");
const token = auth?.auth.apiKey;
if (!token) throw new Error("No Pi openai-codex login found. Run /login in Pi first.");
const accountId = accountIdFromCodexToken(token);
if (!accountId) throw new Error("Account ID missing from Pi's OpenAI Codex token.");

const results = [];
if (route === "all" || route === "codex-images") {
  for (const model of models) {
    results.push({ route: "codex-images", endpoint: CODEX_IMAGE_ENDPOINT, model, ...await probeImagesApi(token, accountId, model, CODEX_IMAGE_ENDPOINT) });
  }
}
if (route === "all" || route === "images") {
  for (const model of models) {
    results.push({ route: "images", endpoint: IMAGE_ENDPOINT, model, ...await probeImagesApi(token, accountId, model) });
  }
}
if (route === "all" || route === "responses") {
  for (const endpoint of RESPONSE_ENDPOINTS) {
    for (const model of models) {
      results.push({ route: endpoint.includes("chatgpt.com") ? "codex-responses" : "public-responses", endpoint, model, ...await probeResponsesApi(token, accountId, endpoint, model) });
    }
  }
}

console.log(JSON.stringify({ authenticatedAs: "openai-codex", prompt, results }, null, 2));
process.exitCode = results.some((result) => !result.ok) ? 1 : 0;
