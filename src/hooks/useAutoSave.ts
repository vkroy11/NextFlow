"use client";

import { useEffect, useRef } from "react";
import { useWorkflowStore } from "@/store/useWorkflowStore";

const DEBOUNCE_MS = 1500;

/**
 * Debounced autosave to PUT /api/workflows/[id]. Aborts any in-flight save when
 * a newer edit lands so the last write wins.
 */
export function useAutoSave() {
  const workflowId = useWorkflowStore((s) => s.workflowId);
  const saveState = useWorkflowStore((s) => s.saveState);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const name = useWorkflowStore((s) => s.workflowName);
  const setSaveState = useWorkflowStore((s) => s.setSaveState);

  const inFlight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    if (saveState !== "dirty") return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (inFlight.current) inFlight.current.abort();
      const ac = new AbortController();
      inFlight.current = ac;
      setSaveState("saving");
      try {
        const res = await fetch(`/api/workflows/${workflowId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, nodes, edges }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Save failed" }));
          throw new Error(body.error || `Save failed (${res.status})`);
        }
        setSaveState("saved", { savedAt: Date.now() });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Save failed";
        setSaveState("error", { error: message });
      } finally {
        if (inFlight.current === ac) inFlight.current = null;
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [workflowId, saveState, nodes, edges, name, setSaveState]);
}
