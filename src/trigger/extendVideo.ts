import { wait } from "@trigger.dev/sdk/v3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleAI } from "@/lib/googleai";
import { uploadBufferToTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { rethrowClassified } from "@/lib/triggerErrors";
import type { Prisma } from "@prisma/client";

const execFileP = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

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

  personGeneration?: string;
};

export type ExtendVideoOutput = { url: string };

/**
 * Worker for the extendVideo node.
 *
 * Veo on the Gemini Developer API does not accept the `video` parameter
 * (the SDK serializes it as `encodedVideo`, which the model rejects). The
 * supported path is image-to-video: we extract the LAST frame of the input
 * video with FFmpeg and pass it as `image`, which makes Veo continue the
 * scene from that frame. We then stitch original + continuation with FFmpeg
 * so the output is always the full combined video.
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

  const workdir = await mkdtemp(join(tmpdir(), "nf-extend-"));
  try {
    // 1. Fetch input video to disk.
    const videoRes = await fetch(payload.inputVideoUrl);
    if (!videoRes.ok) {
      throw new Error(`fetch input video: ${videoRes.status} ${videoRes.statusText}`);
    }
    const inputPath = join(workdir, "input.mp4");
    await writeFile(inputPath, Buffer.from(await videoRes.arrayBuffer()));

    // 2. Extract the LAST frame for Veo's image-to-video continuation.
    //    -sseof -0.5 seeks to 0.5s before EOF, then -vframes 1 grabs one frame.
    const lastFramePath = join(workdir, "last.jpg");
    await execFileP(
      FFMPEG,
      ["-y", "-sseof", "-0.5", "-i", inputPath, "-vframes", "1", "-q:v", "2", lastFramePath],
      { timeout: 60_000 },
    );
    const lastFrameBuf = await readFile(lastFramePath);
    const lastFrameB64 = lastFrameBuf.toString("base64");

    const ai = googleAI();

    // 3. Ask Veo to continue from the last frame.
    const continuationPrompt = payload.prompt
      ? `Continue the scene naturally. ${payload.prompt}`
      : "Continue the scene naturally from this frame.";

    let operation = await ai.models.generateVideos({
      model: payload.model,
      prompt: continuationPrompt,
      image: { imageBytes: lastFrameB64, mimeType: "image/jpeg" },
      config: {
        durationSeconds: payload.durationSeconds,
        aspectRatio: payload.aspectRatio,
        numberOfVideos: 1,
        ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
        ...(payload.seed != null ? { seed: payload.seed } : {}),
        ...(payload.fps != null ? { fps: payload.fps } : {}),
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
        ...(payload.generateAudio != null ? { generateAudio: payload.generateAudio } : {}),

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

    let continuationBuf: Buffer;
    if (generated.video.videoBytes) {
      continuationBuf = Buffer.from(generated.video.videoBytes as string, "base64");
    } else if (generated.video.uri) {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY!;
      const res = await fetch(`${generated.video.uri}:download?alt=media`, {
        headers: { "x-goog-api-key": apiKey },
      });
      if (!res.ok) throw new Error(`fetch Veo extend URI: ${res.status}`);
      continuationBuf = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error("Veo extended video has neither videoBytes nor uri");
    }

    // Write continuation to disk and stitch with original using FFmpeg.
    const contPath = join(workdir, "continuation.mp4");
    await writeFile(contPath, continuationBuf);

    const outputPath = join(workdir, "merged.mp4");
    await execFileP(
      FFMPEG,
      [
        "-y",
        "-i", inputPath,
        "-i", contPath,
        "-filter_complex", "[0:v:0][1:v:0]concat=n=2:v=1[outv]",
        "-map", "[outv]",
        outputPath,
      ],
      { timeout: 120_000 },
    );
    const mergedBuf = await readFile(outputPath);

    const { url } = await uploadBufferToTransloadit(mergedBuf, "extended.mp4", "video/mp4");

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
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
