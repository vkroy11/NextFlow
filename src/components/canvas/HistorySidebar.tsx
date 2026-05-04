"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  History as HistoryIcon,
  Loader2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/relativeTime";
import { CopyButton } from "@/components/CopyButton";

type NodeRun = {
  id: string;
  nodeId: string;
  nodeType: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
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

const RUN_DOT: Record<string, string> = {
  SUCCESS: "bg-green-500",
  FAILED: "bg-red-500",
  PARTIAL: "bg-amber-500",
  RUNNING: "bg-violet-500 animate-pulse",
  QUEUED: "bg-yellow-400",
  CANCELLED: "bg-zinc-400",
};

const NODE_TYPE_LABEL: Record<string, string> = {
  requestInputs: "Request Inputs",
  cropImage: "Crop Image",
  gemini: "Gemini",
  response: "Response",
  input: "Input",
  stickyNote: "Sticky Note",
};

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABEL[type] ?? type;
}

/**
 * Status chip / icon for a NodeRun. The four meaningful states have
 * distinct semantics:
 *   - QUEUED: pre-created row; waiting for at least one parent to finish.
 *     Shown as a static yellow dot — no animation, because there's no
 *     work in flight yet.
 *   - RUNNING: claimed by the dispatcher; worker is actively executing.
 *     Shown as a spinning purple loader.
 *   - SUCCESS: terminal happy path. Green check.
 *   - FAILED: terminal sad path. Red triangle.
 *   - CANCELLED: terminal "skipped" path (upstream parent failed or
 *     workflow timed out). Gray ban icon to differentiate from FAILED.
 */
function NodeStatusBadge({ status }: { status: string }) {
  const size = 14;
  if (status === "SUCCESS") return <CheckCircle2 size={size} className="text-green-500" />;
  if (status === "FAILED") return <AlertTriangle size={size} className="text-red-500" />;
  if (status === "CANCELLED") return <Ban size={size} className="text-zinc-400" />;
  if (status === "RUNNING")
    return <Loader2 size={size} className="animate-spin text-violet-500" />;
  // QUEUED + anything else → yellow waiting dot.
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full bg-yellow-400 ring-2 ring-yellow-100"
      aria-label="waiting"
    />
  );
}

function statusLabel(status: string): string {
  if (status === "QUEUED") return "Waiting";
  if (status === "RUNNING") return "Running";
  if (status === "SUCCESS") return "Success";
  if (status === "FAILED") return "Failed";
  if (status === "CANCELLED") return "Skipped";
  return status;
}

