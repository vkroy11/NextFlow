import { logger, metadata, task } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";
import { hasCycle, upstreamClosure } from "@/lib/dag";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import { buildChildTriggerOptions, nodeRunnerTask, type NodeRunnerPayload } from "./nodeRunner";
import { loadGraph, tryClaimNodeRun, tryFinaliseWorkflowRun } from "./dagDispatch";
import { workflowJanitorTask } from "./janitor";

type Scope = "FULL" | "SINGLE" | "MULTI";

export type RunWorkflowPayload = {
  workflowRunId: string;
  workflowId: string;
  scope: Scope;
  targetNodeIds?: string[];
};

/**
 * Workflow orchestrator (setup-only — last-leaf finalisation model).
 *
 * Iteration history (long-form: `docs/dag-concurrency.md`):
 *   v1–v4  Promise.all / IIFE / strict-sequential / per-type batches —
 *          all crashed in prod with `Parallel waits are not supported`
 *          or lost concurrency.
 *   v5     Mixed-type `batchTriggerAndWait` via dispatcher — atomic at
 *          the level boundary; gemini-2 had to wait for unrelated
 *          crops at the same level.
 *   v6     Recursive dispatch + 3 s `wait.for` polling for terminal
 *          detection. Cross-type T=0 fan-out, gemini-2 unblocked
 *          immediately, but orchestrator stayed alive polling DB.
 *   v7     Trigger best-practice hardening (tags, idempotency keys,
 *          retries, queue, onFailure, Realtime).
 *   v8     **Current**: orchestrator drops the poll loop entirely. The
 *          *last* node-runner to reach a terminal status calls
 *          `tryFinaliseWorkflowRun` (CAS on `WorkflowRun.status` =
 *          RUNNING) and writes the final aggregated status. The
 *          orchestrator returns immediately after firing roots.
 *
 * Why drop the poll: the frontend already gets sub-second updates via
 * Realtime SSE (`useRealtimeRunsWithTag`); the orchestrator's poll
 * existed only to detect "everything terminal" so it could write
 * `WorkflowRun.status`. That detection is naturally available at the
 * last node-runner that flips the final row to terminal — let it do
 * the finalise via Postgres CAS instead. Eliminates ~20 indexed queries
 * per 60 s workflow plus the orchestrator's continuous worker
 * occupation. See FAQ Q1 in `docs/dag-concurrency.md` for the trade-off
 * analysis.
 *
 * Watchdog: replaced by `workflowJanitorTask` (in `janitor.ts`) — a
 * scheduled task that scans for `WorkflowRun`s stuck in RUNNING longer
 * than 10 minutes and force-finalises them. Catches the rare case
 * where a worker crashes in a way that bypasses both its own try/catch
 * AND the `onFailure` hook.
 *
 * Trigger.dev v4 parallel-waits-rule compliance: still satisfied
 * trivially — the orchestrator never awaits anything that suspends
 * (`tasks.trigger` is fire-and-forget, no `wait.for` anywhere).
 */
