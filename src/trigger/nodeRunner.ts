import { logger, task } from "@trigger.dev/sdk/v3";
import { prisma } from "@/lib/prisma";
import type { CanvasEdge, CanvasNode } from "@/lib/types";
import { runCropImage, type CropPayload } from "./cropImage";
import { runGemini, type GeminiPayload } from "./gemini";
import { runGenerateImage, type GenerateImagePayload } from "./generateImage";
import { runGenerateVideo, type GenerateVideoPayload } from "./generateVideo";
import { runEnhanceVideo, type EnhanceVideoPayload } from "./enhanceVideo";
import { runExtendVideo, type ExtendVideoPayload } from "./extendVideo";
import { runGenerateAudio, type GenerateAudioPayload } from "./generateAudio";
import { runMuxAudioVideo, type MuxAudioVideoPayload } from "./muxAudioVideo";
import {
  runInput,
  runRequestInputs,
  runResponse,
  buildResponseInputs,
} from "./inlineNodes";
import {
  buildParentByEdge,
  cancelDescendants,
  dispatchReadyChildren,
  loadGraph,
  loadNodeRunIndex,
  markNodeRunFailed,
  tryFinaliseWorkflowRun,
  type ChildTriggerOptions,
  type GraphSnapshot,
  type NodeOutput,
} from "./dagDispatch";

/**
 * Tag/idempotency-key helpers shared with `runWorkflowTask`. Tags are
 * surfaced on the Trigger.dev dashboard for run filtering and on the
 * frontend for `useRealtimeRunsWithTag` subscriptions; idempotency keys
 * are defense-in-depth atop our Postgres CAS so a future code path or
 * retry can't double-schedule the same node.
 */
export function buildNodeRunnerTags(args: {
  workflowId: string;
  workflowRunId: string;
  nodeRunId: string;
  // Canvas (React Flow) node id and node type are also tagged so the
  // browser's `RealtimeCoordinator` can pick the right run out of a
  // `useRealtimeRunsWithTag('wfrun:<id>')` subscription and key its
  // streamed text by canvas nodeId without an extra DB lookup.
  nodeId: string;
  nodeType: string;
}): string[] {
  return [
    `workflow:${args.workflowId}`,
    `wfrun:${args.workflowRunId}`,
    `node:${args.nodeRunId}`,
    `nodeId:${args.nodeId}`,
    `kind:${args.nodeType}`,
  ];
}

export function buildNodeRunnerIdempotencyKey(args: {
  workflowRunId: string;
  nodeId: string;
}): string {
  return `wfrun-${args.workflowRunId}-node-${args.nodeId}`;
}

const NODE_RUNNER_IDEMPOTENCY_TTL = "1d";

const NODE_RUNNER_CONCURRENCY = parseInt(
  process.env.NODE_RUNNER_CONCURRENCY ??
    (process.env.NODE_ENV === "development" ? "5" : "20"),
  10,
);

/**
 * Universal node dispatcher.
 *
 * Trigger.dev v4's parallel-waits rule (one suspension per task at a time)
 * forced the previous orchestrator into a level-walking
 * `batchTriggerAndWait` loop. That delivered T = 0 fan-out within a level
 * but couldn't fire LLM2 until both crops at the same level finished —
 * even though LLM2's only parent is LLM1.
 *
 * This task fixes that. The orchestrator pre-creates a NodeRun row per
 * executable node in QUEUED status, then triggers only the root nodes via
 * fire-and-forget `nodeRunnerTask.trigger(...)`. Each invocation:
 *
 *   1. Looks up the canvas node + the workflow graph.
 *   2. Resolves its inputs from parent NodeRun rows in the database
 *      (since the orchestrator no longer holds them in memory).
 *   3. Runs the matching worker: `runCropImage` / `runGemini` (real work)
 *      or `runRequestInputs` / `runInput` / `runResponse` (formerly
 *      orchestrator-inline).
 *   4. On SUCCESS — for each child, checks whether all of *that* child's
 *      parents are now SUCCESS, atomically claims it (CAS QUEUED →
 *      RUNNING), and triggers a fresh `nodeRunnerTask` for it.
 *   5. On FAILURE — cascades CANCELLED to all transitive descendants so
 *      the orchestrator's poll loop can finalize cleanly.
 *
 * `.trigger(...)` (no -AndWait suffix) is fire-and-forget — it doesn't
 * count toward the parallel-waits rule. The dispatcher doesn't wait for
 * anything; the orchestrator polls.
 *
 * Why this is the right shape: the only correctness risk is two parents
 * both deciding "all of child's parents are SUCCESS" and trying to fire
 * the child concurrently. `tryClaimNodeRun` in `dagDispatch.ts` defends
 * against that with a Postgres-level CAS — the loser sees `count: 0` and
 * skips.
 *
 * The History sidebar is unaffected: every NodeRun row is written by a
 * named worker (`nodeType: "cropImage" | "gemini" | "requestInputs" |
 * "input" | "response"`), never by `node-runner` itself. Trigger.dev's
 * cloud dashboard still shows one `node-runner` run per node for
 * debugging, but those entries never reach our database.
 */