function statusTone(status: string): string {
  if (status === "SUCCESS") return "text-green-700";
  if (status === "FAILED") return "text-red-700";
  if (status === "CANCELLED") return "text-zinc-500";
  if (status === "RUNNING") return "text-violet-700";
  return "text-yellow-700";
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Numbering helper: when the same node type appears more than once in a
 * run's NodeRun list, suffix each instance with `#1`, `#2`, … in the
 * order they were created. Single-instance types get no suffix.
 */
function computeNumbering(nodeRuns: NodeRun[]): Map<string, string> {
  const totals = new Map<string, number>();
  for (const nr of nodeRuns) totals.set(nr.nodeType, (totals.get(nr.nodeType) ?? 0) + 1);
  const counters = new Map<string, number>();
  const result = new Map<string, string>();
  for (const nr of nodeRuns) {
    if ((totals.get(nr.nodeType) ?? 0) <= 1) {
      result.set(nr.id, "");
      continue;
    }
    const c = (counters.get(nr.nodeType) ?? 0) + 1;
    counters.set(nr.nodeType, c);
    result.set(nr.id, `#${c}`);
  }
  return result;
}

function prettyJson(v: unknown): string {
  if (v === null || v === undefined) return "—";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Pull the primary copyable string off a NodeRun's output for the copy
 * button. Each worker writes a slightly different output shape — pick
 * the one users actually want on the clipboard:
 *   - gemini   → output.text   (model response)
 *   - cropImage → output.url    (Transloadit CDN URL)
 *   - input / requestInputs → first scalar field value
 *   - response  → output.result (primary result)
 * Returns null if nothing copyable exists.
 */
function primaryCopyValue(nodeType: string, output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const obj = output as Record<string, unknown>;
  if (nodeType === "gemini" && typeof obj.text === "string") return obj.text;
  if (nodeType === "cropImage" && typeof obj.url === "string") return obj.url;
  if (nodeType === "response" && typeof obj.result === "string") return obj.result;
  if ((nodeType === "input" || nodeType === "requestInputs") && obj.fields) {
    const fields = obj.fields as Record<string, unknown>;
    for (const v of Object.values(fields)) {
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
    }
  }
  return null;
}

type ResponseOutput = {
  label: string;
  value: string;
  sourceNodeId: string | null;
  edgeId: string;
};

function responseOutputs(output: unknown): ResponseOutput[] {
  if (!output || typeof output !== "object") return [];
  const obj = output as Record<string, unknown>;
  const arr = obj.outputs;
  if (!Array.isArray(arr)) {
    // Backwards-compat: older runs only have `perEdge` — fall back so
    // historical history rows aren't blank.
    const perEdge = obj.perEdge;
    if (perEdge && typeof perEdge === "object") {
      return Object.entries(perEdge as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([edgeId, v]) => ({
          label: "Output",
          value: v as string,
          sourceNodeId: null,
          edgeId,
        }));
    }
    return [];
  }
  return arr.filter((o): o is ResponseOutput => {
    return (
      o &&
      typeof o === "object" &&
      typeof (o as ResponseOutput).value === "string" &&
      typeof (o as ResponseOutput).label === "string"
    );
  });
}

/**
 * Per-node-type rules for which sections to show (PRD UX clean-up):
 *   - requestInputs / input → user-supplied data, output mirrors input,
 *     so suppress Output. Show only Input.
 *   - response → consumes upstream values, doesn't *take* its own input
 *     in any meaningful sense — show only Output (split per upstream
 *     edge so multi-source responses are inspectable).
 *   - everything else → both Input + Output.
 */
function showInputSection(nodeType: string): boolean {
  return nodeType !== "response";
}
function showOutputSection(nodeType: string): boolean {
  return nodeType !== "requestInputs" && nodeType !== "input";
}

function NodeRunRow({ run, label }: { run: NodeRun; label: string }) {
  const [open, setOpen] = useState(false);
  const hasDetail =
    run.input !== null || run.output !== null || run.error !== null || run.startedAt !== null;
  const tone = statusTone(run.status);

  const showInput = showInputSection(run.nodeType);
  const showOutput = showOutputSection(run.nodeType);
  const responseOuts = run.nodeType === "response" ? responseOutputs(run.output) : [];
  const copyValue =
    run.nodeType === "response" ? null : primaryCopyValue(run.nodeType, run.output);

  return (
    <li className="rounded-md border border-gray-100 bg-white">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-2 text-left",
          hasDetail && "hover:bg-gray-50",
        )}
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center">
          {hasDetail ? (
            open ? (
              <ChevronDown size={12} className="text-gray-400" />
            ) : (
              <ChevronRight size={12} className="text-gray-400" />
            )
          ) : null}
        </span>
        <NodeStatusBadge status={run.status} />
        <span className="flex-1 truncate font-sans text-[12px] font-medium text-gray-800">
          {label}
        </span>
        <span className={cn("font-sans text-[10.5px] font-medium uppercase tracking-wide", tone)}>
          {statusLabel(run.status)}
        </span>
        <span className="ml-1 font-sans text-[11px] tabular-nums text-gray-400">
          {run.status === "RUNNING" && run.startedAt
            ? relativeTime(run.startedAt)
            : run.durationMs !== null
              ? formatDuration(run.durationMs)
              : run.status === "QUEUED"
                ? "—"
                : "…"}
        </span>
      </button>

      {open && hasDetail && (
        <div className="space-y-2 border-t border-gray-100 px-3 py-2 text-[11.5px]">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono">
            <div className="flex items-center gap-1 text-gray-500">
              <Clock size={11} className="text-gray-400" /> Started
            </div>
            <div className="text-gray-700">{formatTimestamp(run.startedAt)}</div>
            <div className="flex items-center gap-1 text-gray-500">
              <Clock size={11} className="text-gray-400" /> Finished
            </div>
            <div className="text-gray-700">{formatTimestamp(run.finishedAt)}</div>
            <div className="flex items-center gap-1 text-gray-500">
              <Clock size={11} className="text-gray-400" /> Duration
            </div>
            <div className="text-gray-700">{formatDuration(run.durationMs)}</div>
            <div className="text-gray-500">Node ID</div>
            <div className="truncate font-mono text-gray-600" title={run.nodeId}>
              {run.nodeId}
            </div>
          </div>

          {showInput && (
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
                Input
              </div>
              <pre className="max-h-40 overflow-auto rounded-md bg-gray-50 p-2 font-mono text-[10.5px] leading-relaxed text-gray-700">
                {prettyJson(run.input)}
              </pre>
            </div>
          )}

          {showOutput && run.nodeType === "response" && (
            responseOuts.length === 0 ? (
              <div>
                <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
                  Output
                </div>
                <p className="rounded-md bg-gray-50 p-2 text-[11px] text-gray-400">No outputs</p>
              </div>
            ) : (
              <div className="space-y-2">
                {responseOuts.map((o, i) => (
                  <div key={`${o.edgeId}-${i}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
                        Output — {o.label}
                      </div>
                      <CopyButton text={o.value} label="Copy output" size={12} />
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 font-mono text-[10.5px] leading-relaxed text-gray-700">
                      {o.value}
                    </pre>
                  </div>
                ))}
              </div>
            )
          )}

          {showOutput && run.nodeType !== "response" && (
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
                  Output
                </div>
                <CopyButton text={copyValue} label="Copy output" size={12} />
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 font-mono text-[10.5px] leading-relaxed text-gray-700">
                {copyValue ?? prettyJson(run.output)}
              </pre>
            </div>
          )}

          {run.error && (
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-red-600">
                Error
              </div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-red-50 p-2 font-mono text-[10.5px] leading-relaxed text-red-700">
                {run.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function RunBlock({ run, indexFromTop }: { run: Run; indexFromTop: number }) {
  const [open, setOpen] = useState(indexFromTop === 0);
  const numbering = useMemo(() => computeNumbering(run.nodeRuns), [run.nodeRuns]);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-gray-50"
      >
        {open ? (
          <ChevronDown size={14} className="text-gray-400" />
        ) : (
          <ChevronRight size={14} className="text-gray-400" />
        )}
        <span className={cn("h-2 w-2 rounded-full", RUN_DOT[run.status] ?? RUN_DOT.QUEUED)} />
        <span className="flex-1 text-[12.5px] font-medium text-gray-800">
          Run #{indexFromTop + 1}
          <span className="ml-1 text-gray-500">
            —{" "}
            {new Date(run.startedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </span>
        <span className="text-[11px] tabular-nums text-gray-400">
          {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : relativeTime(run.startedAt)}
        </span>
        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
          {run.scope.toLowerCase()}
        </span>
      </button>

      {open && (
        <div className="border-t border-node-border bg-gray-50/50 px-3 py-2">
          {run.nodeRuns.length === 0 ? (
            <p className="px-2 py-2 text-[11.5px] text-gray-400">No node runs yet</p>
          ) : (
            <ul className="space-y-1.5">
              {run.nodeRuns.map((nr) => {
                const suffix = numbering.get(nr.id);
                const label = suffix ? `${nodeTypeLabel(nr.nodeType)} ${suffix}` : nodeTypeLabel(nr.nodeType);
                return <NodeRunRow key={nr.id} run={nr} label={label} />;
              })}
            </ul>
          )}
          {run.error && (
            <p className="mt-2 rounded-md bg-red-50 p-2 text-[11px] text-red-700">{run.error}</p>
          )}
        </div>
      )}
    </li>
  );
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
    <aside className="absolute right-0 top-0 z-30 flex h-full w-[400px] flex-col border-l border-node-border bg-white shadow-xl">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-node-border px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <HistoryIcon size={15} />
          History
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
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
            {runs.map((run, idx) => (
              <RunBlock key={run.id} run={run} indexFromTop={idx} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
