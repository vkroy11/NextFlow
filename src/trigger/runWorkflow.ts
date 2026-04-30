import { task } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";
import { buildAdjacency, hasCycle, upstreamClosure } from "@/lib/dag";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import { cropImageTask, type CropOutput } from "./cropImage";
import { geminiTask, type GeminiOutput } from "./gemini";
import { requestInputsTask, type RequestInputsOutput } from "./requestInputs";
import { responseTask, type ResponseOutput } from "./response";

type Scope = "FULL" | "SINGLE" | "MULTI";

export type RunWorkflowPayload = {
  workflowRunId: string;
  workflowId: string;
  scope: Scope;
  targetNodeIds?: string[];
};

type NodeOutput =
  | { kind: "requestInputs"; output: RequestInputsOutput }
  | { kind: "cropImage"; output: CropOutput }
  | { kind: "gemini"; output: GeminiOutput }
  | { kind: "response"; output: ResponseOutput };

/**
 * Walks the workflow DAG and dispatches each executable node as a child task.
 * Concurrency model (PRD §"Expected execution behavior"):
 *   - Independent nodes start at T=0 (concurrent fan-out).
 *   - A downstream node starts the moment *its direct upstreams* resolve —
 *     it does NOT wait for unrelated siblings at the same level.
 *
 * Implementation: each node's execution is a Promise; for each node we await
 * only its parents' Promises before triggering its own task. Promise.all over
 * leaves waits the whole graph.
 */
