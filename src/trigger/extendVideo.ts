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
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export type ExtendVideoPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  model: string;
  prompt: string;
  inputVideoUrl: string;
  inputVeoFileUri?: string;
  durationSeconds: number;
  aspectRatio: string;
  negativePrompt?: string;
  resolution?: string;
  personGeneration?: string;
};

export type ExtendVideoOutput = { url: string };

async function ffprobeDuration(path: string): Promise<number> {
  const { stdout } = await execFileP(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const n = Number(stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Worker for the extendVideo node.
 *
 * 1. Native path: when `inputVeoFileUri` is set, call Veo with
 *    `video: { uri }`. Veo may return the *full* extended video (input +
 *    new segment already merged) or only the continuation, depending on
 *    model behavior. We `ffprobe` the result and only concat if the
 *    returned clip is short enough to be just the continuation.
 * 2. Fallback path: extract last frame, image-to-video, then always concat.
 *
 * Either path ends with an audio remux step that copies the input video's
 * audio track onto the final output (Veo on the Gemini Developer API does
 * not generate audio, so we always need to bring the original audio across).
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
    // Always download the input video to disk — needed for ffprobe,
    // concat, last-frame extraction, and the final audio remux.
    const videoRes = await fetch(payload.inputVideoUrl);
    if (!videoRes.ok) {
      throw new Error(`fetch input video: ${videoRes.status} ${videoRes.statusText}`);
    }
    const inputPath = join(workdir, "input.mp4");
    await writeFile(inputPath, Buffer.from(await videoRes.arrayBuffer()));
    const inputDuration = await ffprobeDuration(inputPath);

    const ai = googleAI();

    // ---------- Attempt 1: native Veo extension ----------
    let veoOutputPath: string | null = null;
    let nativeMerged = false;
    let nativeError: string | null = null;

    if (payload.inputVeoFileUri) {
      try {
        let operation = await ai.models.generateVideos({
          model: payload.model,
          prompt: payload.prompt,
          video: { uri: payload.inputVeoFileUri },
          config: {
            durationSeconds: 8, // Native extension requires 8 s.
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

        const nativePath = join(workdir, "veo-native.mp4");
        if (generated.video.videoBytes) {
          await writeFile(nativePath, Buffer.from(generated.video.videoBytes as string, "base64"));
        } else if (generated.video.uri) {
          await ai.files.download({ file: generated, downloadPath: nativePath });
        } else {
          throw new Error("native Veo extension: no videoBytes or uri");
        }

        const nativeDuration = await ffprobeDuration(nativePath);
        // Sanity check: Veo will sometimes echo the input back unchanged
        // (silent failure mode on the preview model). Falling through to
        // the last-frame fallback gives a real extension instead of
        // shipping the user's input as the "extended" output.
        if (Math.abs(nativeDuration - inputDuration) < 1.0) {
          throw new Error(
            `Veo native returned same-duration video (${nativeDuration.toFixed(1)}s ≈ input ${inputDuration.toFixed(1)}s) — no extension happened`,
          );
        }
        // If Veo returned the merged video (input + extension) we expect
        // its duration to be at least the input's duration plus a few
        // seconds. If it's much shorter, we got just the continuation.
        if (nativeDuration >= inputDuration + 3) {
          nativeMerged = true;
        }
        veoOutputPath = nativePath;
      } catch (err) {
        nativeError = err instanceof Error ? err.message : String(err);
        veoOutputPath = null;
      }
    }

    // ---------- Attempt 2: fallback last-frame image-to-video ----------
    if (!veoOutputPath) {
      const lastFramePath = join(workdir, "last.jpg");
      await execFileP(
        FFMPEG,
        ["-y", "-sseof", "-0.5", "-i", inputPath, "-vframes", "1", "-q:v", "2", lastFramePath],
        { timeout: 60_000 },
      );
      const lastFrameB64 = (await readFile(lastFramePath)).toString("base64");

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
          `Veo extension timed out (fallback)${nativeError ? `; native: ${nativeError}` : ""}`,
        );
      }

      const generated = operation.response?.generatedVideos?.[0];
      if (!generated?.video) throw new Error("Veo fallback returned no video");

      const fallbackPath = join(workdir, "veo-fallback.mp4");
      if (generated.video.videoBytes) {
        await writeFile(fallbackPath, Buffer.from(generated.video.videoBytes as string, "base64"));
      } else if (generated.video.uri) {
        await ai.files.download({ file: generated, downloadPath: fallbackPath });
      } else {
        throw new Error("Veo fallback: no videoBytes or uri");
      }
      veoOutputPath = fallbackPath;
    }

    // ---------- Concat (skip if native path already merged) ----------
    const concatPath = join(workdir, "concat.mp4");
    if (nativeMerged) {
      // Already merged — just rename the path forward.
      await execFileP(FFMPEG, ["-y", "-i", veoOutputPath, "-c", "copy", concatPath], {
        timeout: 60_000,
      });
    } else {
      await execFileP(
        FFMPEG,
        [
          "-y",
          "-i", inputPath,
          "-i", veoOutputPath,
          "-filter_complex", "[0:v:0][1:v:0]concat=n=2:v=1[outv]",
          "-map", "[outv]",
          concatPath,
        ],
        { timeout: 120_000 },
      );
    }

    // ---------- Final audio remux ----------
    // Bring the input's audio track (if any) onto the final video.
    // `0:a:0?` makes the audio map optional — silent input still works.
    // No `-shortest`: the extended video is longer than the input's audio,
    // and `-shortest` would slice the video back down to the input's
    // duration, leaving the user with their input video unchanged. Without
    // it the audio plays for its natural length and the video continues
    // silently. A downstream `muxAudioVideo` node can replace the audio
    // with TTS or any other track if the silent tail matters.
    const finalPath = join(workdir, "final.mp4");
    await execFileP(
      FFMPEG,
      [
        "-y",
        "-i", concatPath,       // video source
        "-i", inputPath,        // audio source (original)
        "-map", "0:v:0",
        "-map", "1:a:0?",
        "-c:v", "copy",
        "-c:a", "aac",
        finalPath,
      ],
      { timeout: 120_000 },
    );

    const { url } = await uploadFilePathToTransloadit(finalPath);

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
