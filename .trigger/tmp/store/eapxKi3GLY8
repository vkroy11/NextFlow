import {
  buildChildTriggerOptions,
  nodeRunnerTask
} from "../../../../chunk-DZGAUTRX.mjs";
import "../../../../chunk-UPLB75XL.mjs";
import "../../../../chunk-5NMZVFTH.mjs";
import "../../../../chunk-YY3FSV7E.mjs";
import "../../../../chunk-AGWHRL4M.mjs";
import {
  workflowJanitorTask
} from "../../../../chunk-4HOWHU7B.mjs";
import {
  hasCycle,
  loadGraph,
  tryClaimNodeRun,
  tryFinaliseWorkflowRun,
  upstreamClosure
} from "../../../../chunk-LOJYS7ZA.mjs";
import {
  logger,
  metadata,
  task
} from "../../../../chunk-ZLZOJIGJ.mjs";
import "../../../../chunk-WZGQJWAS.mjs";
import {
  prisma
} from "../../../../chunk-PDXQY6SN.mjs";
import {
  __name,
  init_esm
} from "../../../../chunk-FUV6SSYK.mjs";

// src/trigger/runWorkflow.ts
init_esm();
var runWorkflowTask = task({
  id: "run-workflow",
  // Setup-only — this task does no waiting. 60 s is comfortable for
  // pre-creating NodeRun rows + firing roots even on a 100-node graph.
  maxDuration: 60,
  // Crash-recovery: if setup throws (e.g., Postgres connection drops
  // mid-loop), make sure the WorkflowRun and its NodeRun rows reach a
  // terminal state instead of staying RUNNING forever. The janitor
  // would catch this eventually, but the hook makes recovery
  // sub-second.
  onFailure: /* @__PURE__ */ __name(async ({ payload, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("orchestrator final failure", {
      workflowRunId: payload.workflowRunId,
      message
    });
    await prisma.nodeRun.updateMany({
      where: {
        workflowRunId: payload.workflowRunId,
        status: { in: ["QUEUED", "RUNNING"] }
      },
      data: {
        status: "CANCELLED",
        finishedAt: /* @__PURE__ */ new Date(),
        error: `orchestrator crashed: ${message}`
      }
    });
    await tryFinaliseWorkflowRun(payload.workflowRunId);
  }, "onFailure"),
  run: /* @__PURE__ */ __name(async (payload) => {
    const { workflowRunId, workflowId, scope, targetNodeIds } = payload;
    logger.info("orchestrator setup begin", { workflowRunId, workflowId, scope });
    const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new Error(`workflow ${workflowId} not found`);
    const nodes = workflow.nodes;
    const edges = workflow.edges;
    if (hasCycle(nodes, edges)) {
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: "FAILED", finishedAt: /* @__PURE__ */ new Date(), error: "Cycle detected in workflow" }
      });
      throw new Error("Cycle detected in workflow DAG");
    }
    const executable = new Set(
      nodes.filter((n) => n.type !== "stickyNote").map((n) => n.id)
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
    const nodeRunIds = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      if (!executable.has(node.id)) continue;
      const nr = await prisma.nodeRun.create({
        data: {
          workflowRunId,
          nodeId: node.id,
          nodeType: node.type ?? "unknown",
          status: "QUEUED"
        }
      });
      nodeRunIds.set(node.id, nr.id);
    }
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: "RUNNING" }
    });
    if (nodeRunIds.size === 0) {
      await prisma.workflowRun.update({
        where: { id: workflowRunId },
        data: { status: "SUCCESS", finishedAt: /* @__PURE__ */ new Date() }
      });
      return { status: "SUCCESS" };
    }
    const rootIds = [];
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
      const triggerPayload = {
        workflowRunId,
        workflowId,
        nodeRunId,
        nodeId
      };
      await nodeRunnerTask.trigger(
        triggerPayload,
        buildChildTriggerOptions({ workflowId, workflowRunId, nodeRunId, nodeId })
      );
    }
    logger.info("orchestrator setup complete — handing off to dispatcher cascade", {
      workflowRunId,
      totalNodes: nodeRunIds.size,
      rootCount: rootIds.length
    });
    return { status: "RUNNING", totalNodes: nodeRunIds.size };
  }, "run")
});
export {
  nodeRunnerTask,
  runWorkflowTask,
  workflowJanitorTask
};
//# sourceMappingURL=runWorkflow.mjs.map
