import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import type { NodeOutput } from "./dagDispatch";

/**
 * Worker functions for the cheap, no-network node types. Each takes the
 * pre-created NodeRun row's id (already CAS-claimed to RUNNING by the
 * dispatcher) and updates it with the resolved output.
 *
 * They live in their own module rather than the orchestrator because the
 * recursive dispatcher (`nodeRunnerTask`) is the one that calls them now,
 * not the level-walker — every node type goes through `node-runner` so the
 * "fire children when their parents finish" semantics is uniform.
 *
 * They still finish in tens of milliseconds (no Transloadit / Gemini round
 * trips), but that's irrelevant for correctness — a tiny overhead from
 * the Trigger task hop is the price of making LLM2 truly start at
 * t = LLM1.finishedAt instead of waiting for unrelated siblings.
 */

export type InlineWorkerCommon = {
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
};

export type RequestInputsRunPayload = InlineWorkerCommon & {
  fields: Record<string, unknown>;
};
export type RequestInputsRunOutput = { fields: Record<string, unknown> };

export type InputRunPayload = InlineWorkerCommon & {
  fieldType: string | undefined;
  value: unknown;
};
export type InputRunOutput = { fields: Record<string, unknown> };

export type ResponseRunPayload = InlineWorkerCommon & {
  primary: string | null;
  perEdge: Record<string, string>;
};
export type ResponseRunOutput = { result: string | null; perEdge: Record<string, string> };

export async function runRequestInputs(
  payload: RequestInputsRunPayload,
): Promise<RequestInputsRunOutput> {
  const startedAt = new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: payload.fields as object,
    },
  });
  const finishedAt = new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      status: "SUCCESS",
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      output: { fields: payload.fields as Prisma.InputJsonValue },
    },
  });
  return { fields: payload.fields };
}

export async function runInput(payload: InputRunPayload): Promise<InputRunOutput> {
  const startedAt = new Date();
  const handleId = (payload.fieldType ?? "text").toLowerCase();
  let value = payload.value;
  if (typeof value === "object" && value && "url" in (value as object)) {
    value = (value as { url: string }).url;
  }
  const fields = { [handleId]: value };
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: { fieldType: payload.fieldType, value: value as Prisma.InputJsonValue },
    },
  });
  const finishedAt = new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      status: "SUCCESS",
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      output: { fields: fields as Prisma.InputJsonValue },
    },
  });
  return { fields };
}

export async function runResponse(payload: ResponseRunPayload): Promise<ResponseRunOutput> {
  const startedAt = new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: { primary: payload.primary, perEdge: payload.perEdge },
    },
  });
  const finishedAt = new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      status: "SUCCESS",
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      output: { result: payload.primary, perEdge: payload.perEdge },
    },
  });
  return { result: payload.primary, perEdge: payload.perEdge };
}

/**
 * Build the response node's inputs from the resolved parent outputs +
 * the canvas edges. Same logic as the historic in-orchestrator
 * `runResponseInline`, lifted to the dispatcher so it can run there.
 */
export function buildResponseInputs(
  node: CanvasNode,
  edges: CanvasEdge[],
  parentByEdge: Record<string, NodeOutput>,
): { primary: string | null; perEdge: Record<string, string> } {
  const perEdge: Record<string, string> = {};
  let primary: string | null = null;
  for (const pid of Object.keys(parentByEdge)) {
    for (const edge of edges.filter((e) => e.source === pid && e.target === node.id)) {
      const out = parentByEdge[pid];
      if (!out) continue;
      let v: string | null = null;
      if (out.kind === "gemini") v = out.output.text;
      else if (out.kind === "cropImage") v = out.output.url;
      else if (out.kind === "requestInputs") {
        const sourceHandle = (edge.sourceHandle ?? "").toLowerCase();
        const x = out.output.fields[sourceHandle];
        if (typeof x === "string") v = x;
        else if (typeof x === "number" || typeof x === "boolean") v = String(x);
      }
      if (v !== null) {
        perEdge[edge.id] = v;
        if (primary === null) primary = v;
      }
    }
  }
  return { primary, perEdge };
}
