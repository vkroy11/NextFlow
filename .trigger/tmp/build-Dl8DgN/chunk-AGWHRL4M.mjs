import {
  prisma
} from "./chunk-PDXQY6SN.mjs";
import {
  __name,
  init_esm
} from "./chunk-FUV6SSYK.mjs";

// src/trigger/inlineNodes.ts
init_esm();
async function runRequestInputs(payload) {
  const startedAt = /* @__PURE__ */ new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: payload.fields
    }
  });
  const finishedAt = /* @__PURE__ */ new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      status: "SUCCESS",
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      output: { fields: payload.fields }
    }
  });
  return { fields: payload.fields };
}
__name(runRequestInputs, "runRequestInputs");
async function runInput(payload) {
  const startedAt = /* @__PURE__ */ new Date();
  const handleId = (payload.fieldType ?? "text").toLowerCase();
  let value = payload.value;
  if (typeof value === "object" && value && "url" in value) {
    value = value.url;
  }
  const fields = { [handleId]: value };
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: { fieldType: payload.fieldType, value }
    }
  });
  const finishedAt = /* @__PURE__ */ new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      status: "SUCCESS",
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      output: { fields }
    }
  });
  return { fields };
}
__name(runInput, "runInput");
async function runResponse(payload) {
  const startedAt = /* @__PURE__ */ new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      startedAt,
      input: { primary: payload.primary, perEdge: payload.perEdge }
    }
  });
  const finishedAt = /* @__PURE__ */ new Date();
  await prisma.nodeRun.update({
    where: { id: payload.nodeRunId },
    data: {
      status: "SUCCESS",
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      output: { result: payload.primary, perEdge: payload.perEdge }
    }
  });
  return { result: payload.primary, perEdge: payload.perEdge };
}
__name(runResponse, "runResponse");
function buildResponseInputs(node, edges, parentByEdge) {
  const perEdge = {};
  let primary = null;
  for (const pid of Object.keys(parentByEdge)) {
    for (const edge of edges.filter((e) => e.source === pid && e.target === node.id)) {
      const out = parentByEdge[pid];
      if (!out) continue;
      let v = null;
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
__name(buildResponseInputs, "buildResponseInputs");

export {
  runRequestInputs,
  runInput,
  runResponse,
  buildResponseInputs
};
//# sourceMappingURL=chunk-AGWHRL4M.mjs.map
