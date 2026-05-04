import { task } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import { runCropImage, type CropPayload } from "./cropImage";
import { runGemini, type GeminiPayload } from "./gemini";
import {
  runInput,
  runRequestInputs,
  runResponse,
  buildResponseInputs,
} from "./inlineNodes";
import {
  buildParentByEdge,
  cancelDescendants,
  dispatchReadyChildren,
  loadGraph,
  loadNodeRunIndex,
  markNodeRunFailed,
  type GraphSnapshot,
  type NodeOutput,
} from "./dagDispatch";

/**
 * Universal node dispatcher.
 *
 * Trigger.dev v4's parallel-waits rule (one suspension per task at a time)
 * forced the previous orchestrator into a level-walking
 * `batchTriggerAndWait` loop. That delivered T = 0 fan-out within a level
 * but couldn't fire LLM2 until both crops at the same level finished —
 * even though LLM2's only parent is LLM1.
 *
 * This task fixes that. The orchestrator pre-creates a NodeRun row per
 * executable node in QUEUED status, then triggers only the root nodes via
 * fire-and-forget `nodeRunnerTask.trigger(...)`. Each invocation:
 *
 *   1. Looks up the canvas node + the workflow graph.
 *   2. Resolves its inputs from parent NodeRun rows in the database
 *      (since the orchestrator no longer holds them in memory).
 *   3. Runs the matching worker: `runCropImage` / `runGemini` (real work)
 *      or `runRequestInputs` / `runInput` / `runResponse` (formerly
 *      orchestrator-inline).
 *   4. On SUCCESS — for each child, checks whether all of *that* child's
 *      parents are now SUCCESS, atomically claims it (CAS QUEUED →
 *      RUNNING), and triggers a fresh `nodeRunnerTask` for it.
 *   5. On FAILURE — cascades CANCELLED to all transitive descendants so
 *      the orchestrator's poll loop can finalize cleanly.
 *
 * `.trigger(...)` (no -AndWait suffix) is fire-and-forget — it doesn't
 * count toward the parallel-waits rule. The dispatcher doesn't wait for
 * anything; the orchestrator polls.
 *
 * Why this is the right shape: the only correctness risk is two parents
 * both deciding "all of child's parents are SUCCESS" and trying to fire
 * the child concurrently. `tryClaimNodeRun` in `dagDispatch.ts` defends
 * against that with a Postgres-level CAS — the loser sees `count: 0` and
 * skips.
 *
 * The History sidebar is unaffected: every NodeRun row is written by a
 * named worker (`nodeType: "cropImage" | "gemini" | "requestInputs" |
 * "input" | "response"`), never by `node-runner` itself. Trigger.dev's
 * cloud dashboard still shows one `node-runner` run per node for
 * debugging, but those entries never reach our database.
 */

export type NodeRunnerPayload = {
  workflowRunId: string;
  workflowId: string;
  nodeRunId: string;
  nodeId: string;
};

