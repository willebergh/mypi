import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { announceExtension } from "../resource-status/protocol.ts";
import {
  CODEX_IMAGE_MODEL,
  generateImageWithCodex,
  imageOutputPath,
  OPENAI_CODEX_PROVIDER,
  saveGeneratedImage,
} from "./core.ts";

const GenerateImageParameters = Type.Object({
  prompt: Type.String({
    description: "Detailed description of the image to generate",
  }),
  output_path: Type.String({
    description:
      "Required absolute destination ending in .png. Parent directories are created and existing files are never overwritten.",
  }),
  aspect_ratio: Type.Optional(
    StringEnum(["auto", "1:1", "3:2", "2:3", "16:9", "9:16", "21:9"] as const, {
      description: "Requested canvas aspect ratio; defaults to auto",
    }),
  ),
  background: Type.Optional(
    StringEnum(["auto", "opaque", "transparent"] as const, {
      description: "Requested background behavior; defaults to auto",
    }),
  ),
});

interface GenerateImageDetails {
  provider: "openai-codex";
  requestedModel: "gpt-image-2";
  effectiveModel: "server-managed";
  path: string;
  mimeType: "image/png";
  background?: string;
  quality?: string;
  size?: string;
}

export default function imageGenerationExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    announceExtension(pi.events, { id: "image-generation", label: "image-generation" });
  });

  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate one PNG with OpenAI's Codex-managed image service using the existing Pi openai-codex login. Requires an absolute output path, saves the full image there, and returns it for visual inspection. The effective model is server-managed; exact public GPT Image model selection is unavailable.",
    promptGuidelines: [
      "Use generate_image when the user asks to create an image.",
      "Describe composition, subject, style, lighting, text, and constraints explicitly in the prompt.",
      "Do not claim that a specific GPT Image version was selected; this endpoint is server-managed.",
    ],
    parameters: GenerateImageParameters,
    executionMode: "parallel",

    async execute(toolCallId, parameters, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Image generation was cancelled");
      const token = await ctx.modelRegistry.getApiKeyForProvider(
        OPENAI_CODEX_PROVIDER,
      );
      if (!token) {
        throw new Error(
          "Image generation needs your existing Pi openai-codex login (/login).",
        );
      }

      const image = await generateImageWithCodex(token, parameters.prompt, {
        aspectRatio: parameters.aspect_ratio,
        background: parameters.background,
        signal,
        turnId: toolCallId,
      });
      const path = imageOutputPath(parameters.output_path);
      await saveGeneratedImage(path, image.data);

      const details: GenerateImageDetails = {
        provider: OPENAI_CODEX_PROVIDER,
        requestedModel: CODEX_IMAGE_MODEL,
        effectiveModel: "server-managed",
        path,
        mimeType: image.mimeType,
        ...(image.background ? { background: image.background } : {}),
        ...(image.quality ? { quality: image.quality } : {}),
        ...(image.size ? { size: image.size } : {}),
      };
      const metadata = [
        `Saved generated image to ${path}`,
        image.size ? `Size: ${image.size}` : undefined,
        image.quality ? `Service quality: ${image.quality}` : undefined,
        "Effective model: server-managed Codex image model",
      ].filter(Boolean).join("\n");

      return {
        content: [
          { type: "text", text: metadata },
          { type: "image", data: image.data, mimeType: image.mimeType },
        ],
        details,
        usage: image.usage,
      };
    },
  });
}
