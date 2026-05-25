import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFilePathToTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { rethrowClassified } from "@/lib/triggerErrors";
import type { Prisma } from "@prisma/client";

const execFileP = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export type MuxAudioVideoPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  videoUrl: string;
  audioUrl: string;
};

export type MuxAudioVideoOutput = { url: string };

/**
 * Worker for the muxAudioVideo node — replaces (or adds) an audio track
 * on a video using FFmpeg. Re-encodes audio to AAC for max compatibility;
 * keeps the video stream as a copy so there's no quality loss. `-shortest`
 * stops at the end of the shorter input.
 */
export async function runMuxAudioVideo(
  payload: MuxAudioVideoPayload,
): Promise<MuxAudioVideoOutput> {
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
        videoUrl: payload.videoUrl,
        audioUrl: payload.audioUrl,
      } as Prisma.InputJsonValue,
    },
  });

  const workdir = await mkdtemp(join(tmpdir(), "nf-mux-"));
  try {
    // Download both inputs to disk.
    const videoRes = await fetch(payload.videoUrl);
    if (!videoRes.ok) {
      throw new Error(`fetch video: ${videoRes.status} ${videoRes.statusText}`);
    }
    const videoPath = join(workdir, "video.mp4");
    await writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer()));

    const audioRes = await fetch(payload.audioUrl);
    if (!audioRes.ok) {
      throw new Error(`fetch audio: ${audioRes.status} ${audioRes.statusText}`);
    }
    const audioPath = join(workdir, "audio.wav");
    await writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer()));

    // Mux. -map 0:v:0 takes video from input 0, -map 1:a:0 takes audio from
    // input 1, so the original video's audio (if any) is replaced.
    const outputPath = join(workdir, "muxed.mp4");
    await execFileP(
      FFMPEG,
      [
        "-y",
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        outputPath,
      ],
      { timeout: 120_000 },
    );

    const { url } = await uploadFilePathToTransloadit(outputPath);

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
