import { wait } from "@trigger.dev/sdk/v3";
import { googleAI } from "@/lib/googleai";
import { uploadBufferToTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { rethrowClassified } from "@/lib/triggerErrors";
import type { Prisma } from "@prisma/client";

export type ExtendVideoPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  model: string;
  prompt: string;
  inputVideoUrl: string;
  durationSeconds: number;
  aspectRatio: string;
  negativePrompt?: string;
  seed?: number;
  fps?: number;
  resolution?: string;
  generateAudio?: boolean;
  enhancePrompt?: boolean;
  personGeneration?: string;
};

export type ExtendVideoOutput = { url: string };

/**
 * Worker for the extendVideo node. Uses Veo's `video` parameter to continue
 * (extend) an existing generated video. The `video` and `image` params are
 * mutually exclusive in Veo's API — this worker uses `video` while
 * generateVideo uses `image` for image-to-video mode.
 *
 * The input video is fetched, base64-encoded, and passed as `videoBytes`.
 * Same async polling pattern as generateVideo.ts.
 */
export async function runExtendVideo(
  payload: ExtendVideoPayload,
): Promise<ExtendVideoOutput> {
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
    inputVideoUrl: payload.inputVideoUrl,
    durationSeconds: payload.durationSeconds,
    aspectRatio: payload.aspectRatio,
  };

  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: { startedAt, input: inputRecord as Prisma.InputJsonValue },
  });

  try {
    // Fetch video bytes for Veo's video continuation parameter.
    const videoRes = await fetch(payload.inputVideoUrl);
    if (!videoRes.ok) {
      throw new Error(`fetch input video: ${videoRes.status} ${videoRes.statusText}`);
    }
    const videoArrBuf = await videoRes.arrayBuffer();
    const videoB64 = Buffer.from(videoArrBuf).toString("base64");
    const contentType = videoRes.headers.get("content-type") ?? "video/mp4";
    const mimeType = contentType.split(";")[0];

    const ai = googleAI();

    let operation = await ai.models.generateVideos({
      model: payload.model,
      prompt: payload.prompt,
      video: { videoBytes: videoB64, mimeType },
      config: {
        durationSeconds: payload.durationSeconds,
        aspectRatio: payload.aspectRatio,
        numberOfVideos: 1,
        ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
        ...(payload.seed != null ? { seed: payload.seed } : {}),
        ...(payload.fps != null ? { fps: payload.fps } : {}),
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
        ...(payload.generateAudio != null ? { generateAudio: payload.generateAudio } : {}),
        ...(payload.enhancePrompt != null ? { enhancePrompt: payload.enhancePrompt } : {}),
        ...(payload.personGeneration ? { personGeneration: payload.personGeneration } : {}),
      },
    });

    let attempts = 0;
    const MAX_ATTEMPTS = 60;
    while (!operation.done && attempts < MAX_ATTEMPTS) {
      await wait.for({ seconds: 10 });
      operation = await ai.operations.getVideosOperation({ operation });
      attempts++;
    }

    if (!operation.done) {
      throw new Error("Veo video extension timed out after 10 minutes");
    }

    const generated = operation.response?.generatedVideos?.[0];
    if (!generated?.video) {
      throw new Error("Veo returned no video in extension response");
    }

    let buf: Buffer;
    if (generated.video.videoBytes) {
      buf = Buffer.from(generated.video.videoBytes as string, "base64");
    } else if (generated.video.uri) {
      const res = await fetch(generated.video.uri);
      if (!res.ok) throw new Error(`fetch Veo extend URI: ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error("Veo extended video has neither videoBytes nor uri");
    }

    const { url } = await uploadBufferToTransloadit(buf, "extended.mp4", "video/mp4");

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
