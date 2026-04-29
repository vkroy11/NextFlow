"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History as HistoryIcon, X, CheckCircle2, AlertTriangle, Loader2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/relativeTime";

type NodeRun = {
  id: string;
  nodeId: string;
  nodeType: string;
  status: string;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

type Run = {
  id: string;
  status: string;
  scope: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  nodeRuns: NodeRun[];
};

const STATUS_COLOR: Record<string, string> = {
  SUCCESS: "bg-green-500",
  FAILED: "bg-red-500",
  PARTIAL: "bg-amber-500",
  RUNNING: "bg-violet-500 animate-pulse",
  QUEUED: "bg-zinc-300",
  CANCELLED: "bg-zinc-400",
};

function StatusIcon({ status }: { status: string }) {
  const props = { size: 14 } as const;
  if (status === "SUCCESS") return <CheckCircle2 {...props} className="text-green-500" />;
  if (status === "FAILED") return <AlertTriangle {...props} className="text-red-500" />;
  if (status === "RUNNING" || status === "QUEUED") return <Loader2 {...props} className="animate-spin text-violet-500" />;
  return <Circle {...props} className="text-zinc-400" />;
}

export function HistorySidebar({
  workflowId,
  open,
  onClose,
  refreshKey,
}: {
  workflowId: string;
  open: boolean;
  onClose: () => void;
  refreshKey: number;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function fetchRuns() {
      setLoading(true);
      try {
        const res = await fetch(`/api/workflows/${workflowId}/runs`);
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setRuns(json.runs);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchRuns();
    const t = setInterval(fetchRuns, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [workflowId, open, refreshKey]);

  if (!open) return null;

  return (
    <aside className="absolute right-0 top-0 z-30 flex h-full w-[380px] flex-col border-l border-node-border bg-white shadow-xl">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-node-border px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <HistoryIcon size={15} />
          History
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && runs.length === 0 ? (
          <div className="grid place-items-center py-12 text-xs text-gray-400">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="grid place-items-center py-12 text-xs text-gray-400">No runs yet</div>
        ) : (
          <ul className="divide-y divide-node-border">
            {runs.map((run, idx) => {
              const isOpen = expanded.has(run.id);
              return (
                <li key={run.id}>
                  <button
                    onClick={() => {
                      const next = new Set(expanded);
                      if (next.has(run.id)) next.delete(run.id);
                      else next.add(run.id);
                      setExpanded(next);
                    }}
                    className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-gray-50"
                  >
                    {isOpen ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                    <span className={cn("h-2 w-2 rounded-full", STATUS_COLOR[run.status] ?? STATUS_COLOR.QUEUED)} />
                    <span className="flex-1 text-[12.5px] font-medium text-gray-800">
                      Run #{runs.length - idx} —{" "}
                      <span className="text-gray-500">{new Date(run.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    </span>
                    <span className="text-[11px] text-gray-400">
                      {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : relativeTime(run.startedAt)}
                    </span>
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{run.scope.toLowerCase()}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-node-border bg-gray-50/50 px-4 py-2 text-[12px]">
                      {run.nodeRuns.length === 0 ? (
                        <p className="text-gray-400">No node runs yet</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {run.nodeRuns.map((nr) => (
                            <li key={nr.id} className="flex items-start gap-2 font-mono">
                              <span className="text-gray-400">├──</span>
                              <StatusIcon status={nr.status} />
                              <span className="font-sans font-medium text-gray-700">{nr.nodeType}</span>
                              <span className="font-sans text-gray-500">{nr.nodeId}</span>
                              <span className="ml-auto font-sans text-[11px] text-gray-400">
                                {nr.durationMs ? `${(nr.durationMs / 1000).toFixed(1)}s` : "…"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {run.error && (
                        <p className="mt-2 rounded-md bg-red-50 p-2 text-[11px] text-red-700">{run.error}</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
