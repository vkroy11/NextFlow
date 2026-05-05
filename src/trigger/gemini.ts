import { streams } from "@trigger.dev/sdk/v3";
import { streamGeminiText } from "@/lib/gemini";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { rethrowClassified } from "@/lib/triggerErrors";

export type GeminiPayload = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  model: string;
  prompt: string;
  systemPrompt?: string;
  imageUrls?: string[];
  temperature?: number;
};

export type GeminiOutput = { text: string };

/**
 * Worker function (not a Trigger task). Updates the pre-created NodeRun
 * row — see `runCropImage` for the rationale.
 */
export async function runGemini(payload: GeminiPayload): Promise<GeminiOutput> {
  // SUCCESS-guard: if an earlier attempt already wrote the response, skip
  // the (paid) Gemini round-trip on retry.
  const existing = await prisma.nodeRun.findUnique({
    where: { id: payload.nodeRunId },
    select: { status: true, output: true },
  });
  if (existing?.status === "SUCCESS" && existing.output) {
    const out = existing.output as { text?: string };
    if (typeof out.text === "string") return { text: out.text };
  }

  const startedAt = new Date();
  // Build the input record to persist on the NodeRun row. We deliberately
  // omit `imageUrls` when empty so the History sidebar's JSON view doesn't
  // surface a misleading `imageUrls: []`. When present we store the actual
  // URLs (not just a count) so the user can click through to inspect the
  // exact bytes Gemini saw — useful when debugging "why didn't the model
  // see the cropped output".
  const inputRecord: Record<string, unknown> = {
    model: payload.model,
    prompt: payload.prompt,
  };
  if (payload.systemPrompt) inputRecord.systemPrompt = payload.systemPrompt;
  if (payload.temperature !== undefined) inputRecord.temperature = payload.temperature;
  if (payload.imageUrls && payload.imageUrls.length > 0) {
    inputRecord.imageUrls = payload.imageUrls;
  }
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: inputRecord as Prisma.InputJsonValue,
    },
  });

  try {
    // Stream Gemini chunks through Trigger.dev Realtime. The browser
    // subscribes via useRealtimeRunWithStreams and renders chunks as
    // they arrive, so the user sees the response materialise live
    // instead of waiting for the full text to land in NodeRun.output.
    const chunkSource = streamGeminiText({
      model: payload.model,
      prompt: payload.prompt,
      systemPrompt: payload.systemPrompt,
      imageUrls: payload.imageUrls,
      temperature: payload.temperature,
    });
    const { stream, waitUntilComplete } = streams.pipe("gemini", chunkSource);

    let text = "";
    for await (const chunk of stream) text += chunk;
    await waitUntilComplete();
    const finishedAt = new Date();
    await prisma.nodeRun.update({
      where: { id: payload.nodeRunId },
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
      where: { id: payload.nodeRunId },
      data: { status: "FAILED", finishedAt: new Date(), error: message },
    });
    rethrowClassified(err);
  }
}
