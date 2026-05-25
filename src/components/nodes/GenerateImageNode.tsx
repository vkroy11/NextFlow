"use client";

import { useState, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { ChevronDown, ChevronRight, Image as ImageIcon, Loader2, Settings as SettingsIcon, Sparkles, Upload, X } from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { colorForHandle } from "@/lib/handleColors";
import { isHandleConnected, resolveConnectedValue } from "@/lib/connectedValues";
import { uploadFile as uploadToCdn } from "@/lib/uploadFile";
import { useWorkflowRun } from "../canvas/RunContext";
import { MediaModal } from "./MediaModal";
import { cn } from "@/lib/utils";

type FileVal = { url: string; name?: string };

type Data = {
  model?: string;
  prompt?: string;
  systemPrompt?: string;
  aspectRatio?: string;
  inputUrl?: string | null;
  outputUrl?: string | null;
  inputFile?: FileVal | null;
  seed?: number;
  temperature?: number;
};

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

function Collapsible({
  label,
  open,
  onToggle,
  children,
  icon,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="nodrag flex w-full items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-900"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {icon}
        {label}
      </button>
      {open && <div className="mt-2 space-y-3">{children}</div>}
    </div>
  );
}

export function GenerateImageNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const { triggerRun } = useWorkflowRun();
  const pushToast = useWorkflowStore((s) => s.pushToast);
  const runStatus = useWorkflowStore((s) => s.runStatus[id]);
  const [uploading, setUploading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const promptConnected = isHandleConnected(edges, id, "prompt");
  const systemConnected = isHandleConnected(edges, id, "system_prompt");
  const inputConnected = isHandleConnected(edges, id, "input");

  const upstreamPrompt = resolveConnectedValue(nodes, edges, id, "prompt");
  const upstreamSystem = resolveConnectedValue(nodes, edges, id, "system_prompt");
  const upstreamInput = resolveConnectedValue(nodes, edges, id, "input");

  const promptValue =
    promptConnected && typeof upstreamPrompt === "string" ? upstreamPrompt : data?.prompt ?? "";
  const systemValue =
    systemConnected && typeof upstreamSystem === "string" ? upstreamSystem : data?.systemPrompt ?? "";

  function pickUrl(v: unknown): string | null {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && "url" in v) return (v as { url: string }).url;
    return null;
  }

  const inputImageUrl = inputConnected
    ? pickUrl(upstreamInput)
    : data?.inputFile?.url ?? data?.inputUrl ?? null;

  const isEditMode = !!inputImageUrl;
  const isRunning = runStatus === "running";

  async function uploadInputImage(file: File) {
    setUploading(true);
    try {
      const { url, name } = await uploadToCdn(file);
      updateNodeData(id, { inputFile: { url, name }, inputUrl: url });
    } catch (err) {
      pushToast(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
    <NodeShell
      id={id}
      title={isEditMode ? "Edit Image" : "Generate Image"}
      tooltip="Generate or edit an image using Gemini image generation. Connect an input image to switch to edit mode."
      selected={selected}
      onRun={() => triggerRun("SINGLE", [id])}
      headerLeft={<Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-500" />}
    >
      <div className="space-y-4">
        {/* Prompt */}
        <div className="relative">
          <Handle
            id="prompt"
            type="target"
            position={Position.Left}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              left: -22,
              top: 12,
              transform: "translateY(-50%)",
              background: colorForHandle("prompt"),
              borderColor: colorForHandle("prompt"),
              boxShadow: `${colorForHandle("prompt")}50 0 0 8px`,
            }}
          />
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-900">
              Prompt <span className="text-red-500">*</span>
            </span>
            {promptConnected && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700">
                Linked
              </span>
            )}
          </div>
          <textarea
            value={promptValue}
            disabled={promptConnected}
            onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
            placeholder={isEditMode ? "Describe the changes to make..." : "Describe the image to generate..."}
            rows={3}
            className={cn(
              "nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white",
              promptConnected && "cursor-not-allowed bg-gray-50 text-gray-400",
            )}
          />
        </div>

        {/* System prompt */}
        <div className="relative">
          <Handle
            id="system_prompt"
            type="target"
            position={Position.Left}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              left: -22,
              top: 12,
              transform: "translateY(-50%)",
              background: colorForHandle("prompt"),
              borderColor: colorForHandle("prompt"),
              boxShadow: `${colorForHandle("prompt")}50 0 0 8px`,
            }}
          />
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-900">System Prompt</span>
            <span className="text-[10px] text-gray-400">optional</span>
            {systemConnected && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700">
                Linked
              </span>
            )}
          </div>
          <textarea
            value={systemValue}
            disabled={systemConnected}
            onChange={(e) => updateNodeData(id, { systemPrompt: e.target.value })}
            placeholder="You are a creative art director..."
            rows={2}
            className={cn(
              "nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white",
              systemConnected && "cursor-not-allowed bg-gray-50 text-gray-400",
            )}
          />
        </div>

        {/* Input image (optional — triggers edit mode) */}
        <div className="relative">
          <Handle
            id="input"
            type="target"
            position={Position.Left}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              left: -22,
              top: "50%",
              transform: "translateY(-50%)",
              background: colorForHandle("image"),
              borderColor: colorForHandle("image"),
              boxShadow: `${colorForHandle("image")}50 0 0 8px`,
            }}
          />
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-900">Input Image</span>
            <span className="text-[10px] text-gray-400">optional — activates edit mode</span>
          </div>
          {inputConnected ? (
            <div className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-400">
              <ImageIcon className="h-3.5 w-3.5" /> Connected
            </div>
          ) : (
            <label
              className={cn(
                "nodrag inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-500",
                uploading ? "cursor-progress opacity-80" : "cursor-pointer hover:bg-gray-50",
              )}
            >
              <input
                type="file"
                accept="image/*"
                disabled={uploading}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadInputImage(f);
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
                  <Upload className="h-3.5 w-3.5" />
                  {inputImageUrl ? "Change image" : "Upload image"}
                </>
              )}
            </label>
          )}
          {inputImageUrl && !inputConnected && (
            <div className="relative mt-2 overflow-hidden rounded-lg border border-gray-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={inputImageUrl} alt="input" className="block max-h-32 w-full object-cover" />
              <button
                onClick={() => updateNodeData(id, { inputFile: null, inputUrl: null })}
                className="nodrag absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-600 shadow-sm hover:border-red-300 hover:bg-red-50 hover:text-red-500"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>

        {/* Aspect ratio */}
        <div>
          <span className="mb-1.5 block text-xs font-medium text-gray-700">Aspect Ratio</span>
          <div className="flex flex-wrap gap-1.5">
            {ASPECT_RATIOS.map((ar) => (
              <button
                key={ar}
                onClick={() => updateNodeData(id, { aspectRatio: ar })}
                className={cn(
                  "nodrag rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  (data?.aspectRatio ?? "1:1") === ar
                    ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50",
                )}
              >
                {ar}
              </button>
            ))}
          </div>
        </div>

        {/* Settings */}
        <Collapsible
          label="Settings"
          icon={<SettingsIcon className="h-3.5 w-3.5" />}
          open={showSettings}
          onToggle={() => setShowSettings((v) => !v)}
        >
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-600">Seed</span>
            <input
              type="number"
              min={0}
              step={1}
              value={data?.seed ?? ""}
              onChange={(e) =>
                updateNodeData(id, {
                  seed: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              placeholder="random"
              className="nodrag w-full rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-1.5 text-[12px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-600">
              Temperature ({data?.temperature ?? 1.0})
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={data?.temperature ?? 1.0}
              onChange={(e) => updateNodeData(id, { temperature: Number(e.target.value) })}
              className="nodrag h-1 cursor-pointer appearance-none rounded-full bg-gray-200 accent-workflow-accent-500"
            />
          </label>
        </Collapsible>

        {/* Output image */}
        <div className="relative">
          <span className="mb-1.5 block text-xs font-medium text-gray-900">Output Image</span>
          <Handle
            id="output"
            type="source"
            position={Position.Right}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              right: -22,
              top: "50%",
              transform: "translateY(-50%)",
              background: colorForHandle("image"),
              borderColor: colorForHandle("image"),
              boxShadow: `${colorForHandle("image")}50 0 0 8px`,
            }}
          />
          {isRunning ? (
            <div className="flex h-16 items-center justify-center gap-2 rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-indigo-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generating image…
            </div>
          ) : data?.outputUrl ? (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={data.outputUrl}
                alt="generated"
                onClick={() => setModalOpen(true)}
                className="nodrag block max-h-56 w-full cursor-zoom-in object-contain"
              />
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-gray-400">
              No output yet
            </div>
          )}
        </div>
      </div>
    </NodeShell>
      {modalOpen && data?.outputUrl && (
        <MediaModal url={data.outputUrl} type="image" onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
