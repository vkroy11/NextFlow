import { wait } from "@trigger.dev/sdk/v3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleAI } from "@/lib/googleai";
import { uploadFilePathToTransloadit } from "@/lib/transloadit";
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
  /**
   * Optional Veo Files API URI from a direct upstream `generateVideo` /
   * `enhanceVideo`. When present we attempt native Veo extension first;
   * if that fails (expired URI, model rejection, etc.) we fall back to
   * the last-frame image-to-video approach.
   */
  inputVeoFileUri?: string;
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
 * Worker for the extendVideo node — hybrid strategy.
 *
 * 1. If `inputVeoFileUri` is set (upstream is a fresh Veo node), attempt
 *    native Veo extension: pass `video: { uri }` directly. This produces
 *    the cleanest result but only works for Veo-generated inputs.
 * 2. On any failure (or when no Veo URI is available — uploads, cross-graph
 *    inputs, expired URIs), fall back to image-to-video: extract the last
 *    frame of the input video and seed a new generation from it.
 *
 * Either way, FFmpeg stitches the original input video and the new
 * segment so the output is the full combined video.
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
    nativeAttempted: !!payload.inputVeoFileUri,
  };

  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: { startedAt, input: inputRecord as Prisma.InputJsonValue },
  });

  const workdir = await mkdtemp(join(tmpdir(), "nf-extend-"));
  try {
    // Always download the input video — we need it for both branches:
    // (a) FFmpeg concat at the end, (b) last-frame extraction in fallback.
    const videoRes = await fetch(payload.inputVideoUrl);
    if (!videoRes.ok) {
      throw new Error(`fetch input video: ${videoRes.status} ${videoRes.statusText}`);
    }
    const inputPath = join(workdir, "input.mp4");
    await writeFile(inputPath, Buffer.from(await videoRes.arrayBuffer()));

    const ai = googleAI();

    // Attempt 1: native Veo extension via the upstream URI.
    let continuationBuf: Buffer | null = null;
    let nativeError: string | null = null;

    if (payload.inputVeoFileUri) {
      try {
        let operation = await ai.models.generateVideos({
          model: payload.model,
          prompt: payload.prompt,
          video: { uri: payload.inputVeoFileUri },
          config: {
            durationSeconds: 8, // Veo native extension requires 8 s.
            aspectRatio: payload.aspectRatio,
            numberOfVideos: 1,
            ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
            ...(payload.resolution ? { resolution: payload.resolution } : {}),
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
        if (!operation.done) throw new Error("native Veo extension timed out");

        const generated = operation.response?.generatedVideos?.[0];
        if (!generated?.video) throw new Error("native Veo extension returned no video");

        if (generated.video.videoBytes) {
          continuationBuf = Buffer.from(generated.video.videoBytes as string, "base64");
        } else if (generated.video.uri) {
          const tempPath = join(workdir, "veo-native.mp4");
          await ai.files.download({ file: generated, downloadPath: tempPath });
          continuationBuf = await readFile(tempPath);
        } else {
          throw new Error("native Veo extension: no videoBytes or uri");
        }
      } catch (err) {
        nativeError = err instanceof Error ? err.message : String(err);
        continuationBuf = null;
      }
    }

    // Attempt 2 (fallback): last-frame image-to-video.
    if (!continuationBuf) {
      const lastFramePath = join(workdir, "last.jpg");
      await execFileP(
        FFMPEG,
        ["-y", "-sseof", "-0.5", "-i", inputPath, "-vframes", "1", "-q:v", "2", lastFramePath],
        { timeout: 60_000 },
      );
      const lastFrameBuf = await readFile(lastFramePath);
      const lastFrameB64 = lastFrameBuf.toString("base64");

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
          ...(payload.resolution ? { resolution: payload.resolution } : {}),
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
        throw new Error(
          `Veo extension timed out (fallback path)${nativeError ? `; native attempt: ${nativeError}` : ""}`,
        );
      }

      const generated = operation.response?.generatedVideos?.[0];
      if (!generated?.video) throw new Error("Veo fallback returned no video");

      if (generated.video.videoBytes) {
        continuationBuf = Buffer.from(generated.video.videoBytes as string, "base64");
      } else if (generated.video.uri) {
        const tempPath = join(workdir, "veo-fallback.mp4");
        await ai.files.download({ file: generated, downloadPath: tempPath });
        continuationBuf = await readFile(tempPath);
      } else {
        throw new Error("Veo fallback: no videoBytes or uri");
      }
    }

    // Stitch original + continuation. Video-only concat skips audio so a
    // missing/extra audio track on either side never breaks the merge.
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

    // Upload directly from disk — avoids holding the merged video buffer
    // in memory, which was triggering OOM on small Trigger.dev machines.
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
