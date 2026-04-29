"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { Coins, Image as ImageIcon, Loader2, Plus, Minus, RotateCcw, X } from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { colorForHandle } from "@/lib/handleColors";
import { isHandleConnected, resolveConnectedValue } from "@/lib/connectedValues";
import { uploadFile as uploadToCdn } from "@/lib/uploadFile";
import { useWorkflowRun } from "../canvas/RunContext";
import { cn } from "@/lib/utils";

type Data = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  inputUrl?: string | null;
  outputUrl?: string | null;
};

const FIELD_DEFS = [
  { key: "x", label: "X Position (%)", default: 0, min: 0, max: 100 },
  { key: "y", label: "Y Position (%)", default: 0, min: 0, max: 100 },
  { key: "w", label: "Width (%)", default: 100, min: 1, max: 100 },
  { key: "h", label: "Height (%)", default: 100, min: 1, max: 100 },
] as const;

export function CropImageNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const { triggerRun } = useWorkflowRun();

  // Pull upstream-connected values reactively. When edges/source-data change,
  // these selectors return new primitives and the node re-renders.
  const inputConnected = useWorkflowStore((s) => isHandleConnected(s.edges, id, "input"));
  const upstreamInput = useWorkflowStore((s) => resolveConnectedValue(s.nodes, s.edges, id, "input")) as
    | string
    | undefined;

  const xConnected = useWorkflowStore((s) => isHandleConnected(s.edges, id, "x"));
  const yConnected = useWorkflowStore((s) => isHandleConnected(s.edges, id, "y"));
  const wConnected = useWorkflowStore((s) => isHandleConnected(s.edges, id, "w"));
  const hConnected = useWorkflowStore((s) => isHandleConnected(s.edges, id, "h"));
  const upstreamX = useWorkflowStore((s) => resolveConnectedValue(s.nodes, s.edges, id, "x"));
  const upstreamY = useWorkflowStore((s) => resolveConnectedValue(s.nodes, s.edges, id, "y"));
  const upstreamW = useWorkflowStore((s) => resolveConnectedValue(s.nodes, s.edges, id, "w"));
  const upstreamH = useWorkflowStore((s) => resolveConnectedValue(s.nodes, s.edges, id, "h"));

  const connectedMap: Record<string, boolean> = { x: xConnected, y: yConnected, w: wConnected, h: hConnected };
  const upstreamMap: Record<string, unknown> = { x: upstreamX, y: upstreamY, w: upstreamW, h: upstreamH };

  const localValue = (k: keyof Data): number | undefined =>
    typeof data?.[k] === "number" ? (data?.[k] as number) : undefined;

  // Effective values displayed/used: upstream when connected, local otherwise.
  const eff = (k: "x" | "y" | "w" | "h", def: number) => {
    if (connectedMap[k]) {
      const u = upstreamMap[k];
      const num = typeof u === "number" ? u : Number(u);
      return Number.isFinite(num) ? num : def;
    }
    return localValue(k) ?? def;
  };

  const x = eff("x", 0);
  const y = eff("y", 0);
  const w = eff("w", 100);
  const h = eff("h", 100);

  // Image url priority: upstream connected → local data.inputUrl
  const imageUrl = inputConnected ? upstreamInput ?? null : data?.inputUrl ?? null;

  const pushToast = useWorkflowStore((s) => s.pushToast);
  const [uploading, setUploading] = useState(false);

  async function uploadInputImage(file: File) {
    setUploading(true);
    try {
      const { url } = await uploadToCdn(file);
      updateNodeData(id, { inputUrl: url });
    } catch (err) {
      pushToast(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <NodeShell
      id={id}
      title="Crop Image"
      tooltip="Crop an image to specified dimensions"
      selected={selected}
      onRun={() => triggerRun("SINGLE", [id])}
    >
      <div className="space-y-4">
        {/* Input Image row + upload box */}
        <div className="relative">
          <Handle
            id="input"
            type="target"
            position={Position.Left}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              left: -22,
              top: 12,
              transform: "translateY(-50%)",
              background: colorForHandle("input"),
              borderColor: colorForHandle("input"),
              boxShadow: `${colorForHandle("input")}50 0 0 8px`,
            }}
          />
          <div className="flex items-start justify-between gap-3">
            <span className="mt-1 text-xs font-medium text-gray-900">
              Input Image<span className="text-red-500"> *</span>
            </span>
            {inputConnected ? (
              <div
                title="Connected — change at the source node"
                className="inline-flex flex-1 cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-400"
              >
                <ImageIcon className="h-3.5 w-3.5" /> Change image
              </div>
            ) : (
              <label
                className={cn(
                  "nodrag inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-500",
                  uploading ? "cursor-progress opacity-80" : "cursor-pointer hover:bg-gray-50",
                )}
              >
                <input
                  type="file"
                  accept="image/*"
                  disabled={uploading}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadInputImage(file);
                    e.target.value = "";
                  }}
                />
                {uploading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <ImageIcon className="h-3.5 w-3.5" />
                    {imageUrl ? "Change image" : "Upload image"}
                  </>
                )}
              </label>
            )}
          </div>

          {imageUrl && (
            <div className="mt-3 flex justify-center">
              <div className="relative inline-block max-w-[80%] overflow-hidden rounded-lg border border-gray-200 bg-[#FAFAFA]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt="input"
                  className="block max-h-56 max-w-full object-contain"
                />
                <CropOverlay x={x} y={y} w={w} h={h} />
                {!inputConnected && (
                  <button
                    onClick={() => updateNodeData(id, { inputUrl: null })}
                    title="Remove"
                    className="nodrag absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-600 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-500"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {FIELD_DEFS.map((f) => {
          const isConnected = connectedMap[f.key];
          const value = eff(f.key, f.default);
          const handleColor = colorForHandle("number");
          return (
            <div key={f.key} className="relative space-y-1.5">
              <Handle
                id={f.key}
                type="target"
                position={Position.Left}
                className="!h-3.5 !w-3.5 !rounded-full !border-2"
                style={{
                  left: -22,
                  top: "calc(50% + 8px)",
                  transform: "translateY(-50%)",
                  background: handleColor,
                  borderColor: handleColor,
                  boxShadow: `${handleColor}50 0 0 8px`,
                  opacity: isConnected ? 1 : 0.85,
                }}
              />
              <div className="flex items-center gap-1.5">
                <span className={cn("text-xs font-medium", isConnected ? "text-gray-500" : "text-gray-900")}>{f.label}</span>
                {isConnected && (
                  <span className="rounded bg-pink-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-pink-600">
                    Linked
                  </span>
                )}
              </div>
              <div className={cn("flex items-center gap-2", isConnected && "opacity-60")}>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  value={value}
                  disabled={isConnected}
                  onChange={(e) => {
                    const raw = e.target.valueAsNumber;
                    const clamped = Number.isFinite(raw) ? Math.max(f.min, Math.min(f.max, raw)) : f.default;
                    updateNodeData(id, { [f.key]: clamped });
                  }}
                  className="nodrag h-1 flex-1 cursor-pointer appearance-none rounded-full bg-gray-200 accent-workflow-accent-500 disabled:cursor-not-allowed"
                />
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  value={value}
                  disabled={isConnected}
                  onChange={(e) => {
                    const raw = e.target.valueAsNumber;
                    const clamped = Number.isFinite(raw) ? Math.max(f.min, Math.min(f.max, raw)) : f.default;
                    updateNodeData(id, { [f.key]: clamped });
                  }}
                  className="nodrag h-7 w-12 rounded-md border border-gray-200 bg-white text-center text-[12px] tabular-nums text-gray-800 outline-none focus:border-workflow-accent-400 disabled:cursor-not-allowed disabled:bg-gray-50"
                />
                <button
                  disabled={isConnected}
                  onClick={() => updateNodeData(id, { [f.key]: f.default })}
                  title="Reset"
                  className="nodrag flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
                <button
                  disabled={isConnected}
                  onClick={() => updateNodeData(id, { [f.key]: Math.max(f.min, value - 1) })}
                  className="nodrag flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <button
                  disabled={isConnected}
                  onClick={() => updateNodeData(id, { [f.key]: Math.min(f.max, value + 1) })}
                  className="nodrag flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}

        {/* Output Image */}
        <div className="relative space-y-2 pt-1">
          <span className="text-xs font-medium text-gray-900">Output Image</span>
          <div className="flex h-24 items-center justify-center rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-gray-400">
            {data?.outputUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.outputUrl}
                alt="cropped output"
                className="block max-h-24 w-full rounded-lg object-contain"
              />
            ) : (
              "No output yet"
            )}
          </div>
          <Handle
            id="output"
            type="source"
            position={Position.Right}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              right: -22,
              top: "calc(50% + 8px)",
              transform: "translateY(-50%)",
              background: colorForHandle("output"),
              borderColor: colorForHandle("output"),
              boxShadow: `${colorForHandle("output")}50 0 0 8px`,
            }}
          />
        </div>
         {/* Cost indicator (placeholder estimate) */}
         <div className="-mb-1 flex items-center justify-end gap-1 text-[11px] tabular-nums text-gray-400">
          <Coins className="h-3 w-3" />
          ~0.005M
        </div>
      </div>
    </NodeShell>
  );
}

function CropOverlay({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  // Clamp to safe ranges so a stray upstream value never paints outside the image.
  const cx = Math.max(0, Math.min(100, x));
  const cy = Math.max(0, Math.min(100, y));
  const cw = Math.max(0, Math.min(100 - cx, w));
  const ch = Math.max(0, Math.min(100 - cy, h));

  return (
    <div className="pointer-events-none absolute inset-0">
      {cy > 0 && <div className="absolute bg-black/45" style={{ top: 0, left: 0, right: 0, height: `${cy}%` }} />}
      {cx > 0 && (
        <div
          className="absolute bg-black/45"
          style={{ top: `${cy}%`, left: 0, width: `${cx}%`, height: `${ch}%` }}
        />
      )}
      {cx + cw < 100 && (
        <div
          className="absolute bg-black/45"
          style={{ top: `${cy}%`, left: `${cx + cw}%`, right: 0, height: `${ch}%` }}
        />
      )}
      {cy + ch < 100 && (
        <div
          className="absolute bg-black/45"
          style={{ top: `${cy + ch}%`, left: 0, right: 0, bottom: 0 }}
        />
      )}
      <div
        className="absolute border-2 border-white/95 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{ left: `${cx}%`, top: `${cy}%`, width: `${cw}%`, height: `${ch}%` }}
      />
    </div>
  );
}
