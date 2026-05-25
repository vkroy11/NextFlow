import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadBufferToTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { runGenerateVideo } from "./generateVideo";
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
};

export type EnhanceVideoOutput = { url: string };

/**
 * Worker for the enhanceVideo node. Strategy:
 *   1. Download the input video to a temp file.
 *   2. Extract the first frame using FFmpeg.
 *   3. Upload the frame to Transloadit CDN.
 *   4. Use Veo 3.1 image-to-video (from runGenerateVideo) with that frame,
 *      prompting for an enhanced, high-quality version.
 *
 * This leverages Veo's image-to-video capability since Veo's native upscaling
 * API is currently in private preview only. The output is a Veo-regenerated
 * video that captures the visual content of the original first frame.
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

    // 4. Use Veo image-to-video — reuse the generateVideo worker's full logic.
    const enhancedPrompt = payload.prompt
      ? `Enhance and improve the quality of this video. ${payload.prompt}`
      : "Enhance and improve the quality of this video, making it sharper and more vivid.";

    return await runGenerateVideo({
      workflowRunId: payload.workflowRunId,
      nodeRunId: payload.nodeRunId,
      nodeId: payload.nodeId,
      model: payload.model,
      prompt: enhancedPrompt,
      inputImageUrl: frameUrl,
      durationSeconds: 6,
      aspectRatio: "16:9",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only write FAILED if runGenerateVideo hasn't already done it.
    const current = await prisma.nodeRun.findUnique({
      where: { id: payload.nodeRunId },
      select: { status: true },
    });
    if (current && current.status !== "SUCCESS" && current.status !== "FAILED") {
      await prisma.nodeRun.update({
        where: { id: payload.nodeRunId },
        data: { status: "FAILED", finishedAt: new Date(), error: message },
      });
    }
    throw err;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
