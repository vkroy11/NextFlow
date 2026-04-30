import { callGemini } from "@/lib/gemini";
import { prisma } from "@/lib/prisma";

export type GeminiPayload = {
  workflowRunId: string;
  nodeId: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  imageUrls?: string[];
  temperature?: number;
};

export type GeminiOutput = { text: string };

/**
 * Worker function (not a Trigger task) that calls Gemini and writes the
 * NodeRun row. Invoked from the `node-runner` task so the orchestrator can
 * batch crops and geminis at the same DAG level into a single
 * `batchTriggerAndWait` — the only legal way to fan out *across* task types
 * in Trigger.dev v4.
 *
 * Keeps `nodeType: "gemini"` on the NodeRun so the History sidebar surfaces
 * a labelled gemini row, not a generic node-runner.
 */
export async function runGemini(payload: GeminiPayload): Promise<GeminiOutput> {
  const startedAt = new Date();
  const nodeRun = await prisma.nodeRun.create({
    data: {
      workflowRunId: payload.workflowRunId,
      nodeId: payload.nodeId,
      nodeType: "gemini",
      status: "RUNNING",
      startedAt,
      input: {
        model: payload.model,
        prompt: payload.prompt,
        systemPrompt: payload.systemPrompt,
        temperature: payload.temperature,
        imageCount: payload.imageUrls?.length ?? 0,
      },
    },
  });

  try {
    const text = await callGemini({
      model: payload.model,
      prompt: payload.prompt,
      systemPrompt: payload.systemPrompt,
      imageUrls: payload.imageUrls,
      temperature: payload.temperature,
    });
    const finishedAt = new Date();
    await prisma.nodeRun.update({
      where: { id: nodeRun.id },
      data: {
        status: "SUCCESS",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        output: { text },
      },
    });
    return { text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.nodeRun.update({
      where: { id: nodeRun.id },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    throw err;
  }
}
