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

export type EnhanceVideoPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  model: string;
  prompt: string;
  inputVideoUrl: string;
  durationSeconds?: number;
  aspectRatio?: string;
  negativePrompt?: string;
  seed?: number;
  generateAudio?: boolean;

};

export type EnhanceVideoOutput = { url: string; veoFileUri?: string };

/**
 * Worker for the enhanceVideo node. Strategy:
 *   1. Download the input video to a temp file.
 *   2. Extract the first frame using FFmpeg.
 *   3. Upload the frame to Transloadit CDN.
 *   4. Use Veo 3.1 image-to-video with the extracted frame and an
 *      enhancement prompt to regenerate a high-quality version.
 *
 * Veo's native upscaling API is in private preview; this approach uses
 * frame-extraction + image-to-video as the best available public API path.
 */
export async function runEnhanceVideo(
  payload: EnhanceVideoPayload,
): Promise<EnhanceVideoOutput> {
  const existing = await prisma.nodeRun.findUnique({
    where: { id: payload.nodeRunId },
    select: { status: true, output: true },
  });
  if (existing?.status === "SUCCESS" && existing.output) {
    const out = existing.output as { url?: string };
    if (typeof out.url === "string") return { url: out.url };
  }

  const startedAt = new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: {
        model: payload.model,
        prompt: payload.prompt,
        inputVideoUrl: payload.inputVideoUrl,
        durationSeconds: payload.durationSeconds ?? 6,
        aspectRatio: payload.aspectRatio ?? "16:9",
      } as Prisma.InputJsonValue,
    },
  });

  const workdir = await mkdtemp(join(tmpdir(), "nf-enhance-"));
  try {
    // 1. Download input video.
    const videoPath = join(workdir, "input.mp4");
    const videoRes = await fetch(payload.inputVideoUrl);
    if (!videoRes.ok) {
      throw new Error(`fetch input video: ${videoRes.status} ${videoRes.statusText}`);
    }
    await writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer()));

    // 2. Extract first frame.
    const framePath = join(workdir, "frame.jpg");
    await execFileP(
      FFMPEG,
      ["-y", "-i", videoPath, "-vframes", "1", "-q:v", "2", framePath],
      { timeout: 60_000 },
    );
    const frameBuf = await readFile(framePath);

    // 3. Upload frame to CDN.
    const { url: frameUrl } = await uploadBufferToTransloadit(frameBuf, "frame.jpg", "image/jpeg");

    // 4. Fetch frame bytes for Veo's image parameter.
    const frameRes = await fetch(frameUrl);
    if (!frameRes.ok) throw new Error(`re-fetch frame: ${frameRes.status}`);
    const frameArrBuf = await frameRes.arrayBuffer();
    const frameB64 = Buffer.from(frameArrBuf).toString("base64");

    const enhancedPrompt = payload.prompt
      ? `Enhance and improve the quality of this video. ${payload.prompt}`
      : "Enhance and improve the quality of this video, making it sharper and more vivid.";

    // 5. Call Veo image-to-video and poll until complete.
    const ai = googleAI();
    let operation = await ai.models.generateVideos({
      model: payload.model,
      prompt: enhancedPrompt,
      image: { imageBytes: frameB64, mimeType: "image/jpeg" },
      config: {
        durationSeconds: payload.durationSeconds ?? 6,
        aspectRatio: payload.aspectRatio ?? "16:9",
        numberOfVideos: 1,
        ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
        ...(payload.seed != null ? { seed: payload.seed } : {}),
        ...(payload.generateAudio != null ? { generateAudio: payload.generateAudio } : {}),

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
      throw new Error("Veo enhance timed out after 10 minutes");
    }

    const generated = operation.response?.generatedVideos?.[0];
    if (!generated?.video) {
      throw new Error("Veo returned no video in enhance response");
    }

    let buf: Buffer;
    if (generated.video.videoBytes) {
      buf = Buffer.from(generated.video.videoBytes as string, "base64");
    } else if (generated.video.uri) {
      const tempPath = join(workdir, "veo-output.mp4");
      await ai.files.download({ file: generated, downloadPath: tempPath });
      buf = await readFile(tempPath);
    } else {
      throw new Error("Veo enhance video has neither videoBytes nor uri");
    }

    const veoFileUri = generated.video.uri ?? undefined;
    const { url } = await uploadBufferToTransloadit(buf, "enhanced.mp4", "video/mp4");

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
