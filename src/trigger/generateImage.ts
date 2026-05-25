import { googleAI } from "@/lib/googleai";
import { uploadBufferToTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { rethrowClassified } from "@/lib/triggerErrors";
import type { Prisma } from "@prisma/client";

export type GenerateImagePayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  model: string;
  prompt: string;
  /**
   * Up to 3 image URLs. First is treated as the primary edit target; the
   * rest are passed as additional inlineData parts (composition / style
   * references). `inputImageUrl` is the legacy single-image alias and is
   * folded into `inputImageUrls[0]` if `inputImageUrls` is absent.
   */
  inputImageUrls?: string[];
  inputImageUrl?: string | null;
  aspectRatio?: string;
  systemPrompt?: string;
  seed?: number;
  temperature?: number;
};

export type GenerateImageOutput = { url: string };

/**
 * Worker for the generateImage node. Uses Gemini's multimodal image-generation
 * capability (responseModalities: ["TEXT", "IMAGE"]) which supports both:
 *   - text-to-image: prompt only
 *   - image editing: prompt + inlineData from upstream image URL
 *
 * The same model handles both modes; edit mode activates when inputImageUrl is provided.
 */
export async function runGenerateImage(
  payload: GenerateImagePayload,
): Promise<GenerateImageOutput> {
  const existing = await prisma.nodeRun.findUnique({
    where: { id: payload.nodeRunId },
    select: { status: true, output: true },
  });
  if (existing?.status === "SUCCESS" && existing.output) {
    const out = existing.output as { url?: string };
    if (typeof out.url === "string") return { url: out.url };
  }

  // Normalize to a single array of input URLs (max 3).
  const inputUrls: string[] = (payload.inputImageUrls && payload.inputImageUrls.length > 0
    ? payload.inputImageUrls
    : payload.inputImageUrl
      ? [payload.inputImageUrl]
      : []
  ).slice(0, 3);

  const startedAt = new Date();
  const inputRecord: Record<string, unknown> = {
    model: payload.model,
    prompt: payload.prompt,
  };
  if (inputUrls.length > 0) inputRecord.inputImageUrls = inputUrls;
  if (payload.aspectRatio) inputRecord.aspectRatio = payload.aspectRatio;

  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: { startedAt, input: inputRecord as Prisma.InputJsonValue },
  });

  try {
    const ai = googleAI();

    // Remap stale model IDs from earlier preview/exp naming iterations.
    const LEGACY_IMAGE_MODELS = new Set([
      "gemini-2.0-flash-preview-image-generation",
      "gemini-2.0-flash-exp-image-generation",
      "gemini-2.0-flash-exp",
    ]);
    const model = LEGACY_IMAGE_MODELS.has(payload.model)
      ? "gemini-3-pro-image-preview"
      : payload.model;

    // Build content parts — always include the prompt; add inline image
    // data for each input URL (up to 3). Order is preserved so the model
    // can treat slot 1 as the primary edit target and the rest as refs.
    type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
    const parts: Part[] = [{ text: payload.prompt }];

    for (const url of inputUrls) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch input image (${url}): ${res.status} ${res.statusText}`);
      const arrayBuf = await res.arrayBuffer();
      const b64 = Buffer.from(arrayBuf).toString("base64");
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      parts.push({ inlineData: { mimeType: contentType.split(";")[0], data: b64 } });
    }

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts }],
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(payload.systemPrompt ? { systemInstruction: payload.systemPrompt } : {}),
        ...(payload.seed != null ? { seed: payload.seed } : {}),
        ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
      },
    });

    // Find the image part in the response candidates.
    let imageData: string | null = null;
    let imageMime = "image/jpeg";
    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.inlineData?.mimeType?.startsWith("image/")) {
          imageData = part.inlineData.data ?? null;
          imageMime = part.inlineData.mimeType;
          break;
        }
      }
      if (imageData) break;
    }

    if (!imageData) {
      throw new Error("Gemini image generation returned no image in response");
    }

    const buf = Buffer.from(imageData, "base64");
    const ext = imageMime.split("/")[1]?.split("+")[0] ?? "jpg";
    const { url } = await uploadBufferToTransloadit(buf, `generated.${ext}`, imageMime);

    const finishedAt = new Date();
    await prisma.nodeRun.update({
      where: { id: payload.nodeRunId },
      data: {
        status: "SUCCESS",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        output: { url },
      },
    });
    return { url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.nodeRun.update({
      where: { id: payload.nodeRunId },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    rethrowClassified(err);
  }
}
