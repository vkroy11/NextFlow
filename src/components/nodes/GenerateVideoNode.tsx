"use client";

import { useState, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { ChevronDown, ChevronRight, ExternalLink, Image as ImageIcon, Loader2, Settings as SettingsIcon, Upload, Video as VideoIcon, X } from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { colorForHandle } from "@/lib/handleColors";
import { isHandleConnected, resolveAllConnectedImageUrls, resolveConnectedValue } from "@/lib/connectedValues";
import { uploadFile as uploadToCdn } from "@/lib/uploadFile";
import { useWorkflowRun } from "../canvas/RunContext";
import { MediaModal } from "./MediaModal";
import { cn } from "@/lib/utils";

type FileVal = { url: string; name?: string };

type Data = {
  model?: string;
  prompt?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  inputFile?: FileVal | null;
  inputUrl?: string | null;
  outputUrl?: string | null;
  negativePrompt?: string;
  resolution?: string;
  personGeneration?: string;
};

const DURATIONS = [4, 6, 8] as const;
const ASPECT_RATIOS = ["16:9", "9:16"] as const;
const PERSON_GEN_OPTIONS = [
  { value: "allow_adult", label: "Allow Adults" },
  { value: "allow_all", label: "Allow All" },
  { value: "dont_allow", label: "Don't Allow" },
] as const;

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

export function GenerateVideoNode({ id, data, selected }: NodeProps<Data>) {
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
  const inputConnected = isHandleConnected(edges, id, "image-input");

  const upstreamPrompt = resolveConnectedValue(nodes, edges, id, "prompt");

  const promptValue =
    promptConnected && typeof upstreamPrompt === "string" ? upstreamPrompt : data?.prompt ?? "";

  // Multi-image: up to 3. Slot 1 = start frame (image-to-video), 2-3 = refs.
  const connectedImageUrls = resolveAllConnectedImageUrls(nodes, edges, id, "image-input");
  const imageUrls: string[] = [...connectedImageUrls];
  if (!inputConnected && (data?.inputFile?.url || data?.inputUrl)) {
    imageUrls.push(data.inputFile?.url ?? data.inputUrl ?? "");
  }
  const imageDisplay = imageUrls.slice(0, 3);
  const imagesAtCap = connectedImageUrls.length >= 3;
  const isImageToVideo = imageUrls.length > 0;

  async function uploadStartImage(file: File) {
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

  const isRunning = runStatus === "running";

  return (
    <>
    <NodeShell
      id={id}
      title="Generate Video"
      tooltip="Generate a video from text using Veo 3.1. Optionally connect an image to use as the starting frame (image-to-video)."
      selected={selected}
      onRun={() => triggerRun("SINGLE", [id])}
      headerLeft={<VideoIcon className="h-3.5 w-3.5 shrink-0 text-indigo-500" />}
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
            placeholder="Describe the video to generate..."
            rows={3}
            className={cn(
              "nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white",
              promptConnected && "cursor-not-allowed bg-gray-50 text-gray-400",
            )}
          />
        </div>

        {/* Start image (optional — image-to-video) */}
        <div className="relative">
          <Handle
            id="image-input"
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
            <span className="text-xs font-medium text-gray-900">Input Images</span>
            <span className="text-[10px] text-gray-400">optional — slot 1 = start, 2-3 = refs</span>
          </div>
          {imagesAtCap ? (
            <div className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-400">
              <ImageIcon className="h-3.5 w-3.5" /> 3 connected
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
                  if (f) uploadStartImage(f);
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
                  {data?.inputFile?.url || data?.inputUrl ? "Change image" : "Upload start image"}
                </>
              )}
            </label>
          )}
          {imageDisplay.length > 0 && (
            <div className="mt-2 flex items-center justify-end gap-2">
              {imageDisplay.map((url, i) => {
                const isLocalSlot =
                  !inputConnected &&
                  !!(data?.inputFile?.url || data?.inputUrl) &&
                  url === (data?.inputFile?.url ?? data?.inputUrl);
                return (
                  <div
                    key={`${url.slice(0, 32)}-${i}`}
                    className="relative h-16 w-16 overflow-hidden rounded-lg border border-gray-200 bg-[#FAFAFA]"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`input ${i + 1}`} className="block h-full w-full object-cover" />
                    {isLocalSlot && (
                      <button
                        onClick={() => updateNodeData(id, { inputFile: null, inputUrl: null })}
                        title="Remove"
                        className="nodrag absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-600 shadow-sm hover:border-red-300 hover:bg-red-50 hover:text-red-500"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
              <span className="text-[10px] text-gray-400 tabular-nums">{imageDisplay.length}/3</span>
            </div>
          )}
          {isImageToVideo && (
            <p className="mt-1 text-[10px] text-indigo-600">
              {imageUrls.length > 1 ? "Image-to-video + references" : "Image-to-video mode"}
            </p>
          )}
        </div>

        {/* Duration + Aspect */}
        <div className="flex items-center gap-4">
          <div>
            <span className="mb-1 block text-xs font-medium text-gray-700">Duration</span>
            <div className="flex gap-1">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => updateNodeData(id, { durationSeconds: d })}
                  className={cn(
                    "nodrag rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                    (data?.durationSeconds ?? 6) === d
                      ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 bg-white text-gray-600 hover:border-gray-300",
                  )}
                >
                  {d}s
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-gray-700">Aspect</span>
            <div className="flex gap-1">
              {ASPECT_RATIOS.map((ar) => (
                <button
                  key={ar}
                  onClick={() => updateNodeData(id, { aspectRatio: ar })}
                  className={cn(
                    "nodrag rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                    (data?.aspectRatio ?? "16:9") === ar
                      ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 bg-white text-gray-600 hover:border-gray-300",
                  )}
                >
                  {ar}
                </button>
              ))}
            </div>
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
            <span className="text-[11px] font-medium text-gray-600">Negative Prompt</span>
            <textarea
              value={data?.negativePrompt ?? ""}
              onChange={(e) => updateNodeData(id, { negativePrompt: e.target.value || undefined })}
              placeholder="What to avoid in the video..."
              rows={2}
              className="nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-1.5 text-[12px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
            />
          </label>
          <div>
            <span className="mb-1 block text-[11px] font-medium text-gray-600">Resolution</span>
            <div className="flex gap-1">
              {(["720p", "1080p"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => updateNodeData(id, { resolution: data?.resolution === r ? undefined : r })}
                  className={cn(
                    "nodrag rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                    data?.resolution === r
                      ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 bg-white text-gray-600 hover:border-gray-300",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-600">Person Generation</span>
            <select
              value={data?.personGeneration ?? ""}
              onChange={(e) =>
                updateNodeData(id, { personGeneration: e.target.value || undefined })
              }
              className="nodrag rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-1.5 text-[12px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
            >
              <option value="">Default</option>
              {PERSON_GEN_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </Collapsible>

        {/* Output */}
        <div className="relative">
          <span className="mb-1.5 block text-xs font-medium text-gray-900">Output Video</span>
          <Handle
            id="video-output"
            type="source"
            position={Position.Right}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              right: -22,
              top: "50%",
              transform: "translateY(-50%)",
              background: colorForHandle("video"),
              borderColor: colorForHandle("video"),
              boxShadow: `${colorForHandle("video")}50 0 0 8px`,
            }}
          />
          {isRunning ? (
            <div className="flex h-16 items-center justify-center gap-2 rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-indigo-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generating video…
            </div>
          ) : data?.outputUrl ? (
            <div className="overflow-hidden rounded-lg border border-indigo-200 bg-indigo-50">
              <video
                src={data.outputUrl}
                className="nodrag block max-h-40 w-full cursor-pointer object-contain"
                onClick={() => setModalOpen(true)}
                muted
                playsInline
              />
              <div className="flex items-center gap-1 border-t border-indigo-100 px-2 py-1.5">
                <button
                  onClick={() => setModalOpen(true)}
                  className="nodrag flex flex-1 items-center gap-1.5 text-[11px] font-medium text-indigo-700 hover:text-indigo-900"
                >
                  <ExternalLink className="h-3 w-3" />
                  View &amp; Download
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-16 items-center justify-center rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-gray-400">
              No output yet
            </div>
          )}
        </div>
      </div>
    </NodeShell>
      {modalOpen && data?.outputUrl && (
        <MediaModal url={data.outputUrl} type="video" onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