export const runWorkflowTask = task({
  id: "run-workflow",
  maxDuration: 600,
  run: async (payload: RunWorkflowPayload) => {
    const { workflowRunId, workflowId, scope, targetNodeIds } = payload;

    const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new Error(`workflow ${workflowId} not found`);

    const nodes = workflow.nodes as unknown as CanvasNode[];
    const edges = workflow.edges as unknown as CanvasEdge[];

    if (hasCycle(nodes, edges)) {
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: "FAILED", finishedAt: new Date(), error: "Cycle detected in workflow" },
      });
      throw new Error("Cycle detected in workflow DAG");
    }

    // Decide which nodes execute. SINGLE/MULTI scope still needs upstream closure
    // so target nodes have valid inputs. Sticky notes are visual annotations
    // and are excluded from execution unconditionally.
    const executable = new Set<string>(nodes.filter((n) => n.type !== "stickyNote").map((n) => n.id));
    if (scope !== "FULL" && targetNodeIds && targetNodeIds.length > 0) {
      const closure = upstreamClosure(nodes, edges, targetNodeIds);
      executable.clear();
      for (const id of closure) {
        const n = nodes.find((x) => x.id === id);
        if (n?.type !== "stickyNote") executable.add(id);
      }
    }

    const { inn } = buildAdjacency(nodes, edges);
    const byId = new Map(nodes.map((n) => [n.id, n] as const));

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: "RUNNING" },
    });

    // Memoize once-resolved outputs and once-failed errors so a node visited
    // twice (e.g. as parent of multiple downstream nodes) does not re-run
    // and does not silently lose its error.
    const outputs = new Map<string, NodeOutput>();
    const errors = new Map<string, unknown>();

    async function runNode(nodeId: string): Promise<NodeOutput> {
      const cached = outputs.get(nodeId);
      if (cached) return cached;
      const cachedErr = errors.get(nodeId);
      if (cachedErr !== undefined) throw cachedErr;
      const node = byId.get(nodeId);
      if (!node) throw new Error(`node ${nodeId} not in graph`);

      // Trigger.dev v4 disallows multiple triggerAndWaits being "pending"
      // on the same task at the same time — including via eager-fan-out
      // IIFEs we tried earlier. The orchestrator now walks the DAG strictly
      // sequentially: parents resolve completely before this node's task
      // is even invoked. Loses sibling concurrency, but the run actually
      // finishes (no more "Parallel waits are not supported" crash).
      const parentIds = inn.get(nodeId) ?? [];
      const parentByEdge: Record<string, NodeOutput> = {};
      for (const pid of parentIds) {
        parentByEdge[pid] = await runNode(pid);
      }

      let output: NodeOutput;
      try {
        output = await runNodeBody(node, parentByEdge);
      } catch (err) {
        errors.set(nodeId, err);
        throw err;
      }
      outputs.set(nodeId, output);
      return output;
    }

    async function runNodeBody(
      node: CanvasNode,
      parentByEdge: Record<string, NodeOutput>,
    ): Promise<NodeOutput> {
      const nodeId = node.id;
      const parentIds = Object.keys(parentByEdge);
      switch (node.type) {
          case "requestInputs": {
            // Pass-through node — inline the NodeRun write here so we skip the
            // ~3s Trigger scheduling overhead of triggerAndWait. The shape
            // returned matches what requestInputsTask would produce so
            // downstream resolvers see no difference.
            const data = node.data as { fields?: Array<{ key: string; value: unknown }> } | undefined;
            const fields: Record<string, unknown> = {};
            for (const f of data?.fields ?? []) fields[f.key] = f.value;
            const startedAt = new Date();
            const nr = await prisma.nodeRun.create({
              data: {
                workflowRunId,
                nodeId,
                nodeType: "requestInputs",
                status: "RUNNING",
                startedAt,
                input: fields as unknown as import("@prisma/client").Prisma.InputJsonValue,
              },
            });
            const finishedAt = new Date();
            await prisma.nodeRun.update({
              where: { id: nr.id },
              data: {
                status: "SUCCESS",
                finishedAt,
                durationMs: finishedAt.getTime() - startedAt.getTime(),
                output: { fields } as unknown as import("@prisma/client").Prisma.InputJsonValue,
              },
            });
            return { kind: "requestInputs", output: { fields } };
          }
          case "cropImage": {
            const data = (node.data ?? {}) as {
              x?: number;
              y?: number;
              w?: number;
              h?: number;
              inputUrl?: string | null;
            };
            const inputUrl =
              resolveImageInput(parentIds, parentByEdge, edges, nodeId) ?? data.inputUrl ?? null;
            if (!inputUrl) throw new Error(`crop ${nodeId}: no input image (connect upstream or upload locally)`);
            const upstreamX = resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "x");
            const upstreamY = resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "y");
            const upstreamW = resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "w");
            const upstreamH = resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "h");
            const handle = await cropImageTask.triggerAndWait({
              workflowRunId,
              nodeId,
              inputUrl,
              x: upstreamX ?? data.x ?? 0,
              y: upstreamY ?? data.y ?? 0,
              w: upstreamW ?? data.w ?? 100,
              h: upstreamH ?? data.h ?? 100,
            });
            if (!handle.ok) throw new Error(`crop failed: ${handle.error}`);
            return { kind: "cropImage", output: handle.output };
          }
          case "gemini": {
            const data = (node.data ?? {}) as {
              model?: string;
              prompt?: string;
              systemPrompt?: string;
              temperature?: number;
            };
            const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
            const systemOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "system_prompt");
            const imageUrls = resolveAllImageInputs(parentIds, parentByEdge, edges, nodeId);
            const handle = await geminiTask.triggerAndWait({
              workflowRunId,
              nodeId,
              model: data.model ?? "gemini-2.5-pro",
              prompt: promptOverride ?? data.prompt ?? "",
              systemPrompt: systemOverride ?? data.systemPrompt,
              temperature: data.temperature,
              imageUrls,
            });
            if (!handle.ok) throw new Error(`gemini failed: ${handle.error}`);
            return { kind: "gemini", output: handle.output };
          }
          case "response": {
            // Inline the response logic: collect every upstream value keyed
            // by edge id so the Response node's labeled cards each surface
            // their own result. Skipping triggerAndWait shaves the Trigger
            // scheduling overhead for what's a pure aggregation.
            const perEdge: Record<string, string> = {};
            let primary: string | null = null;
            for (const pid of parentIds) {
              for (const edge of findEdgeFromParent(pid, nodeId, edges)) {
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
            const startedAt = new Date();
            const nr = await prisma.nodeRun.create({
              data: {
                workflowRunId,
                nodeId,
                nodeType: "response",
                status: "RUNNING",
                startedAt,
                input: { primary, perEdge } as unknown as import("@prisma/client").Prisma.InputJsonValue,
              },
            });
            const finishedAt = new Date();
            await prisma.nodeRun.update({
              where: { id: nr.id },
              data: {
                status: "SUCCESS",
                finishedAt,
                durationMs: finishedAt.getTime() - startedAt.getTime(),
                output: { result: primary, perEdge } as unknown as import("@prisma/client").Prisma.InputJsonValue,
              },
            });
            return { kind: "response", output: { result: primary, perEdge } };
          }
          case "input": {
            // Single-field cousin of requestInputs. Output keyed by the source
            // handle id (= fieldType) so existing resolveTextInput /
            // resolveImageInput / resolveNumberInput pick it up unchanged.
            const data = node.data as { fieldType?: string; value?: unknown } | undefined;
            const handleId = (data?.fieldType ?? "text").toLowerCase();
            let value = data?.value;
            if (typeof value === "object" && value && "url" in value) {
              value = (value as { url: string }).url;
            }
            const startedAt = new Date();
            const nr = await prisma.nodeRun.create({
              data: {
                workflowRunId,
                nodeId,
                nodeType: "input",
                status: "RUNNING",
                startedAt,
                input: { fieldType: data?.fieldType, value } as unknown as import("@prisma/client").Prisma.InputJsonValue,
              },
            });
            const finishedAt = new Date();
            await prisma.nodeRun.update({
              where: { id: nr.id },
              data: {
                status: "SUCCESS",
                finishedAt,
                durationMs: finishedAt.getTime() - startedAt.getTime(),
                output: { fields: { [handleId]: value } } as unknown as import("@prisma/client").Prisma.InputJsonValue,
              },
            });
            return { kind: "requestInputs", output: { fields: { [handleId]: value } } };
          }
          case "stickyNote": {
            // Visual-only node — should never participate in execution because
            // we filter it out of the executable set. This case exists as a
            // belt-and-braces no-op for correctness.
            return { kind: "requestInputs", output: { fields: {} } };
          }
          default:
            throw new Error(`unknown node type: ${node.type}`);
      }
    }

    const targets = scope === "FULL" ? nodes.filter((n) => executable.has(n.id)) : nodes.filter((n) => executable.has(n.id));
    // Top-level walk is also strictly sequential. The runNode memo means a
    // node visited as both a leaf and a parent only triggers its task once.
    const results: PromiseSettledResult<NodeOutput>[] = [];
    for (const n of targets) {
      try {
        const value = await runNode(n.id);
        results.push({ status: "fulfilled", value });
      } catch (reason) {
        results.push({ status: "rejected", reason });
      }
    }

    const failed = results.filter((r) => r.status === "rejected");
    const finalStatus = failed.length === 0 ? "SUCCESS" : failed.length === results.length ? "FAILED" : "PARTIAL";
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
        error: failed.length ? (failed[0] as PromiseRejectedResult).reason?.toString?.() ?? null : null,
      },
    });
    return { status: finalStatus };
  },
});

