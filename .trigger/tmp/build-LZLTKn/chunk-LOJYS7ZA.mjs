import {
  prisma
} from "./chunk-PDXQY6SN.mjs";
import {
  __name,
  init_esm
} from "./chunk-FUV6SSYK.mjs";

// src/trigger/dagDispatch.ts
init_esm();

// src/lib/dag.ts
init_esm();
function buildAdjacency(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]));
  const inn = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    out.get(e.source)?.push(e.target);
    inn.get(e.target)?.push(e.source);
  }
  return { out, inn };
}
__name(buildAdjacency, "buildAdjacency");
function topoSort(nodes, edges) {
  const { out, inn } = buildAdjacency(nodes, edges);
  const indeg = /* @__PURE__ */ new Map();
  for (const n of nodes) indeg.set(n.id, inn.get(n.id)?.length ?? 0);
  const queue = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of out.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return order.length === nodes.length ? order : null;
}
__name(topoSort, "topoSort");
function hasCycle(nodes, edges) {
  return topoSort(nodes, edges) === null;
}
__name(hasCycle, "hasCycle");
function upstreamClosure(nodes, edges, targetIds) {
  const { inn } = buildAdjacency(nodes, edges);
  const visited = new Set(targetIds);
  const stack = [...targetIds];
  while (stack.length) {
    const id = stack.pop();
    for (const parent of inn.get(id) ?? []) {
      if (!visited.has(parent)) {
        visited.add(parent);
        stack.push(parent);
      }
    }
  }
  return visited;
}
__name(upstreamClosure, "upstreamClosure");

