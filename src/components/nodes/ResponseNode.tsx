"use client";

import { useMemo, useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { Download, FileOutput, Info, Loader2, Pencil, Trash2 } from "lucide-react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { HANDLE_COLOR, colorForHandle } from "@/lib/handleColors";
import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";

type Data = {
  result?: string | null;
  results?: Record<string, string | null>;
  labels?: Record<string, string>;
};

const TYPE_NAME: Record<string, string> = {
  requestInputs: "request_inputs",
  cropImage: "crop",
  gemini: "gemini",
  input: "input",
};

export function ResponseNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const setEdges = useWorkflowStore((s) => s.setEdges);
  const runStatus = useWorkflowStore((s) => s.runStatus[id]);
  const isRunning = runStatus === "running";

  // Stable refs from the store; derive the labeled rows in useMemo so we don't
  // return a freshly-allocated array from the selector on every store snapshot.
  const edges = useWorkflowStore((s) => s.edges);
  const allNodes = useWorkflowStore((s) => s.nodes);

  const rows = useMemo(() => {
    return edges
      .filter((e) => e.target === id)
      .map((edge) => {
        const sourceNode = allNodes.find((n) => n.id === edge.source);
        if (!sourceNode) return null;
        const baseName = TYPE_NAME[sourceNode.type ?? ""] ?? (sourceNode.type ?? "node");
        const sameType = allNodes.filter((n) => n.type === sourceNode.type);
        const index = sameType.findIndex((n) => n.id === sourceNode.id) + 1;
        const autoLabel = `${baseName}_${index}`;
        const customLabel = data?.labels?.[edge.id];
        return {
          edgeId: edge.id,
          label: customLabel || autoLabel,
          autoLabel,
          color: colorForHandle(edge.sourceHandle),
          result: data?.results?.[edge.id] ?? null,
          sourceType: sourceNode.type ?? "",
        };
      })
      .filter((r): r is {
        edgeId: string;
        label: string;
        autoLabel: string;
        color: string;
        result: string | null;
        sourceType: string;
      } => Boolean(r));
  }, [edges, allNodes, id, data?.labels, data?.results]);

  const [renamingEdgeId, setRenamingEdgeId] = useState<string | null>(null);

  const removeEdge = (edgeId: string) => {
    setEdges(edges.filter((e) => e.id !== edgeId));
    if (data?.labels?.[edgeId] || data?.results?.[edgeId]) {
      const labels = { ...(data?.labels ?? {}) };
      const results = { ...(data?.results ?? {}) };
      delete labels[edgeId];
      delete results[edgeId];
      updateNodeData(id, { labels, results });
    }
  };

  const renameRow = (edgeId: string, label: string) => {
    const trimmed = label.trim();
    const labels = { ...(data?.labels ?? {}) };
    if (trimmed) labels[edgeId] = trimmed;
    else delete labels[edgeId];
    updateNodeData(id, { labels });
    setRenamingEdgeId(null);
  };

  return (
    <div
      style={{ width: 380, minWidth: 380, maxWidth: 380 }}
      className={cn(
        "rounded-xl border bg-white shadow-2xl transition-all duration-200",
        selected
          ? "border-gray-200 ring-2 ring-workflow-accent-500"
          : "border-gray-200",
        isRunning && "nf-running",
        runStatus === "success" && "border-green-400/60",
        runStatus === "failed" && "border-red-400/60",
      )}
    >
      <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-workflow-accent-500/10 text-workflow-accent-500">
          <FileOutput className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold text-gray-900">Response</span>
        <span className="group/tip relative shrink-0">
          <Info className="h-3.5 w-3.5 cursor-default text-gray-400" />
          <span className="pointer-events-none absolute left-1/2 top-full z-[9999] mt-1.5 hidden w-max max-w-[260px] -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] font-normal leading-relaxed text-gray-700 shadow-lg group-hover/tip:block">
            Connect node outputs here to define what your workflow returns.
          </span>
        </span>
      </div>
      <div className="space-y-3 p-4">
        <div className="relative">
          <Handle
            id="result"
            type="target"
            position={Position.Left}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              left: -21,
              top: 8,
              transform: "translateY(-50%)",
              background: HANDLE_COLOR.result,
              borderColor: HANDLE_COLOR.result,
              boxShadow: `${HANDLE_COLOR.result}50 0 0 8px`,
            }}
          />
          <span className="text-xs text-gray-500">result</span>
        </div>

        {rows.length === 0 ? (
          <div className="flex min-h-[48px] items-center justify-center rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] p-3 text-[12px] text-gray-400">
            Connect any node output to start collecting results.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <ResultCard
                key={row.edgeId}
                row={row}
                renaming={renamingEdgeId === row.edgeId}
                onStartRename={() => setRenamingEdgeId(row.edgeId)}
                onCommitRename={(v) => renameRow(row.edgeId, v)}
                onCancelRename={() => setRenamingEdgeId(null)}
                onDelete={() => removeEdge(row.edgeId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({
  row,
  renaming,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  row: {
    edgeId: string;
    label: string;
    autoLabel: string;
    color: string;
    result: string | null;
    sourceType: string;
  };
  renaming: boolean;
  onStartRename: () => void;
  onCommitRename: (v: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  // Treat the result as an image when either the upstream node says so
  // (Crop output is always an image) or the value pattern-matches a known
  // image URL / data-URL shape. Anything else renders as text.
  const isImage =
    !!row.result && (row.sourceType === "cropImage" || looksLikeImageUrl(row.result));

  return (
    <div className="rounded-lg bg-[#F5F5F5] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: row.color, boxShadow: `${row.color}66 0 0 6px` }}
        />
        {renaming ? (
          <RenameInput initial={row.label} onCommit={onCommitRename} onCancel={onCancelRename} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{row.label}</span>
        )}
        {!renaming && (
          <>
            <CopyButton text={row.result} label="Copy response" />
            <button
              onClick={onStartRename}
              title="Rename"
              className="nodrag rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onDelete}
              title="Disconnect"
              className="nodrag rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {row.result ? (
        isImage ? (
          <ImageResultPreview url={row.result} filename={`${row.label || row.autoLabel}.jpg`} />
        ) : (
          <div className="flex min-h-[48px] items-center justify-center rounded border border-dashed border-gray-200 bg-white p-3 text-[12px] text-gray-500">
            <span className="block w-full whitespace-pre-wrap break-words text-left">{row.result}</span>
          </div>
        )
      ) : (
        <div className="flex min-h-[48px] items-center justify-center rounded border border-dashed border-gray-200 bg-white p-3 text-[12px] text-gray-400">
          No output yet
        </div>
      )}
    </div>
  );
}

function ImageResultPreview({ url, filename }: { url: string; filename: string }) {
  const [busy, setBusy] = useState(false);

  async function handleDownload() {
    if (busy) return;
    setBusy(true);
    try {
      // Browsers silently ignore the `download` attribute on cross-origin
      // <a> elements unless the response carries Content-Disposition. Fetch
      // the asset into a Blob ourselves, hand it to a synthetic click, and
      // we get a real save dialog regardless of origin (Transloadit CDN
      // serves CORS-friendly headers).
      let href: string;
      let revoke = false;
      if (url.startsWith("data:")) {
        href = url;
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const blob = await res.blob();
        href = URL.createObjectURL(blob);
        revoke = true;
      }
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (revoke) URL.revokeObjectURL(href);
    } catch {
      // CORS-rejected or network error — fall back to opening the file
      // in a new tab so the user can still grab it manually.
      window.open(url, "_blank", "noreferrer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative overflow-hidden rounded border border-gray-200 bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="cropped result"
        className="block max-h-56 w-full object-contain"
      />
      <button
        type="button"
        onClick={handleDownload}
        disabled={busy}
        title={busy ? "Preparing download…" : "Download"}
        className="nodrag absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-600 shadow-sm transition-colors hover:border-workflow-accent-400 hover:bg-workflow-accent-50 hover:text-workflow-accent-600 disabled:cursor-progress"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function looksLikeImageUrl(v: string): boolean {
  if (v.startsWith("data:image/")) return true;
  // Strip query so .png?sig=... still matches.
  const path = v.split("?")[0];
  return /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(path);
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
      className="nodrag h-6 min-w-0 flex-1 rounded border border-gray-200 bg-white px-1.5 text-sm font-medium text-gray-900 outline-none focus:border-workflow-accent-400"
    />
  );
}
