import { prisma } from "@/lib/prisma";
import { buildAdjacency } from "@/lib/dag";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import type { Prisma } from "@prisma/client";

/**
 * Recursive DAG dispatch helpers.
 *
 * Why this file exists: the orchestrator used to walk the DAG one level at a
 * time with `batchTriggerAndWait`. That made cross-type fan-out at T = 0
 * possible, but the batch is *atomic at the level boundary* — LLM2 (Level 2,
 * depends only on LLM1) had to wait for crops at Level 1 to finish even
 * though they're not its parents.
 *
 * The new model: the orchestrator pre-creates a NodeRun row per executable
 * node in QUEUED status, fires only the root nodes via fire-and-forget
 * `nodeRunnerTask.trigger(...)`, then polls `WorkflowRun.nodeRuns` until
 * everything is terminal. Each `nodeRunnerTask` invocation, after its worker
 * succeeds, calls `dispatchReadyChildren` — which atomically claims and
 * triggers each child whose other parents are already SUCCESS. LLM1
 * finishing thus triggers LLM2 at ~8 s, independent of crops.
 *
 * Race-safety: two parents finishing nearly simultaneously could both decide
 * "all of child's parents are done" and try to fire the child. To prevent
 * double-trigger we use Postgres-level CAS via Prisma's `updateMany` with a
 * status filter — only the first parent's update transitions the row from
 * QUEUED → RUNNING and gets `count: 1`; the loser sees `count: 0` and
 * skips.
 */

export type GraphSnapshot = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  inn: Map<string, string[]>;
  out: Map<string, string[]>;
  byId: Map<string, CanvasNode>;
};

export async function loadGraph(workflowId: string): Promise<GraphSnapshot> {
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) throw new Error(`workflow ${workflowId} not found`);
  const nodes = workflow.nodes as unknown as CanvasNode[];
  const edges = workflow.edges as unknown as CanvasEdge[];
  const { inn, out } = buildAdjacency(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  return { nodes, edges, inn, out, byId };
}

/**
 * Try to atomically transition a NodeRun from QUEUED to RUNNING. Returns
 * true iff this caller actually claimed it; false means another parent
 * beat us to it (race) or the row is already in a non-QUEUED state.
 */
