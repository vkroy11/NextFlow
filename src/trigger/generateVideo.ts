import { wait } from "@trigger.dev/sdk/v3";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoGenerationReferenceType } from "@google/genai";
import { googleAI } from "@/lib/googleai";
import { uploadBufferToTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { rethrowClassified } from "@/lib/triggerErrors";
import type { Prisma } from "@prisma/client";

export type GenerateVideoPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  model: string;
  prompt: string;
  /**
   * Up to 3 image URLs. Slot 1 (index 0) becomes Veo's `image` (start
   * frame, image-to-video mode). Slots 2-3 are passed as `referenceImages`
   * for style/subject consistency. `inputImageUrl` is the legacy single-
   * image alias and is folded into `inputImageUrls[0]` if absent.
   */
  inputImageUrls?: string[];
  inputImageUrl?: string | null;
  durationSeconds: number;
  aspectRatio: string;
  negativePrompt?: string;
  resolution?: string;
  personGeneration?: string;
};

export type GenerateVideoOutput = { url: string; veoFileUri?: string };

/**
 * Worker for the generateVideo node. Uses Veo 3.1 via the @google/genai SDK.
 * Supports text-to-video and image-to-video (when inputImageUrl is set).
 *
 * The Veo API is async: generateVideos() returns an operation that must be
 * polled until done. We use wait.for() between polls so Trigger.dev can
 * checkpoint the task — these pauses don't count against maxDuration.
 */
export async function runGenerateVideo(
  payload: GenerateVideoPayload,
): Promise<GenerateVideoOutput> {
  const existing = await prisma.nodeRun.findUnique({
    where: { id: payload.nodeRunId },
    select: { status: true, output: true },
  });
  if (existing?.status === "SUCCESS" && existing.output) {
    const out = existing.output as { url?: string };
    if (typeof out.url === "string") return { url: out.url };
  }

  // Normalize input images (max 3). Slot 0 → start frame; rest → references.
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
    durationSeconds: payload.durationSeconds,
    aspectRatio: payload.aspectRatio,
  };
  if (inputUrls.length > 0) inputRecord.inputImageUrls = inputUrls;

  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: { startedAt, input: inputRecord as Prisma.InputJsonValue },
  });

  const workdir = await mkdtemp(join(tmpdir(), "nf-gen-video-"));
  try {
    const ai = googleAI();

    async function fetchImageParam(url: string): Promise<{ imageBytes: string; mimeType: string }> {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch image (${url}): ${res.status} ${res.statusText}`);
      const arrayBuf = await res.arrayBuffer();
      const b64 = Buffer.from(arrayBuf).toString("base64");
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      return { imageBytes: b64, mimeType: contentType.split(";")[0] };
    }

    // Slot 0 → image (start frame); slots 1-2 → referenceImages.
    // Veo's referenceImages payload requires `referenceType` per entry.
    // "ASSET" covers subjects/objects/characters and is the right default
    // for "use these as visual references for the generation".
    type RefImage = {
      image: { imageBytes: string; mimeType: string };
      referenceType: VideoGenerationReferenceType;
    };
    let imageParam: { imageBytes: string; mimeType: string } | undefined;
    let referenceImages: RefImage[] | undefined;
    if (inputUrls.length > 0) {
      imageParam = await fetchImageParam(inputUrls[0]);
    }
    if (inputUrls.length > 1) {
      const refs: RefImage[] = [];
      for (let i = 1; i < inputUrls.length; i++) {
        refs.push({
          image: await fetchImageParam(inputUrls[i]),
          referenceType: VideoGenerationReferenceType.ASSET,
        });
      }
      referenceImages = refs;
    }

    let operation = await ai.models.generateVideos({
      model: payload.model,
      prompt: payload.prompt,
      config: {
        durationSeconds: payload.durationSeconds,
        aspectRatio: payload.aspectRatio,
        numberOfVideos: 1,
        ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
        ...(payload.personGeneration ? { personGeneration: payload.personGeneration } : {}),
        ...(referenceImages && referenceImages.length > 0 ? { referenceImages } : {}),
      },
      ...(imageParam ? { image: imageParam } : {}),
    });

    // Poll until the operation completes. wait.for() checkpoints the task so
    // these waits don't count against the task's maxDuration compute budget.
    // Polling uses ai.operations.getVideosOperation() per the @google/genai SDK.
    let attempts = 0;
    const MAX_ATTEMPTS = 60; // 60 × 10 s = 10 min ceiling
    while (!operation.done && attempts < MAX_ATTEMPTS) {
      await wait.for({ seconds: 10 });
      operation = await ai.operations.getVideosOperation({ operation });
      attempts++;
    }

    if (!operation.done) {
      throw new Error("Veo video generation timed out after 10 minutes");
    }

    const generated = operation.response?.generatedVideos?.[0];
    if (!generated?.video) {
      throw new Error("Veo returned no video in operation response");
    }

    // Prefer base64 bytes; otherwise download via the SDK (handles auth + URL).
    let buf: Buffer;
    if (generated.video.videoBytes) {
      buf = Buffer.from(generated.video.videoBytes as string, "base64");
    } else if (generated.video.uri) {
      const tempPath = join(workdir, "veo-output.mp4");
      await ai.files.download({ file: generated, downloadPath: tempPath });
      buf = await readFile(tempPath);
    } else {
      throw new Error("Veo video has neither videoBytes nor uri");
    }

    // Preserve the Veo URI so downstream `extendVideo` can attempt native
    // continuation. The URI is only valid in the same project for ~48 h.
    const veoFileUri = generated.video.uri ?? undefined;

    const { url } = await uploadBufferToTransloadit(buf, "generated.mp4", "video/mp4");

    const finishedAt = new Date();
    await prisma.nodeRun.update({
      where: { id: payload.nodeRunId },
      data: {
        status: "SUCCESS",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        output: { url, ...(veoFileUri ? { veoFileUri } : {}) },
      },
    });
    return { url, ...(veoFileUri ? { veoFileUri } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.nodeRun.update({
      where: { id: payload.nodeRunId },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    rethrowClassified(err);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