export type NodeRunnerPayload = {
  workflowRunId: string;
  workflowId: string;
  nodeRunId: string;
  nodeId: string;
};

export const nodeRunnerTask = task({
  id: "node-runner",
  // Three retries with exponential jitter cover the realistic transient
  // failures (Postgres connection blip, Trigger API hiccup, Transloadit
  // 5xx). Permanent errors short-circuit via `AbortTaskRunError` thrown
  // from `rethrowClassified` in the worker functions, so we don't waste
  // retries on a bad API key or a malformed payload.
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
  // Single shared queue across all node types. Caps simultaneous external-
  // API calls (Transloadit + Gemini) regardless of how many nodes a
  // workflow fans out — important once a single workflow can spawn 30+
  // siblings via the recursive dispatcher. Limit is env-driven so prod
  // (20) and dev (5) don't share a quota.
  queue: {
    name: "node-execution",
    concurrencyLimit: NODE_RUNNER_CONCURRENCY,
  },
  // Cap covers Crop's mandatory 30 s delay + Transloadit round-trip and
  // the longest Gemini calls. Bump if a future worker needs more.
  maxDuration: 90,
  // Video workers (generateVideo / enhanceVideo / extendVideo) handle
  // 10–40 MB MP4 buffers plus an FFmpeg subprocess — the default machine
  // (small-1x, ~0.5 GB) OOMs on stitch-and-upload. medium-1x (2 GB) covers
  // a Veo 8 s + 8 s extend without blowing past memory limits.
  machine: "medium-1x",
  // Final-attempt safety net. Worker try/catch handles in-band failures
  // (writes the row to FAILED before throwing), but OOM / host crash /
  // maxDuration timeout skip those — this hook ensures the row is
  // FAILED and descendants are CANCELLED so the orchestrator's 3 s poll
  // loop can finalise within ~5 s instead of hitting its 600 s timeout.
  // Hook fires only after the *final* retry attempt — correct semantics
  // for `retry.maxAttempts: 3`.
  onFailure: async ({ payload, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("node-runner final failure", {
      workflowRunId: payload.workflowRunId,
      nodeId: payload.nodeId,
      nodeRunId: payload.nodeRunId,
      message,
    });
    await prisma.nodeRun.updateMany({
      where: {
        id: payload.nodeRunId,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: `task crashed: ${message}`,
      },
    });
    try {
      const graph = await loadGraph(payload.workflowId);
      const idx = await loadNodeRunIndex(payload.workflowRunId);
      await cancelDescendants({
        workflowRunId: payload.workflowRunId,
        failedNodeId: payload.nodeId,
        graph,
        nodeRunIndex: idx,
        reason: "failed in onFailure hook",
      });
    } catch (cleanupErr) {
      // Cleanup is best-effort; the workflow janitor will eventually
      // catch any stuck rows and force-finalise the run.
      logger.warn("onFailure cascade cleanup raised", {
        workflowRunId: payload.workflowRunId,
        message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    // Last-leaf finalisation: if this failure made the run fully
    // terminal (every NodeRun row is now SUCCESS / FAILED / CANCELLED),
    // atomically write the aggregated WorkflowRun.status. CAS in the
    // helper means racing finalisers safely no-op.
    await tryFinaliseWorkflowRun(payload.workflowRunId);
  },
  run: async (payload: NodeRunnerPayload): Promise<unknown> => {
    const { workflowRunId, workflowId, nodeRunId, nodeId } = payload;
    logger.info("node-runner start", { workflowRunId, nodeId, nodeRunId });

    const graph = await loadGraph(workflowId);
    const node = graph.byId.get(nodeId);
    if (!node) {
      await markNodeRunFailed(nodeRunId, `node ${nodeId} not found in workflow ${workflowId}`);
      return;
    }

    const nodeRunIndex = await loadNodeRunIndex(workflowRunId);

    // Resolve inputs from the parents' NodeRun rows.
    const parents = await buildParentByEdge(workflowRunId, nodeId, graph);
    if (!parents.ok) {
      await markNodeRunFailed(nodeRunId, parents.err);
      await cancelDescendants({
        workflowRunId,
        failedNodeId: nodeId,
        graph,
        nodeRunIndex,
        reason: "failed",
      });
      // This failure may have flipped the last non-terminal row to
      // CANCELLED; try to finalise.
      await tryFinaliseWorkflowRun(workflowRunId);
      return;
    }

    let workerOutput: unknown;
    try {
      workerOutput = await executeWorker({
        node,
        edges: graph.edges,
        nodeRunId,
        workflowRunId,
        parentByEdge: parents.map,
        graph,
      });

      // Refresh the index so we see this node's own SUCCESS row when
      // checking children's parent statuses.
      const refreshedIndex = await loadNodeRunIndex(workflowRunId);
      await dispatchReadyChildren({
        workflowRunId,
        workflowId,
        completedNodeId: nodeId,
        graph,
        nodeRunIndex: refreshedIndex,
        trigger: (childPayload, options) =>
          nodeRunnerTask.trigger(childPayload satisfies NodeRunnerPayload, options),
        buildOptions: (childNodeRunId, childNodeId) => buildChildTriggerOptions({
          workflowId,
          workflowRunId,
          nodeRunId: childNodeRunId,
          nodeId: childNodeId,
          nodeType: graph.byId.get(childNodeId)?.type ?? "unknown",
        }),
      });
      logger.info("node-runner success", { workflowRunId, nodeId });
      // Last-leaf finalisation: if this completion made every row in
      // the workflow terminal (e.g., this is a leaf node and all its
      // siblings already finished), the helper CAS-finalises
      // WorkflowRun.status. Otherwise no-op.
      await tryFinaliseWorkflowRun(workflowRunId);
      // Surface the worker output as the task's return value. Trigger
      // serializes this as `run.output` and ships it via realtime SSE,
      // so the frontend `RealtimeCoordinator` can read each node's
      // result (Gemini text, Crop CDN URL, Response per-edge map)
      // straight from the tag-filtered subscription — no fetch to
      // /api/runs/[runId] needed in the happy path.
      return workerOutput;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Worker functions already mark their own NodeRun row FAILED. We
      // cascade-cancel downstream so the run can finalise without
      // waiting on now-orphaned descendants.
      const refreshedIndex = await loadNodeRunIndex(workflowRunId);
      await cancelDescendants({
        workflowRunId,
        failedNodeId: nodeId,
        graph,
        nodeRunIndex: refreshedIndex,
        reason: `failed: ${message}`,
      });
      // The cascade may have flipped the last non-terminal row to
      // CANCELLED; finalise if so. Done before the rethrow because the
      // throw triggers Trigger's retry path — and on the *final* retry
      // failure, the onFailure hook also calls this. Belt + braces.
      await tryFinaliseWorkflowRun(workflowRunId);
      // Re-throw so Trigger.dev can apply the retry policy. AbortTaskRunError
      // (from `rethrowClassified` in the workers) short-circuits remaining
      // attempts; everything else gets up to maxAttempts: 3.
      throw err;
    }
  },
});

/**
 * Compose the trigger options (tags + idempotency key + TTL) for any
 * `nodeRunnerTask.trigger(...)` call — used both inside the dispatcher's
 * cascade and from `runWorkflowTask` when firing roots.
 */
export function buildChildTriggerOptions(args: {
  workflowId: string;
  workflowRunId: string;
  nodeRunId: string;
  nodeId: string;
  nodeType: string;
}): ChildTriggerOptions {
  return {
    tags: buildNodeRunnerTags({
      workflowId: args.workflowId,
      workflowRunId: args.workflowRunId,
      nodeRunId: args.nodeRunId,
      nodeId: args.nodeId,
      nodeType: args.nodeType,
    }),
    idempotencyKey: buildNodeRunnerIdempotencyKey({
      workflowRunId: args.workflowRunId,
      nodeId: args.nodeId,
    }),
    idempotencyKeyTTL: NODE_RUNNER_IDEMPOTENCY_TTL,
  };
}

async function executeWorker(args: {
  node: CanvasNode;
  edges: CanvasEdge[];
  nodeRunId: string;
  workflowRunId: string;
  parentByEdge: Record<string, NodeOutput>;
  graph: GraphSnapshot;
}): Promise<unknown> {
  const { node, edges, nodeRunId, workflowRunId, parentByEdge, graph } = args;
  const nodeId = node.id;
  // `graph.inn` stores parent ids once per edge (needed by topoSort which
  // uses indeg as an edge count). The resolvers below iterate parents and
  // then iterate *every* edge from that parent — so if the same parent is
  // listed 3× (3 image_field edges → 1 vision target), each parent visit
  // re-emits all 3 URLs, producing 9. Dedupe here so each resolver sees
  // unique parent ids; the inner edge loop still enumerates every edge.
  const parentIds = Array.from(new Set(graph.inn.get(nodeId) ?? []));

  switch (node.type) {
    case "cropImage": {
      const data = (node.data ?? {}) as {
        x?: number;
        y?: number;
        w?: number;
        h?: number;
        inputUrl?: string | null;
      };
      const inputUrl =
        resolveImageInput(parentIds, parentByEdge, edges, nodeId) ?? data.inputUrl ?? null;
      if (!inputUrl) {
        // Mark the row failed in-place so the cascade in nodeRunnerTask
        // sees a definitive FAILED state.
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `crop ${nodeId}: no input image (connect upstream or upload locally)`,
          },
        });
        throw new Error(`crop ${nodeId}: no input image`);
      }
      const cropPayload: CropPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        inputUrl,
        x: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "x") ?? data.x ?? 0,
        y: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "y") ?? data.y ?? 0,
        w: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "w") ?? data.w ?? 100,
        h: resolveNumberInput(parentIds, parentByEdge, edges, nodeId, "h") ?? data.h ?? 100,
      };
      return await runCropImage(cropPayload);
    }

    case "gemini": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        systemPrompt?: string;
        temperature?: number;
      };
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const systemOverride = resolveTextInput(
        parentIds,
        parentByEdge,
        edges,
        nodeId,
        "system_prompt",
      );
      const imageUrls = resolveAllImageInputs(parentIds, parentByEdge, edges, nodeId);
      const geminiPayload: GeminiPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        model: data.model ?? "gemini-2.5-pro",
        prompt: promptOverride ?? data.prompt ?? "",
        systemPrompt: systemOverride ?? data.systemPrompt,
        temperature: data.temperature,
        imageUrls,
      };
      return await runGemini(geminiPayload);
    }

    case "requestInputs": {
      const data = node.data as
        | { fields?: Array<{ key: string; value: unknown }> }
        | undefined;
      const fields: Record<string, unknown> = {};
      for (const f of data?.fields ?? []) fields[f.key] = f.value;
      return await runRequestInputs({ workflowRunId, nodeRunId, nodeId, fields });
    }

    case "input": {
      const data = node.data as
        | { fieldType?: string; value?: unknown }
        | undefined;
      return await runInput({
        workflowRunId,
        nodeRunId,
        nodeId,
        fieldType: data?.fieldType,
        value: data?.value,
      });
    }

    case "response": {
      const { primary, perEdge } = buildResponseInputs(node, edges, parentByEdge);
      return await runResponse({ workflowRunId, nodeRunId, nodeId, primary, perEdge });
    }

    case "generateImage": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        aspectRatio?: string;
        inputUrl?: string | null;
        systemPrompt?: string;
        seed?: number;
        temperature?: number;
      };
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const systemPromptOverride = resolveTextInput(
        parentIds,
        parentByEdge,
        edges,
        nodeId,
        "system_prompt",
      );
      const connectedItems = resolveAllImageInputsWithIds(parentIds, parentByEdge, edges, nodeId);
      const localImageUrl = data.inputUrl ?? null;
      const inputImageUrls = applyImageOrder(
        connectedItems,
        (node.data as { imageOrder?: string[] } | undefined)?.imageOrder,
        connectedItems.length === 0 ? localImageUrl : null,
      ).slice(0, 3);
      const prompt = promptOverride ?? data.prompt ?? "";
      if (!prompt.trim()) {
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `generateImage ${nodeId}: prompt is required`,
          },
        });
        throw new Error(`generateImage ${nodeId}: prompt is required`);
      }
      const genImagePayload: GenerateImagePayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        model: data.model ?? "gemini-3-pro-image-preview",
        prompt,
        inputImageUrls,
        aspectRatio: data.aspectRatio,
        systemPrompt: (systemPromptOverride ?? data.systemPrompt) || undefined,
        seed: data.seed,
        temperature: data.temperature,
      };
      return await runGenerateImage(genImagePayload);
    }

    case "generateVideo": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        durationSeconds?: number;
        aspectRatio?: string;
        inputUrl?: string | null;
        negativePrompt?: string;
        resolution?: string;
        personGeneration?: string;
      };
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const connectedItems = resolveAllImageInputsWithIds(parentIds, parentByEdge, edges, nodeId);
      const localImageUrl = data.inputUrl ?? null;
      // Apply the user-chosen ordering from the canvas thumbnails so slot 1
      // (start frame) matches what they see in the UI. Local upload is only
      // included when nothing is connected — connecting a source replaces
      // the upload, same convention as the rest of the node types.
      const inputImageUrls = applyImageOrder(
        connectedItems,
        (node.data as { imageOrder?: string[] } | undefined)?.imageOrder,
        connectedItems.length === 0 ? localImageUrl : null,
      ).slice(0, 3);
      const prompt = promptOverride ?? data.prompt ?? "";
      if (!prompt.trim()) {
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `generateVideo ${nodeId}: prompt is required`,
          },
        });
        throw new Error(`generateVideo ${nodeId}: prompt is required`);
      }
      const genVideoPayload: GenerateVideoPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        model: data.model ?? "veo-3.1-generate-preview",
        prompt,
        inputImageUrls,
        durationSeconds: data.durationSeconds ?? 6,
        aspectRatio: data.aspectRatio ?? "16:9",
        negativePrompt: data.negativePrompt,
        resolution: data.resolution,
        personGeneration: data.personGeneration,
      };
      return await runGenerateVideo(genVideoPayload);
    }

    case "enhanceVideo": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        inputVideoUrl?: string | null;
        durationSeconds?: number;
        aspectRatio?: string;
        negativePrompt?: string;
      };
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const inputVideoUrl =
        resolveVideoInput(parentIds, parentByEdge, edges, nodeId) ?? data.inputVideoUrl ?? null;
      if (!inputVideoUrl) {
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `enhanceVideo ${nodeId}: no input video — connect an upstream video output or upload locally`,
          },
        });
        throw new Error(`enhanceVideo ${nodeId}: no input video`);
      }
      const enhancePayload: EnhanceVideoPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        model: data.model ?? "veo-3.1-generate-preview",
        prompt: promptOverride ?? data.prompt ?? "",
        inputVideoUrl,
        durationSeconds: data.durationSeconds,
        aspectRatio: data.aspectRatio,
        negativePrompt: data.negativePrompt,
      };
      return await runEnhanceVideo(enhancePayload);
    }

    case "extendVideo": {
      const data = (node.data ?? {}) as {
        model?: string;
        prompt?: string;
        inputVideoUrl?: string | null;
        durationSeconds?: number;
        aspectRatio?: string;
        negativePrompt?: string;
        resolution?: string;
        personGeneration?: string;
      };
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const inputVideoUrl =
        resolveVideoInput(parentIds, parentByEdge, edges, nodeId) ?? data.inputVideoUrl ?? null;
      if (!inputVideoUrl) {
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `extendVideo ${nodeId}: no input video — connect an upstream video output or upload locally`,
          },
        });
        throw new Error(`extendVideo ${nodeId}: no input video`);
      }
      const inputVeoFileUri = resolveUpstreamVeoFileUri(parentIds, parentByEdge, edges, nodeId);
      const extendPayload: ExtendVideoPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        model: data.model ?? "veo-3.1-generate-preview",
        prompt: promptOverride ?? data.prompt ?? "",
        inputVideoUrl,
        inputVeoFileUri: inputVeoFileUri ?? undefined,
        durationSeconds: data.durationSeconds ?? 8,
        aspectRatio: data.aspectRatio ?? "16:9",
        negativePrompt: data.negativePrompt,
        resolution: data.resolution,
        personGeneration: data.personGeneration,
      };
      return await runExtendVideo(extendPayload);
    }

    case "generateAudio": {
      const data = (node.data ?? {}) as {
        prompt?: string;
        voiceName?: string;
        accent?: string;
        model?: string;
      };
      const promptOverride = resolveTextInput(parentIds, parentByEdge, edges, nodeId, "prompt");
      const prompt = promptOverride ?? data.prompt ?? "";
      if (!prompt.trim()) {
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `generateAudio ${nodeId}: prompt (script) is required`,
          },
        });
        throw new Error(`generateAudio ${nodeId}: prompt is required`);
      }
      const audioPayload: GenerateAudioPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        prompt,
        voiceName: data.voiceName ?? "Kore",
        accent: data.accent,
        model: data.model,
      };
      return await runGenerateAudio(audioPayload);
    }

    case "muxAudioVideo": {
      const videoUrl = resolveVideoInput(parentIds, parentByEdge, edges, nodeId);
      const audioUrl = resolveAudioInput(parentIds, parentByEdge, edges, nodeId);
      if (!videoUrl || !audioUrl) {
        await prisma.nodeRun.update({
          where: { id: nodeRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: `muxAudioVideo ${nodeId}: both video and audio inputs are required`,
          },
        });
        throw new Error(`muxAudioVideo ${nodeId}: missing inputs`);
      }
      const muxPayload: MuxAudioVideoPayload = {
        workflowRunId,
        nodeRunId,
        nodeId,
        videoUrl,
        audioUrl,
      };
      return await runMuxAudioVideo(muxPayload);
    }

    case "stickyNote": {
      // Sticky notes shouldn't reach here — orchestrator filters them out
      // of the executable set. Defensive no-op so a stray sticky doesn't
      // halt a run.
      await prisma.nodeRun.update({
        where: { id: nodeRunId },
        data: {
          status: "SUCCESS",
          finishedAt: new Date(),
          output: { skipped: true } as never,
        },
      });
      return { skipped: true };
    }

    default: {
      throw new Error(`unsupported node type at runtime: ${String(node.type)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Resolver helpers (mirrors the orchestrator's old in-process versions; the
// only change is they read the parent NodeOutput map rebuilt from
// `NodeRun.output` rows by `dagDispatch.buildParentByEdge`).
// ---------------------------------------------------------------------------

function findEdgeFromParent(
  parentId: string,
  childId: string,
  edges: CanvasEdge[],
): CanvasEdge[] {
  return edges.filter((e) => e.source === parentId && e.target === childId);
}

function resolveImageInput(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
): string | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) =>
        (e.targetHandle ?? "").toLowerCase().includes("input") ||
        (e.sourceHandle ?? "").toLowerCase().includes("image"),
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "cropImage") return out.output.url;
    if (out.kind === "generateImage") return out.output.url;
    if (out.kind === "requestInputs") {
      const handle = (edge.sourceHandle ?? "").toLowerCase();
      const v = out.output.fields[handle];
      if (typeof v === "object" && v && "url" in v) return (v as { url: string }).url;
      if (typeof v === "string") return v;
    }
  }
  return null;
}

function resolveAllImageInputsWithIds(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
  targetHandleHint = "image",
): Array<{ edgeId: string; url: string }> {
  const items: Array<{ edgeId: string; url: string }> = [];
  for (const pid of parentIds) {
    for (const edge of findEdgeFromParent(pid, childId, edges)) {
      const targetHandle = (edge.targetHandle ?? "").toLowerCase();
      if (
        !targetHandle.includes(targetHandleHint) &&
        !targetHandle.includes("vision") &&
        !targetHandle.includes("image") &&
        !targetHandle.includes("input")
      ) {
        continue;
      }
      const out = parentByEdge[pid];
      if (!out) continue;
      let url: string | null = null;
      if (out.kind === "cropImage") url = out.output.url;
      else if (out.kind === "generateImage") url = out.output.url;
      else if (out.kind === "requestInputs") {
        const sourceHandle = (edge.sourceHandle ?? "").toLowerCase();
        const v = out.output.fields[sourceHandle];
        if (typeof v === "object" && v && "url" in v) url = (v as { url: string }).url;
        else if (typeof v === "string" && v.startsWith("http")) url = v;
      }
      if (url) items.push({ edgeId: edge.id, url });
    }
  }
  return items;
}

function resolveAllImageInputs(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
  targetHandleHint = "image",
): string[] {
  return resolveAllImageInputsWithIds(parentIds, parentByEdge, edges, childId, targetHandleHint).map(
    (i) => i.url,
  );
}

/**
 * Apply a user-defined ordering (from `imageOrder` on node.data) to a list
 * of resolved image items. Items not in the order list fall to the end in
 * their natural sequence. Used by `generateVideo` so slot 1 = start frame
 * matches what the user sees in the canvas thumbnails.
 */
function applyImageOrder(
  items: Array<{ edgeId: string; url: string }>,
  imageOrder: string[] | undefined,
  localUrl: string | null,
): string[] {
  const all: Array<{ key: string; url: string }> = items.map((i) => ({ key: i.edgeId, url: i.url }));
  if (localUrl) all.push({ key: "_local", url: localUrl });
  if (!imageOrder || imageOrder.length === 0) return all.map((a) => a.url);
  return [...all]
    .sort((a, b) => {
      const ai = imageOrder.indexOf(a.key);
      const bi = imageOrder.indexOf(b.key);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    })
    .map((a) => a.url);
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
    // Crop/image/video outputs are URLs — exposed as text so they can flow
    // into the Response node alongside Gemini text.
    if (out.kind === "cropImage") return out.output.url;
    if (out.kind === "generateImage") return out.output.url;
    if (out.kind === "generateVideo") return out.output.url;
    if (out.kind === "enhanceVideo") return out.output.url;
    if (out.kind === "extendVideo") return out.output.url;
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

function resolveVideoInput(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
): string | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) =>
        (e.targetHandle ?? "").toLowerCase().includes("input") ||
        (e.sourceHandle ?? "").toLowerCase().includes("video"),
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "generateVideo") return out.output.url;
    if (out.kind === "enhanceVideo") return out.output.url;
    if (out.kind === "extendVideo") return out.output.url;
    if (out.kind === "muxAudioVideo") return out.output.url;
    if (out.kind === "requestInputs") {
      const handle = (edge.sourceHandle ?? "").toLowerCase();
      const v = out.output.fields[handle];
      if (typeof v === "object" && v && "url" in v) return (v as { url: string }).url;
      if (typeof v === "string") return v;
    }
  }
  return null;
}

/**
 * Resolve a single audio URL flowing into `childId`. Mirrors
 * `resolveVideoInput` but matches handles hinting at audio (the muxer's
 * `audio-input` handle, requestInputs audio fields, etc.).
 */
function resolveAudioInput(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
): string | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) =>
        (e.targetHandle ?? "").toLowerCase().includes("audio") ||
        (e.sourceHandle ?? "").toLowerCase().includes("audio"),
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "generateAudio") return out.output.url;
    if (out.kind === "requestInputs") {
      const handle = (edge.sourceHandle ?? "").toLowerCase();
      const v = out.output.fields[handle];
      if (typeof v === "object" && v && "url" in v) return (v as { url: string }).url;
      if (typeof v === "string") return v;
    }
  }
  return null;
}

/**
 * Resolve the upstream Veo file URI for an extendVideo input. Only set when
 * the parent is a `generateVideo` or `enhanceVideo` node whose run still has
 * the original Veo URI (Files API URIs last ~48 h). Used to attempt native
 * Veo continuation before falling back to last-frame image-to-video.
 */
function resolveUpstreamVeoFileUri(
  parentIds: string[],
  parentByEdge: Record<string, NodeOutput>,
  edges: CanvasEdge[],
  childId: string,
): string | null {
  for (const pid of parentIds) {
    const edge = findEdgeFromParent(pid, childId, edges).find(
      (e) =>
        (e.targetHandle ?? "").toLowerCase().includes("input") ||
        (e.sourceHandle ?? "").toLowerCase().includes("video"),
    );
    if (!edge) continue;
    const out = parentByEdge[pid];
    if (!out) continue;
    if (out.kind === "generateVideo" || out.kind === "enhanceVideo") {
      return out.output.veoFileUri ?? null;
    }
  }
  return null;
}
