import { wait } from "@trigger.dev/sdk/v3";
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
  inputImageUrl?: string | null;
  durationSeconds: number;
  aspectRatio: string;
};

export type GenerateVideoOutput = { url: string };

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

  const startedAt = new Date();
  const inputRecord: Record<string, unknown> = {
    model: payload.model,
    prompt: payload.prompt,
    durationSeconds: payload.durationSeconds,
    aspectRatio: payload.aspectRatio,
  };
  if (payload.inputImageUrl) inputRecord.inputImageUrl = payload.inputImageUrl;

  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: { startedAt, input: inputRecord as Prisma.InputJsonValue },
  });

  try {
    const ai = googleAI();

    // Build the optional start-image for image-to-video mode.
    let imageParam: { imageBytes: string; mimeType: string } | undefined;
    if (payload.inputImageUrl) {
      const res = await fetch(payload.inputImageUrl);
      if (!res.ok) throw new Error(`fetch start image: ${res.status} ${res.statusText}`);
      const arrayBuf = await res.arrayBuffer();
      const b64 = Buffer.from(arrayBuf).toString("base64");
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      imageParam = { imageBytes: b64, mimeType: contentType.split(";")[0] };
    }

    let operation = await ai.models.generateVideos({
      model: payload.model,
      prompt: payload.prompt,
      config: {
        durationSeconds: payload.durationSeconds,
        aspectRatio: payload.aspectRatio,
        numberOfVideos: 1,
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

    // Prefer base64 bytes; fall back to URI download.
    let buf: Buffer;
    if (generated.video.videoBytes) {
      buf = Buffer.from(generated.video.videoBytes as string, "base64");
    } else if (generated.video.uri) {
      const res = await fetch(generated.video.uri);
      if (!res.ok) throw new Error(`fetch Veo video URI: ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error("Veo video has neither videoBytes nor uri");
    }

    const { url } = await uploadBufferToTransloadit(buf, "generated.mp4", "video/mp4");

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
