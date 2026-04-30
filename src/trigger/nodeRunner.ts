import { task } from "@trigger.dev/sdk/v3";
import { runCropImage, type CropPayload, type CropOutput } from "./cropImage";
import { runGemini, type GeminiPayload, type GeminiOutput } from "./gemini";

/**
 * Discriminated payload — orchestrator stamps `kind` so the task body can
 * dispatch to the right worker.
 */
export type NodeRunnerPayload =
  | ({ kind: "crop" } & CropPayload)
  | ({ kind: "gemini" } & GeminiPayload);

export type NodeRunnerOutput =
  | { kind: "crop"; output: CropOutput }
  | { kind: "gemini"; output: GeminiOutput };

/**
 * Single executable Trigger.dev task. Acts as a thin dispatcher to the
 * `runCropImage` / `runGemini` worker functions.
 *
 * Why this exists: Trigger.dev v4's `batchTriggerAndWait` only batches
 * one task type at a time. The PRD requires same-DAG-level nodes
 * ({crop1, crop2, gemini1}) to start at T = 0. Collapsing every executable
 * node type behind a single `node-runner` task means one
 * `batchTriggerAndWait` per DAG level can fan all of them out concurrently
 * on workers — Trigger.dev still only sees one pending wait on the
 * orchestrator.
 *
 * Important: this task intentionally does NOT write to the `NodeRun`
 * table. The worker functions own that bookkeeping with their actual
 * `nodeType` ("cropImage" / "gemini") so the in-app History sidebar
 * (which reads `WorkflowRun.nodeRuns`) only ever shows per-node helper
 * rows. `node-runner` runs are visible in the Trigger.dev cloud
 * dashboard, never in our sidebar.
 */
export const nodeRunnerTask = task({
  id: "node-runner",
  retry: { maxAttempts: 1 },
  // User-confirmed cap; covers Crop's mandatory 30s delay + Transloadit
  // round-trip and the longest Gemini calls comfortably.
  maxDuration: 60,
  run: async (payload: NodeRunnerPayload): Promise<NodeRunnerOutput> => {
    switch (payload.kind) {
      case "crop": {
        const { kind: _kind, ...cropPayload } = payload;
        void _kind;
        return { kind: "crop", output: await runCropImage(cropPayload) };
      }
      case "gemini": {
        const { kind: _kind, ...geminiPayload } = payload;
        void _kind;
        return { kind: "gemini", output: await runGemini(geminiPayload) };
      }
    }
  },
});