export async function tryClaimNodeRun(nodeRunId: string): Promise<boolean> {
  const claim = await prisma.nodeRun.updateMany({
    where: { id: nodeRunId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  return claim.count === 1;
}

/**
 * For the workflow run, return a map from canvas nodeId → its NodeRun row id.
 * Built once per dispatcher invocation and used to look up children.
 */
export async function loadNodeRunIndex(
  workflowRunId: string,
): Promise<Map<string, { id: string; status: string }>> {
  const rows = await prisma.nodeRun.findMany({
    where: { workflowRunId },
    select: { id: true, nodeId: true, status: true },
  });
  const m = new Map<string, { id: string; status: string }>();
  for (const r of rows) m.set(r.nodeId, { id: r.id, status: r.status });
  return m;
}

/**
 * Fetch the NodeRun rows for `parentNodeIds` and return them keyed by
 * canvas node id. Used by `nodeRunnerTask` to materialise parent outputs
 * before invoking the worker for the current node.
 */
export async function loadParentNodeRuns(
  workflowRunId: string,
  parentNodeIds: string[],
): Promise<Map<string, { status: string; nodeType: string; output: unknown; error: string | null }>> {
  if (parentNodeIds.length === 0) return new Map();
  const rows = await prisma.nodeRun.findMany({
    where: { workflowRunId, nodeId: { in: parentNodeIds } },
    select: { nodeId: true, status: true, nodeType: true, output: true, error: true },
  });
  const m = new Map<string, { status: string; nodeType: string; output: unknown; error: string | null }>();
  for (const r of rows) {
    m.set(r.nodeId, {
      status: r.status,
      nodeType: r.nodeType,
      output: r.output,
      error: r.error,
    });
  }
  return m;
}

/**
 * Options forwarded to each child trigger call. The dispatcher in
 * `nodeRunnerTask` passes its own tags + idempotency-key shape through so
 * cascades inherit them — that's how the frontend can subscribe to all
 * runs tagged `wfrun:<id>` and how Trigger.dev dedups a child trigger if
 * a future code path bypasses our Postgres CAS.
 */
export type ChildTriggerOptions = {
  tags?: string[];
  idempotencyKey?: string;
  idempotencyKeyTTL?: string;
};

/**
 * Called by `nodeRunnerTask` after a worker completes successfully. For
 * each child of `completedNodeId`:
 *   1. Look up the child's other parents from the graph.
 *   2. Read their NodeRun statuses in one DB query.
 *   3. If every parent is SUCCESS, atomically claim the child (CAS) and
 *      fire `nodeRunnerTask.trigger(...)` (fire-and-forget — no wait).
 *
 * Triggering inside the dispatcher is the whole reason LLM2 can start at
 * t ≈ 8 s without the orchestrator being involved.
 *
 * The `buildOptions(childNodeRunId)` callback yields per-child trigger
 * options (tags + idempotencyKey) so the caller can include the child's
 * own NodeRun id in the tag set without dispatcher-side knowledge of how
 * tags are formatted.
 */
export async function dispatchReadyChildren(args: {
  workflowRunId: string;
  workflowId: string;
  completedNodeId: string;
  graph: GraphSnapshot;
  nodeRunIndex: Map<string, { id: string; status: string }>;
  trigger: (
    payload: { workflowRunId: string; workflowId: string; nodeRunId: string; nodeId: string },
    options: ChildTriggerOptions,
  ) => Promise<unknown>;
  buildOptions: (childNodeRunId: string, childNodeId: string) => ChildTriggerOptions;
}): Promise<void> {
  const { workflowRunId, workflowId, completedNodeId, graph, nodeRunIndex, trigger, buildOptions } = args;
  const childIds = (graph.out.get(completedNodeId) ?? []).filter((id) => nodeRunIndex.has(id));
  if (childIds.length === 0) return;

  for (const childId of childIds) {
    const childRun = nodeRunIndex.get(childId);
    if (!childRun) continue;
    if (childRun.status !== "QUEUED") continue;

    const parentIds = (graph.inn.get(childId) ?? []).filter((id) => nodeRunIndex.has(id));
    const parentRuns = await loadParentNodeRuns(workflowRunId, parentIds);

    let allSuccess = true;
    let anyFailed = false;
    for (const pid of parentIds) {
      const pr = parentRuns.get(pid);
      if (!pr) {
        allSuccess = false;
        break;
      }
      if (pr.status === "FAILED" || pr.status === "CANCELLED") {
        anyFailed = true;
        allSuccess = false;
        break;
      }
      if (pr.status !== "SUCCESS") {
        allSuccess = false;
        break;
      }
    }

    if (anyFailed) {
      // One of child's parents is already terminally failed — don't run
      // the child. Cascade-cancel from that path is handled by the parent
      // that failed (see `cancelDescendants`); here we just skip.
      continue;
    }
    if (!allSuccess) continue;

    const claimed = await tryClaimNodeRun(childRun.id);
    if (!claimed) continue;

    await trigger(
      {
        workflowRunId,
        workflowId,
        nodeRunId: childRun.id,
        nodeId: childId,
      },
      buildOptions(childRun.id, childId),
    );
  }
}

/**
 * Called by `nodeRunnerTask` when a worker throws. Marks every transitive
 * descendant of the failed node as CANCELLED with an error referencing the
 * upstream failure, so the orchestrator's poll loop can exit cleanly.
 *
 * Each cancellation is itself an atomic CAS so a descendant that already
 * RUNNING (claimed by another path) is left alone — only QUEUED rows are
 * cancelled.
 */
export async function cancelDescendants(args: {
  workflowRunId: string;
  failedNodeId: string;
  graph: GraphSnapshot;
  nodeRunIndex: Map<string, { id: string; status: string }>;
  reason: string;
}): Promise<void> {
  const { workflowRunId, failedNodeId, graph, nodeRunIndex, reason } = args;
  const queue: string[] = [...(graph.out.get(failedNodeId) ?? [])];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const childRun = nodeRunIndex.get(id);
    if (!childRun) continue;

    // Only cancel rows that are still in QUEUED. RUNNING rows are owned
    // by another worker invocation; SUCCESS/FAILED are already terminal.
    await prisma.nodeRun.updateMany({
      where: { id: childRun.id, status: "QUEUED", workflowRunId },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        error: `skipped: upstream node ${failedNodeId} ${reason}`,
      },
    });
    // Refresh local index so further dispatches at this level see the
    // cancellation immediately.
    nodeRunIndex.set(id, { ...childRun, status: "CANCELLED" });

    for (const grandchild of graph.out.get(id) ?? []) queue.push(grandchild);
  }
}

/**
 * Helper that converts a NodeRun.output JSON blob (whose schema depends on
 * the writing worker's `nodeType`) into the orchestrator's
 * `parentByEdge`-style discriminated NodeOutput. This is the one place the
 * historic NodeOutput shape is rebuilt from DB rows so the existing
 * resolver helpers (`resolveImageInput`, etc.) keep working unchanged.
 */
export type NodeOutput =
  | { kind: "requestInputs"; output: { fields: Record<string, unknown> } }
  | { kind: "cropImage"; output: { url: string } }
  | { kind: "gemini"; output: { text: string } }
  | { kind: "response"; output: { result: string | null; perEdge?: Record<string, string> } }
  | { kind: "generateImage"; output: { url: string } }
  | { kind: "generateVideo"; output: { url: string } }
  | { kind: "enhanceVideo"; output: { url: string } }
  | { kind: "extendVideo"; output: { url: string } };

export function nodeRunRowToOutput(row: {
  nodeType: string;
  output: unknown;
}): NodeOutput | null {
  if (row.output === null || row.output === undefined) return null;
  const out = row.output as Record<string, unknown>;
  if (row.nodeType === "cropImage") {
    if (typeof out.url === "string") return { kind: "cropImage", output: { url: out.url } };
    return null;
  }
  if (row.nodeType === "gemini") {
    if (typeof out.text === "string") return { kind: "gemini", output: { text: out.text } };
    return null;
  }
  if (row.nodeType === "requestInputs" || row.nodeType === "input") {
    const fields = (out.fields ?? {}) as Record<string, unknown>;
    return { kind: "requestInputs", output: { fields } };
  }
  if (row.nodeType === "response") {
    return {
      kind: "response",
      output: {
        result: typeof out.result === "string" ? out.result : null,
        perEdge: (out.perEdge ?? undefined) as Record<string, string> | undefined,
      },
    };
  }
  if (row.nodeType === "generateImage") {
    if (typeof out.url === "string") return { kind: "generateImage", output: { url: out.url } };
    return null;
  }
  if (row.nodeType === "generateVideo") {
    if (typeof out.url === "string") return { kind: "generateVideo", output: { url: out.url } };
    return null;
  }
  if (row.nodeType === "enhanceVideo") {
    if (typeof out.url === "string") return { kind: "enhanceVideo", output: { url: out.url } };
    return null;
  }
  if (row.nodeType === "extendVideo") {
    if (typeof out.url === "string") return { kind: "extendVideo", output: { url: out.url } };
    return null;
  }
  return null;
}

/**
 * Build the `parentByEdge` map (canvas-parent-node-id → NodeOutput) for
 * the worker about to run for `nodeId`. Returns `null` if any parent
 * hasn't successfully produced output — caller should treat as a
 * dispatch error (typically means dispatch logic upstream missed a state
 * transition).
 */
export async function buildParentByEdge(
  workflowRunId: string,
  nodeId: string,
  graph: GraphSnapshot,
): Promise<{ ok: true; map: Record<string, NodeOutput> } | { ok: false; err: string }> {
  const parentIds = (graph.inn.get(nodeId) ?? []).filter((id) => graph.byId.has(id));
  if (parentIds.length === 0) return { ok: true, map: {} };
  const rows = await loadParentNodeRuns(workflowRunId, parentIds);
  const map: Record<string, NodeOutput> = {};
  for (const pid of parentIds) {
    const row = rows.get(pid);
    if (!row) return { ok: false, err: `parent ${pid} has no NodeRun row` };
    if (row.status !== "SUCCESS") {
      // Sticky notes are not executable but might appear as parents in the
      // raw graph; the orchestrator filters them out of the executable
      // set, so they should never reach here.
      return { ok: false, err: `parent ${pid} is ${row.status}, expected SUCCESS` };
    }
    const out = nodeRunRowToOutput(row);
    if (!out) return { ok: false, err: `parent ${pid} has no parsable output (nodeType=${row.nodeType})` };
    map[pid] = out;
  }
  return { ok: true, map };
}

/**
 * Convenience for marking a NodeRun as FAILED — used when the dispatcher
 * itself can't run a node (e.g., couldn't resolve parent inputs) so the
 * worker function never gets a chance to set the status.
 */
export async function markNodeRunFailed(nodeRunId: string, error: string): Promise<void> {
  await prisma.nodeRun.update({
    where: { id: nodeRunId },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      error,
    },
  });
}

