"use client";

import { useEffect, useState } from "react";
import {
  useRealtimeRunsWithTag,
  useRealtimeRunWithStreams,
} from "@trigger.dev/react-hooks";
import { useWorkflowStore } from "@/store/useWorkflowStore";

type StreamShape = { gemini: string[] };

/**
 * Top-level (invisible) coordinator that runs while a workflow is in
 * flight. It fetches a public access token scoped to this run's
 * `wfrun:<id>` tag, subscribes to every node-runner under that tag, and
 * mounts a child subscriber for each Gemini node-runner — wiring its
 * live text chunks into the workflow store keyed by canvas nodeId.
 */
export function GeminiStreamCoordinator({ workflowRunId }: { workflowRunId: string }) {
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
        // Realtime is best-effort. The 2 s pollRun fallback already
        // surfaces the final text once the run completes, so a token
        // failure just means the user doesn't see chunks streaming
        // — they still see the response.
      });
    return () => {
      cancelled = true;
    };
  }, [workflowRunId]);

  if (!token) return null;
  return <ActiveCoordinator workflowRunId={workflowRunId} accessToken={token} />;
}

// Statuses we should mount a stream subscriber for. We deliberately
// include the early "before-it-runs" states (PENDING_VERSION, QUEUED,
// DEQUEUED, WAITING) so the SSE connection opens *before* Gemini emits
// chunks — otherwise the subscriber wakes up when the run is already
// COMPLETED and S2 replays the whole buffered text in a single read
// burst, which paints as "all at once" instead of token-by-token.
const SUBSCRIBE_STATUSES = new Set([
  "PENDING_VERSION",
  "QUEUED",
  "DEQUEUED",
  "EXECUTING",
  "WAITING",
  "COMPLETED",
]);

function ActiveCoordinator({
  workflowRunId,
  accessToken,
}: {
  workflowRunId: string;
  accessToken: string;
}) {
  const { runs } = useRealtimeRunsWithTag(`wfrun:${workflowRunId}`, { accessToken });

  const subscriptions = (runs ?? [])
    .filter((r) => r.taskIdentifier === "node-runner")
    .filter((r) => (r.tags ?? []).includes("kind:gemini"))
    .filter((r) => SUBSCRIBE_STATUSES.has(r.status))
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
