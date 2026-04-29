import { task } from "@trigger.dev/sdk/v3";
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

export const cropImageTask = task({
  id: "crop-image",
  retry: { maxAttempts: 1 },
  run: async (payload: CropPayload, { ctx }): Promise<CropOutput> => {
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
    } finally {
      // ctx is referenced to keep Trigger's tree-shaker from dropping the import in dev.
      void ctx?.run?.id;
    }
  },
});