const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/**
 * Atomically finalise the `WorkflowRun` row if (and only if) every
 * `NodeRun` for this run has reached a terminal status. Called by every
 * `nodeRunnerTask` invocation after its own status update — success
 * path, failure path, and the `onFailure` lifecycle hook — and by the
 * janitor scheduled task as a last-resort safety net.
 *
 * Replaces the orchestrator's old `wait.for(3s)` polling loop. The
 * orchestrator now returns immediately after firing roots; the *last*
 * NodeRun to reach a terminal state runs this helper and finalises the
 * run.
 *
 * Race-safety: aggregates first, then a single CAS-style `updateMany`
 * filtered by `status: "RUNNING"`. Multiple concurrent callers can all
 * pass the "is everything terminal?" check at the same instant; only
 * one wins the UPDATE (its `count` is `1`); the losers see `count: 0`
 * and exit silently. Idempotent — safe to call from anywhere.
 *
 * @returns `true` iff THIS caller wrote the final WorkflowRun status.
 */
export async function tryFinaliseWorkflowRun(workflowRunId: string): Promise<boolean> {
  const rows = await prisma.nodeRun.findMany({
    where: { workflowRunId },
    select: { status: true, error: true },
  });

  if (rows.length === 0) return false;
  if (!rows.every((r) => TERMINAL_STATUSES.has(r.status))) return false;

  const failedOrCancelled = rows.filter(
    (r) => r.status === "FAILED" || r.status === "CANCELLED",
  ).length;
  const succeeded = rows.filter((r) => r.status === "SUCCESS").length;

  let finalStatus: "SUCCESS" | "FAILED" | "PARTIAL";
  if (failedOrCancelled === 0) finalStatus = "SUCCESS";
  else if (succeeded === 0) finalStatus = "FAILED";
  else finalStatus = "PARTIAL";

  const firstError = rows.find((r) => r.error)?.error ?? null;

  const claim = await prisma.workflowRun.updateMany({
    where: { id: workflowRunId, status: "RUNNING" },
    data: {
      status: finalStatus,
      finishedAt: new Date(),
      error: firstError,
    },
  });

  return claim.count === 1;
}

export type JsonInput = Prisma.InputJsonValue;
