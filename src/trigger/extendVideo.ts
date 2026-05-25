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
 * Worker for the extendVideo node — native Veo video continuation.
 *
 * Veo on the Gemini Developer API only accepts the input video by URI from
 * the Files API (raw videoBytes are rejected — the SDK comment confirms
 * "Gemini API does not support video bytes"). Flow:
 *
 *   1. Download the input video to a temp file.
 *   2. Upload it to the Gemini Files API via ai.files.upload.
 *   3. Poll ai.files.get until the file reaches ACTIVE state (videos go
 *      through PROCESSING first).
 *   4. Call generateVideos with `video: { uri }` (no mimeType — that
 *      serializes to `encoding`, which Veo rejects).
 *   5. Poll the Veo operation until done.
 *   6. Download the continuation and stitch it with the original using
 *      FFmpeg so the output is the full combined video.
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
    // 1. Download input video to disk.
    const videoRes = await fetch(payload.inputVideoUrl);
    if (!videoRes.ok) {
      throw new Error(`fetch input video: ${videoRes.status} ${videoRes.statusText}`);
    }
    const inputPath = join(workdir, "input.mp4");
    await writeFile(inputPath, Buffer.from(await videoRes.arrayBuffer()));

    const ai = googleAI();

    // 2. Upload to Gemini Files API.
    const uploaded = await ai.files.upload({
      file: inputPath,
      config: { mimeType: "video/mp4" },
    });
    if (!uploaded.name) {
      throw new Error("Gemini Files API upload returned no file name");
    }

    // 3. Poll until the file is ACTIVE (video processing can take a while).
    let fileInfo = uploaded;
    let fileAttempts = 0;
    const MAX_FILE_ATTEMPTS = 60; // 60 × 5 s = 5 min ceiling
    while (fileInfo.state !== "ACTIVE" && fileAttempts < MAX_FILE_ATTEMPTS) {
      if (fileInfo.state === "FAILED") {
        throw new Error("Gemini Files API: input video processing failed");
      }
      await wait.for({ seconds: 5 });
      fileInfo = await ai.files.get({ name: uploaded.name });
      fileAttempts++;
    }
    if (fileInfo.state !== "ACTIVE") {
      throw new Error("Gemini Files API: input video did not become ACTIVE in 5 minutes");
    }
    if (!fileInfo.uri) {
      throw new Error("Gemini Files API: no URI on ACTIVE file");
    }

    // 4. Call Veo with the file URI (no mimeType — would serialize as `encoding`).
    let operation = await ai.models.generateVideos({
      model: payload.model,
      prompt: payload.prompt,
      video: { uri: fileInfo.uri },
      config: {
        durationSeconds: payload.durationSeconds,
        aspectRatio: payload.aspectRatio,
        numberOfVideos: 1,
        ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
        ...(payload.personGeneration ? { personGeneration: payload.personGeneration } : {}),
      },
    });

    // 5. Poll Veo operation.
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

    // 6. Download the continuation.
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

    // 7. Stitch original + continuation with FFmpeg.
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
