"use client";

import { useEffect, useState } from "react";
import {
  useRealtimeRunsWithTag,
  useRealtimeRunWithStreams,
} from "@trigger.dev/react-hooks";
import { useWorkflowStore, type RunStatus } from "@/store/useWorkflowStore";

type StreamShape = { gemini: string[] };

/**
 * Top-level (invisible) coordinator that runs while a workflow is in
 * flight. It fetches a public access token scoped to the run's
 * `wfrun:<id>` tag, opens a single SSE subscription to every
 * node-runner under that tag, and uses the resulting realtime stream
 * for two jobs:
 *
 *   1. **Canvas pulse / glow** — derives a `runStatus` map keyed by
 *      canvas nodeId from each `node-runner` run's status and writes
 *      it to the store. This is what drives the live status colours
 *      on each node while the workflow runs. (Without this, the
 *      pulsating-glow / "running" border would only update via the
 *      slow `pollRun` fallback in WorkflowCanvas.)
 *   2. **Gemini token-by-token text** — for every `kind:gemini` run,
 *      mounts a child subscriber on its individual stream so chunks
 *      from `streams.pipe("gemini", …)` land in the store as they
 *      arrive.
 *
 * Both jobs share the same `useRealtimeRunsWithTag` connection — no
 * extra network cost.
 */
export function RealtimeCoordinator({ workflowRunId }: { workflowRunId: string }) {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setToken(null);
    fetch(`/api/runs/${workflowRunId}/realtime-token`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`token ${r.status}`))))
      .then((j: { token: string }) => {
        if (!cancelled) setToken(j.token);
      })
      .catch(() => {
        // Realtime is best-effort. The slow `pollRun` fallback in
        // WorkflowCanvas keeps the canvas glow + outputs working even
        // if the token mint or SSE stream fails.
      });
    return () => {
      cancelled = true;
    };
  }, [workflowRunId]);

  if (!token) return null;
  return <ActiveCoordinator workflowRunId={workflowRunId} accessToken={token} />;
}

// Statuses we should mount a Gemini stream subscriber for. We
// deliberately include the early "before-it-runs" states so the SSE
// connection opens *before* Gemini emits chunks — otherwise the
// subscriber wakes up when the run is already COMPLETED and S2
// replays the whole buffered text in a single read burst, which
// paints as "all at once" instead of token-by-token.
const STREAM_SUBSCRIBE_STATUSES = new Set([
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "COMPLETED",
]);

/**
 * Map a Trigger.dev `RealtimeRun.status` to our canvas `RunStatus`
 * enum. Trigger has 13 states; the canvas only renders four.
 */
function mapRealtimeStatus(s: string): RunStatus {
  if (s === "EXECUTING" || s === "WAITING") return "running";
  if (s === "COMPLETED") return "success";
  if (
    s === "FAILED" ||
    s === "CRASHED" ||
    s === "SYSTEM_FAILURE" ||
    s === "TIMED_OUT" ||
    s === "EXPIRED" ||
    s === "CANCELED"
  ) {
    return "failed";
  }
  // PENDING_VERSION, QUEUED, DEQUEUED, DELAYED — not yet running.
  return "queued";
}

function ActiveCoordinator({
  workflowRunId,
  accessToken,
}: {
  workflowRunId: string;
  accessToken: string;
}) {
  const setRunStatus = useWorkflowStore((s) => s.setRunStatus);
  const { runs } = useRealtimeRunsWithTag(`wfrun:${workflowRunId}`, { accessToken });

  // Derive the `runStatus` map from the realtime stream and push it to
  // the store. This is what drives the canvas glow — replacing the
  // previous behaviour where only `pollRun` (2 s setInterval) was
  // setting it.
  useEffect(() => {
    if (!runs || runs.length === 0) return;
    const map: Record<string, RunStatus> = {};
    for (const r of runs) {
      if (r.taskIdentifier !== "node-runner") continue;
      const nodeIdTag = (r.tags ?? []).find((t) => t.startsWith("nodeId:"));
      if (!nodeIdTag) continue;
      const nodeId = nodeIdTag.slice("nodeId:".length);
      map[nodeId] = mapRealtimeStatus(r.status);
    }
    if (Object.keys(map).length > 0) setRunStatus(map);
  }, [runs, setRunStatus]);

  const subscriptions = (runs ?? [])
    .filter((r) => r.taskIdentifier === "node-runner")
    .filter((r) => (r.tags ?? []).includes("kind:gemini"))
    .filter((r) => STREAM_SUBSCRIBE_STATUSES.has(r.status))
    .map((r) => {
      const nodeIdTag = (r.tags ?? []).find((t) => t.startsWith("nodeId:"));
      if (!nodeIdTag) return null;
      return { runId: r.id, nodeId: nodeIdTag.slice("nodeId:".length) };
    })
    .filter((x): x is { runId: string; nodeId: string } => x !== null);

  return (
    <>
      {subscriptions.map((s) => (
        <GeminiStreamSubscriber
          key={s.runId}
          runId={s.runId}
          nodeId={s.nodeId}
          accessToken={accessToken}
        />
      ))}
    </>
  );
}

function GeminiStreamSubscriber({
  runId,
  nodeId,
  accessToken,
}: {
  runId: string;
  nodeId: string;
  accessToken: string;
}) {
  const setStreamingText = useWorkflowStore((s) => s.setStreamingText);
  const { streams } = useRealtimeRunWithStreams<never, StreamShape>(runId, { accessToken });

  const chunks = streams?.gemini;
  useEffect(() => {
    if (!chunks || chunks.length === 0) return;
    setStreamingText(nodeId, chunks.join(""));
  }, [chunks, nodeId, setStreamingText]);

  return null;
}
