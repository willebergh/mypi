import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_IMAGE_ENDPOINT,
  CODEX_IMAGE_MODEL,
  generateImageWithCodex,
  imageOutputPath,
  promptWithAspectRatio,
  saveGeneratedImage,
} from "../extensions/image-generation/core.ts";

function fakeCodexToken(accountId = "acct-image"): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("test-png"),
]);

test("adds an explicit aspect ratio to the image prompt", () => {
  assert.equal(promptWithAspectRatio(" Draw a fox ", "16:9"), "Draw a fox\n\nAspect ratio: 16:9.");
  assert.equal(promptWithAspectRatio("Draw a fox"), "Draw a fox");
  assert.throws(() => promptWithAspectRatio("  "), /prompt is required/);
});

test("generates an image through the Codex image endpoint", async () => {
  const token = fakeCodexToken();
  let requestUrl: string | undefined;
  let request: RequestInit | undefined;

  const result = await generateImageWithCodex(token, "Draw a fox", {
    aspectRatio: "3:2",
    background: "transparent",
    turnId: "call-123",
    fetch: async (input, init) => {
      requestUrl = String(input);
      request = init;
      return new Response(JSON.stringify({
        background: "transparent",
        quality: "low",
        size: "1536x1024",
        data: [{ b64_json: png.toString("base64") }],
        usage: { input_tokens: 12, output_tokens: 300, total_tokens: 312 },
      }), { status: 200 });
    },
  });

  assert.equal(requestUrl, CODEX_IMAGE_ENDPOINT);
  const headers = new Headers(request?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
  assert.equal(headers.get("chatgpt-account-id"), "acct-image");
  assert.equal(headers.get("x-codex-image-turn-id"), "call-123");
  assert.deepEqual(JSON.parse(String(request?.body)), {
    prompt: "Draw a fox\n\nAspect ratio: 3:2.",
    background: "transparent",
    model: CODEX_IMAGE_MODEL,
    quality: "auto",
    size: "auto",
    n: 1,
  });
  assert.equal(result.data, png.toString("base64"));
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.model, CODEX_IMAGE_MODEL);
  assert.equal(result.size, "1536x1024");
  assert.deepEqual(result.usage, {
    input: 12,
    output: 300,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 312,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("surfaces image endpoint and invalid image errors", async () => {
  await assert.rejects(
    generateImageWithCodex(fakeCodexToken(), "Draw", {
      fetch: async () => new Response(
        JSON.stringify({ error: { message: "image quota reached" } }),
        { status: 429 },
      ),
    }),
    /429.*image quota reached/,
  );

  await assert.rejects(
    generateImageWithCodex(fakeCodexToken(), "Draw", {
      fetch: async () => new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("not png").toString("base64") }],
      }), { status: 200 }),
    }),
    /not a PNG/,
  );
});

test("requires an absolute PNG output path and refuses to overwrite files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mypi-image-"));
  try {
    const absolutePath = join(cwd, "art", "fox.png");
    assert.equal(imageOutputPath(absolutePath), absolutePath);
    assert.throws(() => imageOutputPath("art/fox.png"), /must be absolute/);
    assert.throws(() => imageOutputPath(join(cwd, "art", "fox.jpg")), /\.png extension/);
    assert.throws(() => imageOutputPath("  "), /is required/);

    const path = join(cwd, "nested", "image.png");
    await saveGeneratedImage(path, png.toString("base64"));
    assert.deepEqual(await readFile(path), png);
    await assert.rejects(saveGeneratedImage(path, png.toString("base64")), /EEXIST/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