// src/trigger/dagDispatch.ts
async function loadGraph(workflowId) {
  const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
  if (!workflow) throw new Error(`workflow ${workflowId} not found`);
  const nodes = workflow.nodes;
  const edges = workflow.edges;
  const { inn, out } = buildAdjacency(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { nodes, edges, inn, out, byId };
}
__name(loadGraph, "loadGraph");
async function tryClaimNodeRun(nodeRunId) {
  const claim = await prisma.nodeRun.updateMany({
    where: { id: nodeRunId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: /* @__PURE__ */ new Date() }
  });
  return claim.count === 1;
}
__name(tryClaimNodeRun, "tryClaimNodeRun");
async function loadNodeRunIndex(workflowRunId) {
  const rows = await prisma.nodeRun.findMany({
    where: { workflowRunId },
    select: { id: true, nodeId: true, status: true }
  });
  const m = /* @__PURE__ */ new Map();
  for (const r of rows) m.set(r.nodeId, { id: r.id, status: r.status });
  return m;
}
__name(loadNodeRunIndex, "loadNodeRunIndex");
async function loadParentNodeRuns(workflowRunId, parentNodeIds) {
  if (parentNodeIds.length === 0) return /* @__PURE__ */ new Map();
  const rows = await prisma.nodeRun.findMany({
    where: { workflowRunId, nodeId: { in: parentNodeIds } },
    select: { nodeId: true, status: true, nodeType: true, output: true, error: true }
  });
  const m = /* @__PURE__ */ new Map();
  for (const r of rows) {
    m.set(r.nodeId, {
      status: r.status,
      nodeType: r.nodeType,
      output: r.output,
      error: r.error
    });
  }
  return m;
}
__name(loadParentNodeRuns, "loadParentNodeRuns");
async function dispatchReadyChildren(args) {
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
        nodeId: childId
      },
      buildOptions(childRun.id, childId)
    );
  }
}
__name(dispatchReadyChildren, "dispatchReadyChildren");
async function cancelDescendants(args) {
  const { workflowRunId, failedNodeId, graph, nodeRunIndex, reason } = args;
  const queue = [...graph.out.get(failedNodeId) ?? []];
  const visited = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const childRun = nodeRunIndex.get(id);
    if (!childRun) continue;
    await prisma.nodeRun.updateMany({
      where: { id: childRun.id, status: "QUEUED", workflowRunId },
      data: {
        status: "CANCELLED",
        finishedAt: /* @__PURE__ */ new Date(),
        error: `skipped: upstream node ${failedNodeId} ${reason}`
      }
    });
    nodeRunIndex.set(id, { ...childRun, status: "CANCELLED" });
    for (const grandchild of graph.out.get(id) ?? []) queue.push(grandchild);
  }
}
__name(cancelDescendants, "cancelDescendants");
function nodeRunRowToOutput(row) {
  if (row.output === null || row.output === void 0) return null;
  const out = row.output;
  if (row.nodeType === "cropImage") {
    if (typeof out.url === "string") return { kind: "cropImage", output: { url: out.url } };
    return null;
  }
  if (row.nodeType === "gemini") {
    if (typeof out.text === "string") return { kind: "gemini", output: { text: out.text } };
    return null;
  }
  if (row.nodeType === "requestInputs" || row.nodeType === "input") {
    const fields = out.fields ?? {};
    return { kind: "requestInputs", output: { fields } };
  }
  if (row.nodeType === "response") {
    return {
      kind: "response",
      output: {
        result: typeof out.result === "string" ? out.result : null,
        perEdge: out.perEdge ?? void 0
      }
    };
  }
  return null;
}
__name(nodeRunRowToOutput, "nodeRunRowToOutput");
async function buildParentByEdge(workflowRunId, nodeId, graph) {
  const parentIds = (graph.inn.get(nodeId) ?? []).filter((id) => graph.byId.has(id));
  if (parentIds.length === 0) return { ok: true, map: {} };
  const rows = await loadParentNodeRuns(workflowRunId, parentIds);
  const map = {};
  for (const pid of parentIds) {
    const row = rows.get(pid);
    if (!row) return { ok: false, err: `parent ${pid} has no NodeRun row` };
    if (row.status !== "SUCCESS") {
      return { ok: false, err: `parent ${pid} is ${row.status}, expected SUCCESS` };
    }
    const out = nodeRunRowToOutput(row);
    if (!out) return { ok: false, err: `parent ${pid} has no parsable output (nodeType=${row.nodeType})` };
    map[pid] = out;
  }
  return { ok: true, map };
}
__name(buildParentByEdge, "buildParentByEdge");
async function markNodeRunFailed(nodeRunId, error) {
  await prisma.nodeRun.update({
    where: { id: nodeRunId },
    data: {
      status: "FAILED",
      finishedAt: /* @__PURE__ */ new Date(),
      error
    }
  });
}
__name(markNodeRunFailed, "markNodeRunFailed");
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["SUCCESS", "FAILED", "CANCELLED"]);
async function tryFinaliseWorkflowRun(workflowRunId) {
  const rows = await prisma.nodeRun.findMany({
    where: { workflowRunId },
    select: { status: true, error: true }
  });
  if (rows.length === 0) return false;
  if (!rows.every((r) => TERMINAL_STATUSES.has(r.status))) return false;
  const failedOrCancelled = rows.filter(
    (r) => r.status === "FAILED" || r.status === "CANCELLED"
  ).length;
  const succeeded = rows.filter((r) => r.status === "SUCCESS").length;
  let finalStatus;
  if (failedOrCancelled === 0) finalStatus = "SUCCESS";
  else if (succeeded === 0) finalStatus = "FAILED";
  else finalStatus = "PARTIAL";
  const firstError = rows.find((r) => r.error)?.error ?? null;
  const claim = await prisma.workflowRun.updateMany({
    where: { id: workflowRunId, status: "RUNNING" },
    data: {
      status: finalStatus,
      finishedAt: /* @__PURE__ */ new Date(),
      error: firstError
    }
  });
  return claim.count === 1;
}
__name(tryFinaliseWorkflowRun, "tryFinaliseWorkflowRun");

export {
  hasCycle,
  upstreamClosure,
  loadGraph,
  tryClaimNodeRun,
  loadNodeRunIndex,
  loadParentNodeRuns,
  dispatchReadyChildren,
  cancelDescendants,
  nodeRunRowToOutput,
  buildParentByEdge,
  markNodeRunFailed,
  tryFinaliseWorkflowRun
};
//# sourceMappingURL=chunk-LOJYS7ZA.mjs.map
