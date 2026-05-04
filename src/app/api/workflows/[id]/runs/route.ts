import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import type { CanvasEdge, CanvasNode } from "@/lib/types";

export const runtime = "nodejs";

const NODE_TYPE_LABEL: Record<string, string> = {
  requestInputs: "Request Inputs",
  cropImage: "Crop Image",
  gemini: "Gemini",
  response: "Response",
  input: "Input",
  stickyNote: "Sticky Note",
};

/**
 * Numbering helper at the workflow level: when the same node type
 * appears more than once, suffix each instance with `#1`, `#2`, … in the
 * order they appear in `workflow.nodes`. Single-instance types get no
 * suffix. Same algorithm as the History sidebar's per-run numbering, but
 * applied to all nodes in the workflow so that response output labels
 * (which point back at sibling executable nodes) match the suffixes the
 * sidebar shows next to those siblings.
 */
function buildNodeLabelMap(nodes: CanvasNode[]): Map<string, string> {
  const totals = new Map<string, number>();
  for (const n of nodes) totals.set(n.type, (totals.get(n.type) ?? 0) + 1);
  const counters = new Map<string, number>();
  const out = new Map<string, string>();
  for (const n of nodes) {
    const label = NODE_TYPE_LABEL[n.type] ?? n.type;
    if ((totals.get(n.type) ?? 0) <= 1) {
      out.set(n.id, label);
      continue;
    }
    const c = (counters.get(n.type) ?? 0) + 1;
    counters.set(n.type, c);
    out.set(n.id, `${label} #${c}`);
  }
  return out;
}

/**
 * Enrich a Response node's `perEdge` map (keyed by opaque edge IDs) into
 * a list of `{ label, value, sourceNodeId }` that the sidebar can render
 * as a labelled per-output panel with copy buttons.
 *
 * Done here, not in the worker, because the worker writes the row before
 * we know what to call each source — and edge-id labels would require
 * the worker to carry the workflow's full label map. Cheaper to compute
 * once in the API at read time.
 */
function enrichResponseOutput(
  output: unknown,
  edges: CanvasEdge[],
  nodeLabel: Map<string, string>,
): unknown {
  if (!output || typeof output !== "object") return output;
  const obj = output as Record<string, unknown>;
  const perEdge = obj.perEdge as Record<string, string> | undefined;
  if (!perEdge) return output;

  const edgeById = new Map(edges.map((e) => [e.id, e] as const));
  const outputs = Object.entries(perEdge).map(([edgeId, value]) => {
    const edge = edgeById.get(edgeId);
    const sourceNodeId = edge?.source ?? null;
    const label = sourceNodeId ? (nodeLabel.get(sourceNodeId) ?? "Output") : "Output";
    return { label, value, sourceNodeId, edgeId };
  });

  return { ...obj, outputs };
}

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow || workflow.userId !== userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const nodes = workflow.nodes as unknown as CanvasNode[];
  const edges = workflow.edges as unknown as CanvasEdge[];
  const nodeLabel = buildNodeLabelMap(nodes);

  const runs = await prisma.workflowRun.findMany({
    where: { workflowId: id },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: {
      nodeRuns: { orderBy: { startedAt: "asc" } },
    },
  });

  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      scope: r.scope,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      error: r.error,
      nodeRuns: r.nodeRuns.map((nr) => ({
        id: nr.id,
        nodeId: nr.nodeId,
        nodeType: nr.nodeType,
        status: nr.status,
        startedAt: nr.startedAt,
        finishedAt: nr.finishedAt,
        durationMs: nr.durationMs,
        input: nr.input,
        output:
          nr.nodeType === "response"
            ? enrichResponseOutput(nr.output, edges, nodeLabel)
            : nr.output,
        error: nr.error,
      })),
    })),
  });
}
