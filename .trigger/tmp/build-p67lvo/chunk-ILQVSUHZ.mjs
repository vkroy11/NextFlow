import {
  task
} from "./chunk-5QI7KMWQ.mjs";
import {
  runCropImage
} from "./chunk-ADV4FW5L.mjs";
import {
  buildParentByEdge,
  cancelDescendants,
  dispatchReadyChildren,
  loadGraph,
  loadNodeRunIndex,
  markNodeRunFailed
} from "./chunk-6GK2XRWF.mjs";
import {
  runGemini
} from "./chunk-D7IRSL4D.mjs";
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
var nodeRunnerTask = task({
  id: "node-runner",
  retry: { maxAttempts: 1 },
  // Cap covers Crop's mandatory 30 s delay + Transloadit round-trip and
  // the longest Gemini calls. Bump if a future worker needs more.
  maxDuration: 90,
  run: /* @__PURE__ */ __name(async (payload) => {
    const { workflowRunId, workflowId, nodeRunId, nodeId } = payload;
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
        trigger: /* @__PURE__ */ __name((childPayload) => nodeRunnerTask.trigger(childPayload), "trigger")
      });
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
    }
  }, "run")
});
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
  nodeRunnerTask
};
//# sourceMappingURL=chunk-ILQVSUHZ.mjs.map
