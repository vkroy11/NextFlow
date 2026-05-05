import { logger, metadata, task, wait } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";
import { hasCycle, upstreamClosure } from "@/lib/dag";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import { buildChildTriggerOptions, nodeRunnerTask, type NodeRunnerPayload } from "./nodeRunner";
import { loadGraph, tryClaimNodeRun } from "./dagDispatch";

type Scope = "FULL" | "SINGLE" | "MULTI";

export type RunWorkflowPayload = {
  workflowRunId: string;
  workflowId: string;
  scope: Scope;
  targetNodeIds?: string[];
};

/**
 * Workflow orchestrator (recursive-dispatch model).
 *
 * Previous shape: this task walked the DAG one topological level at a time,
 * collapsing every executable node at a level into a single
 * `nodeRunnerTask.batchTriggerAndWait(...)`. That gave T = 0 fan-out *within*
 * a level but made the batch atomic at the level boundary — LLM2 (Level 2,
 * depends only on LLM1) had to wait for crops at Level 1 to finish even
 * though they're not its parents.
 *
 * New shape: setup + poll. The orchestrator pre-creates a NodeRun row for
 * every executable node in QUEUED status, then triggers only the root
 * nodes via fire-and-forget `nodeRunnerTask.trigger(...)`. From there each
 * `nodeRunnerTask` invocation cascades to its children directly when their
 * other parents are SUCCESS — see `dagDispatch.ts`. The orchestrator just
 * polls `WorkflowRun.nodeRuns` until everything is terminal, then writes
 * the final WorkflowRun.status.
 *
 * Trigger.dev v4 parallel-waits-rule compliance: the orchestrator's only
 * suspension primitive is `wait.for({ seconds: ... })` in a sequential
 * loop. `nodeRunnerTask.trigger(...)` is fire-and-forget, never awaited.
 * Children-fan-out happens inside the dispatcher task, not in this loop.
 */
export const runWorkflowTask = task({
  id: "run-workflow",
  // Cap matches the worst-case smoke-test scenario (~60 s for the sample
  // workflow). Bump if a future graph is genuinely longer; remember the
  // poll loop counter below assumes this number.
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
    // workers progress).
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
      // Nothing to run — finalize as SUCCESS so the UI doesn't hang.
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: "SUCCESS", finishedAt: new Date() },
      });
      return { status: "SUCCESS" as const };
    }

    // Roots: executable nodes whose parents are all *not* in the
    // executable set. Triggered with fire-and-forget `.trigger()` after a
    // CAS claim — no parallel-waits issue because we never await them.
    const rootIds: string[] = [];
    for (const node of nodes) {
      if (!executable.has(node.id)) continue;
      const parents = (graph.inn.get(node.id) ?? []).filter((p) => executable.has(p));
      if (parents.length === 0) rootIds.push(node.id);
    }

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
      // subscribes via `wfrun:<id>`; idempotency-key shape is
      // `wfrun-<id>-node-<nodeId>` and dedups any redundant scheduling.
      await nodeRunnerTask.trigger(
        triggerPayload,
        buildChildTriggerOptions({ workflowId, workflowRunId, nodeRunId, nodeId }),
      );
    }

    // Surface a workflow-shape sidecar in the orchestrator's metadata —
    // visible on the Trigger.dev dashboard run detail page. NOT used as
    // primary state (that lives in `NodeRun` rows); just an at-a-glance
    // for triage.
    metadata.set("totalNodes", nodeRunIds.size);
    metadata.set("rootCount", rootIds.length);
    metadata.set("workflowRunId", workflowRunId);
    logger.info("orchestrator setup complete", {
      workflowRunId,
      totalNodes: nodeRunIds.size,
      rootCount: rootIds.length,
    });

    // ----------------------------------------------------------------
    // Poll loop.
    // ----------------------------------------------------------------
    // We wait sequentially with `wait.for` — never with Promise.all — so
    // there's only ever one pending suspension. Trigger v4 parallel-waits
    // rule satisfied trivially.
    //
    // Cadence: 3 s polls. Short enough to keep the run history sidebar
    // feeling live; long enough not to thrash Postgres.
    //
    // Timeout: maxDuration on the task is the hard ceiling. The loop
    // counter is just defence-in-depth so a runaway dispatcher can't
    // pin the orchestrator forever.
    const POLL_SECONDS = 3;
    const MAX_POLL_ITERATIONS = Math.ceil(600 / POLL_SECONDS);
    const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

    let iter = 0;
    while (iter++ < MAX_POLL_ITERATIONS) {
      await wait.for({ seconds: POLL_SECONDS });
      const rows = await prisma.nodeRun.findMany({
        where: { workflowRunId },
        select: { status: true },
      });
      if (rows.length === 0) break;
      const terminalCount = rows.filter((r) => TERMINAL_STATUSES.has(r.status)).length;
      // Light progress beacon for Trigger.dev dashboard observers — cheap
      // (one metadata.set per 3 s) and mirrors what the History sidebar
      // shows in real time over the Realtime subscription.
      metadata.set("progress", `${terminalCount}/${rows.length}`);
      if (terminalCount === rows.length) break;
    }

    // If we exited the loop because of the iteration cap (not all
    // terminal), forcibly cancel any non-terminal rows so the run can be
    // finalized cleanly. This is the watchdog path — a node-runner
    // crashing without setting its row to FAILED would otherwise leave
    // the run stuck in RUNNING forever.
    await prisma.nodeRun.updateMany({
      where: {
        workflowRunId,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        error: "workflow timed out before this node finished",
      },
    });

    // Finalize WorkflowRun.status by aggregating NodeRun outcomes.
    const finalRows = await prisma.nodeRun.findMany({
      where: { workflowRunId },
      select: { status: true, error: true },
    });
    const succeeded = finalRows.filter((r) => r.status === "SUCCESS").length;
    const failedOrCancelled = finalRows.filter(
      (r) => r.status === "FAILED" || r.status === "CANCELLED",
    ).length;

    let finalStatus: "SUCCESS" | "FAILED" | "PARTIAL";
    if (failedOrCancelled === 0) finalStatus = "SUCCESS";
    else if (succeeded === 0) finalStatus = "FAILED";
    else finalStatus = "PARTIAL";

    const firstError = finalRows.find((r) => r.error)?.error ?? null;
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
        error: firstError,
      },
    });
    metadata.set("finalStatus", finalStatus);
    logger.info("orchestrator finished", {
      workflowRunId,
      finalStatus,
      succeeded,
      failedOrCancelled,
    });
    return { status: finalStatus };
  },
});

// Re-export so the trigger compiler picks up all tasks via this entry.
// The deployable surface is `run-workflow` (orchestrator) +
// `node-runner` (universal dispatcher); cropImage / gemini / inlineNodes
// are plain async worker functions invoked from the dispatcher.
export { nodeRunnerTask };
