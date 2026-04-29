import { task } from "@trigger.dev/sdk/v3";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type RequestInputsPayload = {
  workflowRunId: string;
  nodeId: string;
  fields: Record<string, unknown>;
};

export type RequestInputsOutput = { fields: Record<string, unknown> };

/**
 * Pure pass-through; surfaces the user-supplied inputs so downstream tasks can
 * read them via the shared NodeRun store. Logged as a NodeRun for the history
 * sidebar to render alongside the rest.
 */
export const requestInputsTask = task({
  id: "request-inputs",
  run: async (payload: RequestInputsPayload): Promise<RequestInputsOutput> => {
    const startedAt = new Date();
    const nr = await prisma.nodeRun.create({
      data: {
        workflowRunId: payload.workflowRunId,
        nodeId: payload.nodeId,
        nodeType: "requestInputs",
        status: "RUNNING",
        startedAt,
        input: payload.fields as unknown as Prisma.InputJsonValue,
      },
    });
    const finishedAt = new Date();
    await prisma.nodeRun.update({
      where: { id: nr.id },
      data: {
        status: "SUCCESS",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        output: { fields: payload.fields } as unknown as Prisma.InputJsonValue,
      },
    });
    return { fields: payload.fields };
  },
});
