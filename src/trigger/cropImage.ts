import { cropImageViaTransloadit } from "@/lib/transloadit";
import { prisma } from "@/lib/prisma";

export type CropPayload = {
  workflowRunId: string;
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
 * Worker function (not a Trigger task) that performs the crop and writes the
 * NodeRun row. Invoked from the `node-runner` task so cross-type DAG-level
 * batches (e.g. {crop1, crop2, gemini1}) can fan out concurrently via a
 * single `batchTriggerAndWait` call without violating Trigger.dev v4's
 * one-pending-wait rule.
 *
 * NodeRun bookkeeping stays in here so our History sidebar (which reads the
 * `NodeRun` table) shows `cropImage` rows — never `node-runner` rows.
 */
export async function runCropImage(payload: CropPayload): Promise<CropOutput> {
  const startedAt = new Date();
  const nodeRun = await prisma.nodeRun.create({
    data: {
      workflowRunId: payload.workflowRunId,
      nodeId: payload.nodeId,
      nodeType: "cropImage",
      status: "RUNNING",
      startedAt,
      input: { x: payload.x, y: payload.y, w: payload.w, h: payload.h, inputUrl: payload.inputUrl },
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
      where: { id: nodeRun.id },
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
      where: { id: nodeRun.id },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    throw err;
  }
}
