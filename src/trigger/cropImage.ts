import { cropImageViaTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";
import { rethrowClassified } from "@/lib/triggerErrors";

export type CropPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  inputUrl: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CropOutput = { url: string };

/**
 * PRD §"MANDATORY 30+ second artificial delay on Crop Image":
 * after the FFmpeg crop resolves, await at least 30 seconds before returning.
 * Hard requirement — do not skip.
 */
const ARTIFICIAL_DELAY_MS = 30_000;

/**
 * Worker function (not a Trigger task). Updates the pre-created NodeRun
 * row instead of creating it: the orchestrator now pre-creates every
 * executable node's row in QUEUED status during setup so the History
 * sidebar can show upcoming work, and the recursive dispatcher can claim
 * each row atomically (CAS QUEUED → RUNNING) before triggering the
 * worker.
 *
 * The NodeRun row's status is already RUNNING when this function is
 * called (the dispatcher's `tryClaimNodeRun` set it). We re-stamp
 * `startedAt` so node duration reflects real worker start time, not
 * the queue-claim time.
 */
export async function runCropImage(payload: CropPayload): Promise<CropOutput> {
  // SUCCESS-guard: if a previous attempt finished writing the output
  // before crashing, don't redo the work — Transloadit's a paid round-trip
  // and the 30 s artificial delay would double the wall-clock time.
  // Returning the persisted output keeps the worker idempotent under
  // Trigger.dev's retry policy.
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
        x: payload.x,
        y: payload.y,
        w: payload.w,
        h: payload.h,
        inputUrl: payload.inputUrl,
      },
    },
  });

  try {
    const { url } = await cropImageViaTransloadit({
      inputUrl: payload.inputUrl,
      x: payload.x,
      y: payload.y,
      w: payload.w,
      h: payload.h,
    });

    // MANDATORY artificial delay (PRD requirement, do not remove).
    await new Promise((r) => setTimeout(r, ARTIFICIAL_DELAY_MS));

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
    // Classify: permanent (4xx-ish, validation) → AbortTaskRunError so the
    // retry policy short-circuits. Transient (network, 5xx, rate limit) →
    // rethrow as-is so Trigger retries with backoff.
    rethrowClassified(err);
  }
}
