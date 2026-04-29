import { task } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";

export type ResponsePayload = {
  workflowRunId: string;
  nodeId: string;
  result: string | null;
};

export type ResponseOutput = { result: string | null; perEdge?: Record<string, string> };

export const responseTask = task({
  id: "response",
  run: async (payload: ResponsePayload): Promise<ResponseOutput> => {
    const startedAt = new Date();
    const nr = await prisma.nodeRun.create({
      data: {
        workflowRunId: payload.workflowRunId,
        nodeId: payload.nodeId,
        nodeType: "response",
        status: "RUNNING",
        startedAt,
        input: { result: payload.result },
      },
    });
    const finishedAt = new Date();
    await prisma.nodeRun.update({
      where: { id: nr.id },
      data: {
        status: "SUCCESS",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        output: { result: payload.result },
      },
    });
    return { result: payload.result };
  },
});