export const nodeRunnerTask = task({
  id: "node-runner",
  retry: { maxAttempts: 1 },
  // Cap covers Crop's mandatory 30 s delay + Transloadit round-trip and
  // the longest Gemini calls. Bump if a future worker needs more.
  maxDuration: 90,
  run: async (payload: NodeRunnerPayload): Promise<void> => {
    const { workflowRunId, workflowId, nodeRunId, nodeId } = payload;

    const graph = await loadGraph(workflowId);
    const node = graph.byId.get(nodeId);
    if (!node) {
      await markNodeRunFailed(nodeRunId, `node ${nodeId} not found in workflow ${workflowId}`);
      return;
    }

    const nodeRunIndex = await loadNodeRunIndex(workflowRunId);

    // Resolve inputs from the parents' NodeRun rows.
    const parents = await buildParentByEdge(workflowRunId, nodeId, graph);
    if (!parents.ok) {
      await markNodeRunFailed(nodeRunId, parents.err);
      await cancelDescendants({
        workflowRunId,
        failedNodeId: nodeId,
        graph,
        nodeRunIndex,
        reason: "failed",
      });
      return;
    }

    try {
      await executeWorker({
        node,
        edges: graph.edges,
        nodeRunId,
        workflowRunId,
        parentByEdge: parents.map,
        graph,
      });

      // Refresh the index so we see this node's own SUCCESS row when
      // checking children's parent statuses.
      const refreshedIndex = await loadNodeRunIndex(workflowRunId);
      await dispatchReadyChildren({
        workflowRunId,
        workflowId,
        completedNodeId: nodeId,
        graph,
        nodeRunIndex: refreshedIndex,
        trigger: (childPayload) =>
          nodeRunnerTask.trigger(childPayload satisfies NodeRunnerPayload),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Worker functions already mark their own NodeRun row FAILED. The
      // orchestrator's poll loop will see the failure; we just need to
      // clean up downstream rows so it doesn't wait forever.
      const refreshedIndex = await loadNodeRunIndex(workflowRunId);
      await cancelDescendants({
        workflowRunId,
        failedNodeId: nodeId,
        graph,
        nodeRunIndex: refreshedIndex,
        reason: `failed: ${message}`,
      });
    }
  },
});

async function executeWorker(args: {
  node: CanvasNode;
  edges: CanvasEdge[];
  nodeRunId: string;
  workflowRunId: string;
  parentByEdge: Record<string, NodeOutput>;
  graph: GraphSnapshot;
}): Promise<void> {
  const { node, edges, nodeRunId, workflowRunId, parentByEdge, graph } = args;
  const nodeId = node.id;
  const parentIds = graph.inn.get(nodeId) ?? [];

  switch (node.type) {
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
      if (!inputUrl) {
        // Mark the row failed in-place so the cascade in nodeRunnerTask
        // sees a definitive FAILED state.
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `crop ${nodeId}: no input image (connect upstream or upload locally)`,
          },
        });
        throw new Error(`crop ${nodeId}: no input image`);
      }
      const cropPayload: CropPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        inputUrl,
        x: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "x") ?? data.x ?? 0,
        y: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "y") ?? data.y ?? 0,
        w: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "w") ?? data.w ?? 100,
        h: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "h") ?? data.h ?? 100,
      };
      await runCropImage(cropPayload);
      return;
    }

    case "gemini": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        systemPrompt?: string;
        temperature?: number;
      };
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const systemOverride = resolveTextInput(
        parentIds,
        parentByEdge,
        edges,
        nodeId,
        "system_prompt",
      );
      const imageUrls = resolveAllImageInputs(parentIds, parentByEdge, edges, nodeId);
      const geminiPayload: GeminiPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        model: data.model ?? "gemini-2.5-pro",
        prompt: promptOverride ?? data.prompt ?? "",
        systemPrompt: systemOverride ?? data.systemPrompt,
        temperature: data.temperature,
        imageUrls,
      };
      await runGemini(geminiPayload);
      return;
    }

    case "requestInputs": {
      const data = node.data as
        | { fields?: Array<{ key: string; value: unknown }> }
        | undefined;
      const fields: Record<string, unknown> = {};
      for (const f of data?.fields ?? []) fields[f.key] = f.value;
      await runRequestInputs({ workflowRunId, nodeRunId, nodeId, fields });
      return;
    }

    case "input": {
      const data = node.data as
        | { fieldType?: string; value?: unknown }
        | undefined;
      await runInput({
        workflowRunId,
        nodeRunId,
        nodeId,
        fieldType: data?.fieldType,
        value: data?.value,
      });
      return;
    }

    case "response": {
      const { primary, perEdge } = buildResponseInputs(node, edges, parentByEdge);
      await runResponse({ workflowRunId, nodeRunId, nodeId, primary, perEdge });
      return;
    }

    case "stickyNote": {
      // Sticky notes shouldn't reach here — orchestrator filters them out
      // of the executable set. Defensive no-op so a stray sticky doesn't
      // halt a run.
      await prisma.nodeRun.update({
        where: { id: nodeRunId },
        data: {
          status: "SUCCESS",
          finishedAt: new Date(),
          output: { skipped: true } as never,
        },
      });
      return;
    }

    default: {
      throw new Error(`unsupported node type at runtime: ${String(node.type)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resolver helpers (mirrors the orchestrator's old in-process versions; the
// only change is they read the parent NodeOutput map rebuilt from
// `NodeRun.output` rows by `dagDispatch.buildParentByEdge`).
// ---------------------------------------------------------------------------

function findEdgeFromParent(
  parentId: string,
  childId: string,
  edges: CanvasEdge[],
): CanvasEdge[] {
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
      (e) =>
        (e.targetHandle ?? "").toLowerCase().includes("input") ||
        (e.sourceHandle ?? "").toLowerCase().includes("image"),
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
    // Crop output is an image URL — exposed as text so it can flow into
    // the Response node alongside Gemini text.
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