function findEdgeFromParent(parentId: string, childId: string, edges: CanvasEdge[]) {
  return edges.filter((e) => e.source === parentId && e.target === childId);
}

function resolveImageInput(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
): string | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) => (e.targetHandle ?? "").toLowerCase().includes("input") || (e.sourceHandle ?? "").toLowerCase().includes("image"),
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "cropImage") return out.output.url;
    if (out.kind === "requestInputs") {
      const handle = (edge.sourceHandle ?? "").toLowerCase();
      const v = out.output.fields[handle];
      if (typeof v === "object" && v && "url" in v) return (v as { url: string }).url;
      if (typeof v === "string") return v;
    }
  }
  return null;
}

function resolveAllImageInputs(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
): string[] {
  const urls: string[] = [];
  for (const pid of parentIds) {
    for (const edge of findEdgeFromParent(pid, childId, edges)) {
      const targetHandle = (edge.targetHandle ?? "").toLowerCase();
      if (!targetHandle.includes("vision") && !targetHandle.includes("image")) continue;
      const out = parentByEdge[pid];
      if (!out) continue;
      if (out.kind === "cropImage") urls.push(out.output.url);
      else if (out.kind === "requestInputs") {
        const sourceHandle = (edge.sourceHandle ?? "").toLowerCase();
        const v = out.output.fields[sourceHandle];
        if (typeof v === "object" && v && "url" in v) urls.push((v as { url: string }).url);
        else if (typeof v === "string" && v.startsWith("http")) urls.push(v);
      }
    }
  }
  return urls;
}

function resolveNumberInput(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
  targetHandleExact: string,
): number | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) => (e.targetHandle ?? "").toLowerCase() === targetHandleExact.toLowerCase(),
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "requestInputs") {
      const sourceHandle = (edge.sourceHandle ?? "").toLowerCase();
      const v = out.output.fields[sourceHandle];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    }
  }
  return null;
}

function resolveTextInput(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
  targetHandleHint: string,
): string | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) => (e.targetHandle ?? "").toLowerCase().includes(targetHandleHint),
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "gemini") return out.output.text;
    // Crop output is an image URL — exposed as text so it can flow into the
    // Response node alongside Gemini text.
    if (out.kind === "cropImage") return out.output.url;
    if (out.kind === "requestInputs") {
      const sourceHandle = (edge.sourceHandle ?? "").toLowerCase();
      const v = out.output.fields[sourceHandle];
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
    }
    if (out.kind === "response") return out.output.result;
  }
  return null;
}

// Re-export so the trigger compiler picks up all tasks via this entry.
export { cropImageTask, geminiTask, requestInputsTask, responseTask };
