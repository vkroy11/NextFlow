import { task } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";
import { buildAdjacency, hasCycle, upstreamClosure } from "@/lib/dag";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import { type CropOutput } from "./cropImage";
import { type GeminiOutput } from "./gemini";
import { type RequestInputsOutput } from "./requestInputs";
import { type ResponseOutput } from "./response";
import { nodeRunnerTask, type NodeRunnerPayload } from "./nodeRunner";

type Scope = "FULL" | "SINGLE" | "MULTI";

export type RunWorkflowPayload = {
  workflowRunId: string;
  workflowId: string;
  scope: Scope;
  targetNodeIds?: string[];
};

type NodeOutput =
  | { kind: "requestInputs"; output: RequestInputsOutput }
  | { kind: "cropImage"; output: CropOutput }
  | { kind: "gemini"; output: GeminiOutput }
  | { kind: "response"; output: ResponseOutput };

/**
 * Walks the workflow DAG and dispatches each executable node as a child task.
 * Concurrency model (PRD §"Expected execution behavior"):
 *   - Independent nodes start at T=0 (concurrent fan-out).
 *   - A downstream node starts the moment *its direct upstreams* resolve —
 *     it does NOT wait for unrelated siblings at the same level.
 *
 * Implementation: each node's execution is a Promise; for each node we await
 * only its parents' Promises before triggering its own task. Promise.all over
 * leaves waits the whole graph.
 */
