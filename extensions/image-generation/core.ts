import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { accountIdFromCodexToken } from "../web/providers/openai.ts";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const CODEX_IMAGE_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/images/generations";
export const CODEX_IMAGE_MODEL = "gpt-image-2";

export type ImageBackground = "auto" | "opaque" | "transparent";
export type ImageAspectRatio = "auto" | "1:1" | "3:2" | "2:3" | "16:9" | "9:16" | "21:9";

export interface GeneratedImage {
  data: string;
  mimeType: "image/png";
  model: string;
  background?: string;
  quality?: string;
  size?: string;
  usage?: Usage;
}

type Fetch = typeof globalThis.fetch;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // Fall back to a bounded copy of the response body.
  }
  return body.slice(0, 2_000) || "empty response";
}

function usageFromResponse(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNumber(value.input_tokens);
  const output = finiteNumber(value.output_tokens);
  const totalTokens = finiteNumber(value.total_tokens) || input + output;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function promptWithAspectRatio(
  prompt: string,
  aspectRatio: ImageAspectRatio = "auto",
): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("An image prompt is required");
  return aspectRatio === "auto"
    ? trimmed
    : `${trimmed}\n\nAspect ratio: ${aspectRatio}.`;
}

export async function generateImageWithCodex(
  token: string,
  prompt: string,
  options: {
    aspectRatio?: ImageAspectRatio;
    background?: ImageBackground;
    signal?: AbortSignal;
    fetch?: Fetch;
    turnId?: string;
  } = {},
): Promise<GeneratedImage> {
  const accountId = accountIdFromCodexToken(token);
  if (!accountId) throw new Error("Account ID missing from Pi's OpenAI Codex token");

  const response = await (options.fetch ?? globalThis.fetch)(CODEX_IMAGE_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      "Content-Type": "application/json",
      "User-Agent": "mypi-image-generation",
      originator: "pi",
      ...(options.turnId ? { "x-codex-image-turn-id": options.turnId } : {}),
    },
    body: JSON.stringify({
      prompt: promptWithAspectRatio(prompt, options.aspectRatio),
      background: options.background ?? "auto",
      model: CODEX_IMAGE_MODEL,
      quality: "auto",
      size: "auto",
      n: 1,
    }),
    signal: options.signal,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI Codex image request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}): ${errorMessage(body)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("OpenAI Codex image response was not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new Error("OpenAI Codex image response contained no image data");
  }
  const first = parsed.data[0];
  if (!isRecord(first) || typeof first.b64_json !== "string" || !first.b64_json) {
    throw new Error("OpenAI Codex image response contained no base64 image");
  }

  const bytes = Buffer.from(first.b64_json, "base64");
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < pngSignature.length || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Error("OpenAI Codex image response was not a PNG");
  }

  return {
    data: first.b64_json,
    mimeType: "image/png",
    model: CODEX_IMAGE_MODEL,
    ...(typeof parsed.background === "string" ? { background: parsed.background } : {}),
    ...(typeof parsed.quality === "string" ? { quality: parsed.quality } : {}),
    ...(typeof parsed.size === "string" ? { size: parsed.size } : {}),
    usage: usageFromResponse(parsed.usage),
  };
}

export function imageOutputPath(requestedPath: string): string {
  const requested = requestedPath.trim();
  if (!requested) throw new Error("Image output_path is required");
  if (!isAbsolute(requested)) {
    throw new Error("Image output_path must be absolute");
  }
  const extension = extname(requested).toLowerCase();
  if (extension !== ".png") {
    throw new Error("Image output_path must use the .png extension");
  }
  return requested;
}

export async function saveGeneratedImage(path: string, base64: string): Promise<void> {
  const bytes = Buffer.from(base64, "base64");
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  });
}
