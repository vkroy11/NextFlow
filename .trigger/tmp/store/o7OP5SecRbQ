import {
  runCropImage
} from "./chunk-PQIIT7Z6.mjs";
import {
  buildParentByEdge,
  cancelDescendants,
  dispatchReadyChildren,
  loadGraph,
  loadNodeRunIndex,
  markNodeRunFailed
} from "./chunk-FKDBUPTC.mjs";
import {
  runGemini
} from "./chunk-ETWSGUYV.mjs";
import {
  logger,
  task
} from "./chunk-4JND62D4.mjs";
import {
  buildResponseInputs,
  runInput,
  runRequestInputs,
  runResponse
} from "./chunk-AGWHRL4M.mjs";
import {
  prisma
} from "./chunk-PDXQY6SN.mjs";
import {
  __name,
  init_esm
} from "./chunk-FUV6SSYK.mjs";

// src/trigger/nodeRunner.ts
init_esm();
function buildNodeRunnerTags(args) {
  return [
    `workflow:${args.workflowId}`,
    `wfrun:${args.workflowRunId}`,
    `node:${args.nodeRunId}`
  ];
}
__name(buildNodeRunnerTags, "buildNodeRunnerTags");
function buildNodeRunnerIdempotencyKey(args) {
  return `wfrun-${args.workflowRunId}-node-${args.nodeId}`;
}
__name(buildNodeRunnerIdempotencyKey, "buildNodeRunnerIdempotencyKey");
var NODE_RUNNER_IDEMPOTENCY_TTL = "1d";
var NODE_RUNNER_CONCURRENCY = parseInt(
  process.env.NODE_RUNNER_CONCURRENCY ?? (process.env.NODE_ENV === "development" ? "5" : "20"),
  10
);
var nodeRunnerTask = task({
  id: "node-runner",
  // Three retries with exponential jitter cover the realistic transient
  // failures (Postgres connection blip, Trigger API hiccup, Transloadit
  // 5xx). Permanent errors short-circuit via `AbortTaskRunError` thrown
  // from `rethrowClassified` in the worker functions, so we don't waste
  // retries on a bad API key or a malformed payload.
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1e3,
    maxTimeoutInMs: 3e4,
    randomize: true
  },
  // Single shared queue across all node types. Caps simultaneous external-
  // API calls (Transloadit + Gemini) regardless of how many nodes a
  // workflow fans out — important once a single workflow can spawn 30+
  // siblings via the recursive dispatcher. Limit is env-driven so prod
  // (20) and dev (5) don't share a quota.
  queue: {
    name: "node-execution",
    concurrencyLimit: NODE_RUNNER_CONCURRENCY
  },
  // Cap covers Crop's mandatory 30 s delay + Transloadit round-trip and
  // the longest Gemini calls. Bump if a future worker needs more.
  maxDuration: 90,
  // Final-attempt safety net. Worker try/catch handles in-band failures
  // (writes the row to FAILED before throwing), but OOM / host crash /
  // maxDuration timeout skip those — this hook ensures the row is
  // FAILED and descendants are CANCELLED so the orchestrator's 3 s poll
  // loop can finalise within ~5 s instead of hitting its 600 s timeout.
  // Hook fires only after the *final* retry attempt — correct semantics
  // for `retry.maxAttempts: 3`.
  onFailure: /* @__PURE__ */ __name(async ({ payload, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("node-runner final failure", {
      workflowRunId: payload.workflowRunId,
      nodeId: payload.nodeId,
      nodeRunId: payload.nodeRunId,
      message
    });
    await prisma.nodeRun.updateMany({
      where: {
        id: payload.nodeRunId,
        status: { in: ["QUEUED", "RUNNING"] }
      },
      data: {
        status: "FAILED",
        finishedAt: /* @__PURE__ */ new Date(),
        error: `task crashed: ${message}`
      }
    });
    try {
      const graph = await loadGraph(payload.workflowId);
      const idx = await loadNodeRunIndex(payload.workflowRunId);
      await cancelDescendants({
        workflowRunId: payload.workflowRunId,
        failedNodeId: payload.nodeId,
        graph,
        nodeRunIndex: idx,
        reason: "failed in onFailure hook"
      });
    } catch (cleanupErr) {
      logger.warn("onFailure cascade cleanup raised", {
        workflowRunId: payload.workflowRunId,
        message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      });
    }
  }, "onFailure"),
  run: /* @__PURE__ */ __name(async (payload) => {
    const { workflowRunId, workflowId, nodeRunId, nodeId } = payload;
    logger.info("node-runner start", { workflowRunId, nodeId, nodeRunId });
    const graph = await loadGraph(workflowId);
    const node = graph.byId.get(nodeId);
    if (!node) {
      await markNodeRunFailed(nodeRunId, `node ${nodeId} not found in workflow ${workflowId}`);
      return;
    }
    const nodeRunIndex = await loadNodeRunIndex(workflowRunId);
    const parents = await buildParentByEdge(workflowRunId, nodeId, graph);
    if (!parents.ok) {
      await markNodeRunFailed(nodeRunId, parents.err);
      await cancelDescendants({
        workflowRunId,
        failedNodeId: nodeId,
        graph,
        nodeRunIndex,
        reason: "failed"
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
        graph
      });
      const refreshedIndex = await loadNodeRunIndex(workflowRunId);
      await dispatchReadyChildren({
        workflowRunId,
        workflowId,
        completedNodeId: nodeId,
        graph,
        nodeRunIndex: refreshedIndex,
        trigger: /* @__PURE__ */ __name((childPayload, options) => nodeRunnerTask.trigger(childPayload, options), "trigger"),
        buildOptions: /* @__PURE__ */ __name((childNodeRunId, childNodeId) => buildChildTriggerOptions({
          workflowId,
          workflowRunId,
          nodeRunId: childNodeRunId,
          nodeId: childNodeId
        }), "buildOptions")
      });
      logger.info("node-runner success", { workflowRunId, nodeId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const refreshedIndex = await loadNodeRunIndex(workflowRunId);
      await cancelDescendants({
        workflowRunId,
        failedNodeId: nodeId,
        graph,
        nodeRunIndex: refreshedIndex,
        reason: `failed: ${message}`
      });
      throw err;
    }
  }, "run")
});
function buildChildTriggerOptions(args) {
  return {
    tags: buildNodeRunnerTags({
      workflowId: args.workflowId,
      workflowRunId: args.workflowRunId,
      nodeRunId: args.nodeRunId
    }),
    idempotencyKey: buildNodeRunnerIdempotencyKey({
      workflowRunId: args.workflowRunId,
      nodeId: args.nodeId
    }),
    idempotencyKeyTTL: NODE_RUNNER_IDEMPOTENCY_TTL
  };
}
__name(buildChildTriggerOptions, "buildChildTriggerOptions");
async function executeWorker(args) {
  const { node, edges, nodeRunId, workflowRunId, parentByEdge, graph } = args;
  const nodeId = node.id;
  const parentIds = graph.inn.get(nodeId) ?? [];
  switch (node.type) {
    case "cropImage": {
      const data = node.data ?? {};
      const inputUrl = resolveImageInput(parentIds, parentByEdge, edges, nodeId) ?? data.inputUrl ?? null;
      if (!inputUrl) {
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: /* @__PURE__ */ new Date(),
            error: `crop ${nodeId}: no input image (connect upstream or upload locally)`
          }
        });
        throw new Error(`crop ${nodeId}: no input image`);
      }
      const cropPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        inputUrl,
        x: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "x") ?? data.x ?? 0,
        y: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "y") ?? data.y ?? 0,
        w: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "w") ?? data.w ?? 100,
        h: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "h") ?? data.h ?? 100
      };
      await runCropImage(cropPayload);
      return;
    }
    case "gemini": {
      const data = node.data ?? {};
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const systemOverride = resolveTextInput(
        parentIds,
        parentByEdge,
        edges,
        nodeId,
        "system_prompt"
      );
      const imageUrls = resolveAllImageInputs(parentIds, parentByEdge, edges, nodeId);
      const geminiPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        model: data.model ?? "gemini-2.5-pro",
        prompt: promptOverride ?? data.prompt ?? "",
        systemPrompt: systemOverride ?? data.systemPrompt,
        temperature: data.temperature,
        imageUrls
      };
      await runGemini(geminiPayload);
      return;
    }
    case "requestInputs": {
      const data = node.data;
      const fields = {};
      for (const f of data?.fields ?? []) fields[f.key] = f.value;
      await runRequestInputs({ workflowRunId, nodeRunId, nodeId, fields });
      return;
    }
    case "input": {
      const data = node.data;
      await runInput({
        workflowRunId,
        nodeRunId,
        nodeId,
        fieldType: data?.fieldType,
        value: data?.value
      });
      return;
    }
    case "response": {
      const { primary, perEdge } = buildResponseInputs(node, edges, parentByEdge);
      await runResponse({ workflowRunId, nodeRunId, nodeId, primary, perEdge });
      return;
    }
    case "stickyNote": {
      await prisma.nodeRun.update({
        where: { id: nodeRunId },
        data: {
          status: "SUCCESS",
          finishedAt: /* @__PURE__ */ new Date(),
          output: { skipped: true }
        }
      });
      return;
    }
    default: {
      throw new Error(`unsupported node type at runtime: ${String(node.type)}`);
    }
  }
}
__name(executeWorker, "executeWorker");
function findEdgeFromParent(parentId, childId, edges) {
  return edges.filter((e) => e.source === parentId && e.target === childId);
}
__name(findEdgeFromParent, "findEdgeFromParent");
function resolveImageInput(parentIds, parentByEdge, edges, childId) {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) => (e.targetHandle ?? "").toLowerCase().includes("input") || (e.sourceHandle ?? "").toLowerCase().includes("image")
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "cropImage") return out.output.url;
    if (out.kind === "requestInputs") {
      const handle = (edge.sourceHandle ?? "").toLowerCase();
      const v = out.output.fields[handle];
      if (typeof v === "object" && v && "url" in v) return v.url;
      if (typeof v === "string") return v;
    }
  }
  return null;
}
__name(resolveImageInput, "resolveImageInput");
function resolveAllImageInputs(parentIds, parentByEdge, edges, childId) {
  const urls = [];
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
        if (typeof v === "object" && v && "url" in v) urls.push(v.url);
        else if (typeof v === "string" && v.startsWith("http")) urls.push(v);
      }
    }
  }
  return urls;
}
__name(resolveAllImageInputs, "resolveAllImageInputs");
function resolveNumberInput(parentIds, parentByEdge, edges, childId, targetHandleExact) {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) => (e.targetHandle ?? "").toLowerCase() === targetHandleExact.toLowerCase()
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
__name(resolveNumberInput, "resolveNumberInput");
function resolveTextInput(parentIds, parentByEdge, edges, childId, targetHandleHint) {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) => (e.targetHandle ?? "").toLowerCase().includes(targetHandleHint)
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "gemini") return out.output.text;
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
__name(resolveTextInput, "resolveTextInput");

export {
  buildNodeRunnerTags,
  buildNodeRunnerIdempotencyKey,
  nodeRunnerTask,
  buildChildTriggerOptions
};
//# sourceMappingURL=chunk-LZNJPYFH.mjs.map