export const runWorkflowTask = task({
  id: "run-workflow",
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

    // Decide which nodes execute. SINGLE/MULTI scope still needs upstream closure
    // so target nodes have valid inputs. Sticky notes are visual annotations
    // and are excluded from execution unconditionally.
    const executable = new Set<string>(nodes.filter((n) => n.type !== "stickyNote").map((n) => n.id));
    if (scope !== "FULL" && targetNodeIds && targetNodeIds.length > 0) {
      const closure = upstreamClosure(nodes, edges, targetNodeIds);
      executable.clear();
      for (const id of closure) {
        const n = nodes.find((x) => x.id === id);
        if (n?.type !== "stickyNote") executable.add(id);
      }
    }

    const { inn } = buildAdjacency(nodes, edges);
    const byId = new Map(nodes.map((n) => [n.id, n] as const));

    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: { status: "RUNNING" },
    });

    // ----------------------------------------------------------------
    // Level-grouped DAG executor
    // ----------------------------------------------------------------
    // Trigger.dev v4 forbids multiple `triggerAndWait`s being pending in
    // the same task — both the explicit Promise.all form and the implicit
    // eager-IIFE form. The only checkpoint-safe primitive we have for
    // running tasks in parallel is `batchTriggerAndWait`, which dispatches
    // many instances of *one* task type at once and counts as a single
    // wait.
    //
    // Strategy:
    //   1. Compute DAG levels (Kahn's algorithm). A node's level is
    //      max(parent.level) + 1, so within a level no node depends on
    //      another at the same level.
    //   2. For each level, group nodes by type.
    //   3. Inline types (requestInputs / input / response / stickyNote)
    //      are pure DB writes — process them sequentially, no waits.
    //   4. Trigger task types (cropImage / gemini) get one batched
    //      `batchTriggerAndWait` per group → all instances of that type at
    //      that level run *concurrently* on workers. Crops at level 1 fan
    //      out together; geminis at level 1 do too. Different *types* at
    //      the same level still go in separate batches (sequentially), but
    //      that's the limit Trigger v4 imposes.
    //
    // Net effect on the PRD's reference workflow: requestInputs → crops
    // (parallel via batch) + gemini-1 (separate batch, runs after crops or
    // before depending on iteration order) → gemini-2 → final-gemini →
    // response. Roughly cuts the strict-sequential time in half thanks to
    // the parallel crops.

    const outputs = new Map<string, NodeOutput>();
    const errors = new Map<string, unknown>();

    const levels = computeDagLevels(nodes, edges, executable);

    function collectParentByEdge(
      nodeId: string,
    ): { ok: true; map: Record<string, NodeOutput> } | { ok: false; err: unknown } {
      const parents = inn.get(nodeId) ?? [];
      const map: Record<string, NodeOutput> = {};
      for (const pid of parents) {
        const e = errors.get(pid);
        if (e !== undefined) return { ok: false, err: e };
        const o = outputs.get(pid);
        if (!o) return { ok: false, err: new Error(`parent ${pid} not resolved`) };
        map[pid] = o;
      }
      return { ok: true, map };
    }

    async function runRequestInputsInline(node: CanvasNode): Promise<NodeOutput> {
      const data = node.data as { fields?: Array<{ key: string; value: unknown }> } | undefined;
      const fields: Record<string, unknown> = {};
      for (const f of data?.fields ?? []) fields[f.key] = f.value;
      const startedAt = new Date();
      const nr = await prisma.nodeRun.create({
        data: {
          workflowRunId,
          nodeId: node.id,
          nodeType: "requestInputs",
          status: "RUNNING",
          startedAt,
          input: fields as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
      const finishedAt = new Date();
      await prisma.nodeRun.update({
        where: { id: nr.id },
        data: {
          status: "SUCCESS",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          output: { fields } as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
      return { kind: "requestInputs", output: { fields } };
    }

    async function runInputInline(node: CanvasNode): Promise<NodeOutput> {
      const data = node.data as { fieldType?: string; value?: unknown } | undefined;
      const handleId = (data?.fieldType ?? "text").toLowerCase();
      let value = data?.value;
      if (typeof value === "object" && value && "url" in value) {
        value = (value as { url: string }).url;
      }
      const startedAt = new Date();
      const nr = await prisma.nodeRun.create({
        data: {
          workflowRunId,
          nodeId: node.id,
          nodeType: "input",
          status: "RUNNING",
          startedAt,
          input: { fieldType: data?.fieldType, value } as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
      const finishedAt = new Date();
      await prisma.nodeRun.update({
        where: { id: nr.id },
        data: {
          status: "SUCCESS",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          output: { fields: { [handleId]: value } } as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
      return { kind: "requestInputs", output: { fields: { [handleId]: value } } };
    }

    async function runResponseInline(
      node: CanvasNode,
      parentByEdge: Record<string, NodeOutput>,
    ): Promise<NodeOutput> {
      const perEdge: Record<string, string> = {};
      let primary: string | null = null;
      for (const pid of Object.keys(parentByEdge)) {
        for (const edge of findEdgeFromParent(pid, node.id, edges)) {
          const out = parentByEdge[pid];
          if (!out) continue;
          let v: string | null = null;
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
      const startedAt = new Date();
      const nr = await prisma.nodeRun.create({
        data: {
          workflowRunId,
          nodeId: node.id,
          nodeType: "response",
          status: "RUNNING",
          startedAt,
          input: { primary, perEdge } as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
      const finishedAt = new Date();
      await prisma.nodeRun.update({
        where: { id: nr.id },
        data: {
          status: "SUCCESS",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          output: { result: primary, perEdge } as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
      return { kind: "response", output: { result: primary, perEdge } };
    }

    function buildCropPayload(node: CanvasNode, parentByEdge: Record<string, NodeOutput>) {
      const data = (node.data ?? {}) as {
        x?: number;
        y?: number;
        w?: number;
        h?: number;
        inputUrl?: string | null;
      };
      const parents = inn.get(node.id) ?? [];
      const inputUrl =
        resolveImageInput(parents, parentByEdge, edges, node.id) ?? data.inputUrl ?? null;
      if (!inputUrl) {
        throw new Error(`crop ${node.id}: no input image (connect upstream or upload locally)`);
      }
      return {
        workflowRunId,
        nodeId: node.id,
        inputUrl,
        x: resolveNumberInput(parents, parentByEdge, edges, node.id, "x") ?? data.x ?? 0,
        y: resolveNumberInput(parents, parentByEdge, edges, node.id, "y") ?? data.y ?? 0,
        w: resolveNumberInput(parents, parentByEdge, edges, node.id, "w") ?? data.w ?? 100,
        h: resolveNumberInput(parents, parentByEdge, edges, node.id, "h") ?? data.h ?? 100,
      };
    }

    function buildGeminiPayload(node: CanvasNode, parentByEdge: Record<string, NodeOutput>) {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        systemPrompt?: string;
        temperature?: number;
      };
      const parents = inn.get(node.id) ?? [];
      const promptOverride = resolveTextInput(parents, parentByEdge, edges, node.id, "prompt");
      const systemOverride = resolveTextInput(parents, parentByEdge, edges, node.id, "system_prompt");
      const imageUrls = resolveAllImageInputs(parents, parentByEdge, edges, node.id);
      return {
        workflowRunId,
        nodeId: node.id,
        model: data.model ?? "gemini-2.5-pro",
        prompt: promptOverride ?? data.prompt ?? "",
        systemPrompt: systemOverride ?? data.systemPrompt,
        temperature: data.temperature,
        imageUrls,
      };
    }

    // Execute every level in topological order.
    for (const levelNodes of levels) {
      // Bucket by type so each Trigger task type gets one batch.
      const groups = new Map<string, CanvasNode[]>();
      for (const id of levelNodes) {
        const node = byId.get(id);
        if (!node) continue;
        const t = node.type ?? "unknown";
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t)!.push(node);
      }

      // 1) Inline types — sequential, no waits.
      for (const inlineType of ["requestInputs", "input", "response", "stickyNote"] as const) {
        const ns = groups.get(inlineType);
        if (!ns) continue;
        for (const node of ns) {
          const parents = collectParentByEdge(node.id);
          if (!parents.ok) {
            errors.set(node.id, parents.err);
            continue;
          }
          try {
            let out: NodeOutput | null = null;
            if (inlineType === "requestInputs") out = await runRequestInputsInline(node);
            else if (inlineType === "input") out = await runInputInline(node);
            else if (inlineType === "response") out = await runResponseInline(node, parents.map);
            else out = { kind: "requestInputs", output: { fields: {} } }; // stickyNote no-op
            outputs.set(node.id, out);
          } catch (err) {
            errors.set(node.id, err);
          }
        }
        groups.delete(inlineType);
      }

      // 2) Mixed-type batch via node-runner.
      //
      // We collapse every executable Trigger task type at this level into a
      // single `nodeRunnerTask.batchTriggerAndWait`. The discriminator
      // (`kind: "crop" | "gemini"`) tells the dispatcher which worker
      // function to call inside each run. From the orchestrator's view this
      // is *one* pending wait (Trigger v4 happy) but on the worker side all
      // crops + geminis at this DAG level fire at T = 0 concurrently.
      const cropNodes = groups.get("cropImage") ?? [];
      const geminiNodes = groups.get("gemini") ?? [];
      type Slot = { nodeId: string; payload: NodeRunnerPayload };
      const slots: Slot[] = [];

      for (const node of cropNodes) {
        const parents = collectParentByEdge(node.id);
        if (!parents.ok) {
          errors.set(node.id, parents.err);
          continue;
        }
        try {
          slots.push({
            nodeId: node.id,
            payload: { kind: "crop", ...buildCropPayload(node, parents.map) },
          });
        } catch (err) {
          errors.set(node.id, err);
        }
      }
      for (const node of geminiNodes) {
        const parents = collectParentByEdge(node.id);
        if (!parents.ok) {
          errors.set(node.id, parents.err);
          continue;
        }
        try {
          slots.push({
            nodeId: node.id,
            payload: { kind: "gemini", ...buildGeminiPayload(node, parents.map) },
          });
        } catch (err) {
          errors.set(node.id, err);
        }
      }

      if (slots.length > 0) {
        const batch = await nodeRunnerTask.batchTriggerAndWait(
          slots.map((s) => ({ payload: s.payload })),
        );
        for (let i = 0; i < slots.length; i++) {
          const r = batch.runs[i];
          const nodeId = slots[i].nodeId;
          if (!r.ok) {
            errors.set(nodeId, new Error(`node-runner failed: ${r.error}`));
            continue;
          }
          // Map the dispatcher's `kind` back to the orchestrator's
          // `NodeOutput.kind` (which uses the canonical canvas node-type
          // strings the resolvers downstream already expect).
          if (r.output.kind === "crop") {
            outputs.set(nodeId, { kind: "cropImage", output: r.output.output });
          } else if (r.output.kind === "gemini") {
            outputs.set(nodeId, { kind: "gemini", output: r.output.output });
          }
        }
      }
      groups.delete("cropImage");
      groups.delete("gemini");

      // Any unhandled types that snuck in — surface as errors so we don't
      // silently drop nodes.
      for (const [type, ns] of groups) {
        for (const node of ns) {
          errors.set(node.id, new Error(`unsupported node type at runtime: ${type}`));
        }
      }
    }

    const targets = scope === "FULL" ? nodes.filter((n) => executable.has(n.id)) : nodes.filter((n) => executable.has(n.id));
    // Translate the outputs/errors maps back into the historic
    // PromiseSettledResult shape so the workflow status calculation below
    // works unchanged.
    const results: PromiseSettledResult<NodeOutput>[] = targets.map((n) => {
      const o = outputs.get(n.id);
      if (o) return { status: "fulfilled", value: o };
      const e = errors.get(n.id);
      return { status: "rejected", reason: e ?? new Error(`node ${n.id} never executed`) };
    });

    const failed = results.filter((r) => r.status === "rejected");
    const finalStatus = failed.length === 0 ? "SUCCESS" : failed.length === results.length ? "FAILED" : "PARTIAL";
    await prisma.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: finalStatus,
        finishedAt: new Date(),
        error: failed.length ? (failed[0] as PromiseRejectedResult).reason?.toString?.() ?? null : null,
      },
    });
    return { status: finalStatus };
  },
});

function findEdgeFromParent(parentId: string, childId: string, edges: CanvasEdge[]) {
  return edges.filter((e) => e.source === parentId && e.target === childId);
}

/**
 * Topological levels via Kahn's algorithm. Result: an array of arrays where
 * each inner array contains node ids that share the same DAG depth, i.e.
 * `level[N]` only depends on nodes from `level[<N]`. Within a level no two
 * nodes are connected, so it's safe to fan them out concurrently (subject
 * to Trigger.dev's same-task batching constraint).
 *
 * Only nodes in `executableSet` are considered — sticky notes and
 * non-executable scope filters drop out cleanly.
 */
function computeDagLevels(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  executableSet: Set<string>,
): string[][] {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    if (!executableSet.has(n.id)) continue;
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!executableSet.has(e.source) || !executableSet.has(e.target)) continue;
    adj.get(e.source)?.push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  const levels: string[][] = [];
  let frontier: string[] = [];
  for (const [id, d] of inDeg) if (d === 0) frontier.push(id);
  while (frontier.length > 0) {
    levels.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of adj.get(id) ?? []) {
        const d = (inDeg.get(child) ?? 0) - 1;
        inDeg.set(child, d);
        if (d === 0) next.push(child);
      }
    }
    frontier = next;
  }
  return levels;
}

function resolveImageInput(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
): string | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) => (e.targetHandle ?? "").toLowerCase().includes("input") || (e.sourceHandle ?? "").toLowerCase().includes("image"),
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
    // Crop output is an image URL — exposed as text so it can flow into the
    // Response node alongside Gemini text.
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

// Re-export so the trigger compiler picks up all tasks via this entry.
// `cropImageTask` / `geminiTask` were deleted in favour of `nodeRunnerTask`
// which dispatches to runCropImage / runGemini worker functions internally.
// `requestInputsTask` / `responseTask` are no longer scheduled (the
// orchestrator inlines those nodes), so they don't need re-exporting.
export { nodeRunnerTask };