export const runWorkflowTask = task({
  id: "run-workflow",
  // Setup-only — this task does no waiting. 60 s is comfortable for
  // pre-creating NodeRun rows + firing roots even on a 100-node graph.
  maxDuration: 60,
  // Crash-recovery: if setup throws (e.g., Postgres connection drops
  // mid-loop), make sure the WorkflowRun and its NodeRun rows reach a
  // terminal state instead of staying RUNNING forever. The janitor
  // would catch this eventually, but the hook makes recovery
  // sub-second.
  onFailure: async ({ payload, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("orchestrator final failure", {
      workflowRunId: payload.workflowRunId,
      message,
    });
    await prisma.nodeRun.updateMany({
      where: {
        workflowRunId: payload.workflowRunId,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        error: `orchestrator crashed: ${message}`,
      },
    });
    await tryFinaliseWorkflowRun(payload.workflowRunId);
  },
  run: async (payload: RunWorkflowPayload) => {
    const { workflowRunId, workflowId, scope, targetNodeIds } = payload;
    logger.info("orchestrator setup begin", { workflowRunId, workflowId, scope });

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

    // SINGLE/MULTI scope: still need upstream closure so target nodes have
    // valid inputs. Sticky notes are visual-only and never execute.
    const executable = new Set<string>(
      nodes.filter((n) => n.type !== "stickyNote").map((n) => n.id),
    );
    if (scope !== "FULL" && targetNodeIds && targetNodeIds.length > 0) {
      const closure = upstreamClosure(nodes, edges, targetNodeIds);
      executable.clear();
      for (const id of closure) {
        const n = nodes.find((x) => x.id === id);
        if (n?.type !== "stickyNote") executable.add(id);
      }
    }

    const graph = await loadGraph(workflowId);

    // Pre-create a NodeRun row per executable node in QUEUED status. This
    // gives every node a stable id we can CAS-claim later from a
    // dispatcher task, and makes the History sidebar show all upcoming
    // work immediately (rows transition QUEUED → RUNNING → SUCCESS as
    // workers progress over Realtime).
    const nodeRunIds = new Map<string, string>();
    for (const node of nodes) {
      if (!executable.has(node.id)) continue;
      const nr = await prisma.nodeRun.create({
        data: {
          workflowRunId,
          nodeId: node.id,
          nodeType: node.type ?? "unknown",
          status: "QUEUED",
        },
      });
      nodeRunIds.set(node.id, nr.id);
    }

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: "RUNNING" },
    });

    if (nodeRunIds.size === 0) {
      // Nothing to run — finalise as SUCCESS so the UI doesn't hang.
      // Done directly (not via tryFinaliseWorkflowRun) because there
      // are no NodeRun rows for that helper to inspect.
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: "SUCCESS", finishedAt: new Date() },
      });
      return { status: "SUCCESS" as const };
    }

    // Roots: executable nodes whose parents are all *not* in the
    // executable set. Triggered with fire-and-forget `.trigger()` after
    // a CAS claim — no parallel-waits issue because we never await them.
    const rootIds: string[] = [];
    for (const node of nodes) {
      if (!executable.has(node.id)) continue;
      const parents = (graph.inn.get(node.id) ?? []).filter((p) => executable.has(p));
      if (parents.length === 0) rootIds.push(node.id);
    }

    metadata.set("totalNodes", nodeRunIds.size);
    metadata.set("rootCount", rootIds.length);
    metadata.set("workflowRunId", workflowRunId);

    for (const nodeId of rootIds) {
      const nodeRunId = nodeRunIds.get(nodeId);
      if (!nodeRunId) continue;
      const claimed = await tryClaimNodeRun(nodeRunId);
      if (!claimed) continue;
      const triggerPayload: NodeRunnerPayload = {
        workflowRunId,
        workflowId,
        nodeRunId,
        nodeId,
      };
      // Tags + idempotency key are shared with the dispatcher's cascade
      // (see `buildChildTriggerOptions` in `nodeRunner.ts`) so root and
      // descendant triggers wear identical metadata. Frontend Realtime
      // subscribes via `wfrun:<id>`; the `nodeId:<canvasId>` and
      // `kind:<type>` tags let `RealtimeCoordinator` pick gemini
      // runs out of that subscription. Idempotency-key shape is
      // `wfrun-<id>-node-<nodeId>` and dedups any redundant scheduling.
      await nodeRunnerTask.trigger(
        triggerPayload,
        buildChildTriggerOptions({
          workflowId,
          workflowRunId,
          nodeRunId,
          nodeId,
          nodeType: graph.byId.get(nodeId)?.type ?? "unknown",
        }),
      );
    }

    logger.info("orchestrator setup complete — handing off to dispatcher cascade", {
      workflowRunId,
      totalNodes: nodeRunIds.size,
      rootCount: rootIds.length,
    });

    // Setup-only orchestrator: return immediately. The last node-runner
    // to reach terminal will call `tryFinaliseWorkflowRun` and write
    // the final WorkflowRun.status.
    return { status: "RUNNING" as const, totalNodes: nodeRunIds.size };
  },
});

// Re-export so the trigger compiler picks up all tasks via this entry.
// The deployable surface is `run-workflow` (orchestrator, setup-only) +
// `node-runner` (universal dispatcher) + `workflow-janitor` (scheduled
// safety net for stuck runs).
export { nodeRunnerTask, workflowJanitorTask };
