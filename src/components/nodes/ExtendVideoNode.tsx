"use client";

import { useState, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Settings as SettingsIcon, Upload, Video as VideoIcon } from "lucide-react";
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
  inputVideoFile?: FileVal | null;
  inputVideoUrl?: string | null;
  outputUrl?: string | null;
  durationSeconds?: number;
  aspectRatio?: string;
  negativePrompt?: string;
  seed?: number;
  fps?: number;
  resolution?: string;
  generateAudio?: boolean;
  enhancePrompt?: boolean;
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

export function ExtendVideoNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const { triggerRun } = useWorkflowRun();
  const pushToast = useWorkflowStore((s) => s.pushToast);
  const runStatus = useWorkflowStore((s) => s.runStatus[id]);
  const [uploading, setUploading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const videoConnected = isHandleConnected(edges, id, "video-input");
  const promptConnected = isHandleConnected(edges, id, "prompt");

  const upstreamVideo = resolveConnectedValue(nodes, edges, id, "video-input");
  const upstreamPrompt = resolveConnectedValue(nodes, edges, id, "prompt");

  function pickUrl(v: unknown): string | null {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && "url" in v) return (v as { url: string }).url;
    return null;
  }

  const videoUrl = videoConnected
    ? pickUrl(upstreamVideo)
    : data?.inputVideoFile?.url ?? data?.inputVideoUrl ?? null;

  const promptValue =
    promptConnected && typeof upstreamPrompt === "string"
      ? upstreamPrompt
      : data?.prompt ?? "";

  const hasVideo = !!videoUrl;
  const isRunning = runStatus === "running";

  async function uploadVideo(file: File) {
    setUploading(true);
    try {
      const { url, name } = await uploadToCdn(file);
      updateNodeData(id, { inputVideoFile: { url, name }, inputVideoUrl: url });
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
      title="Extend Video"
      tooltip="Extend an existing video using Veo 3.1's continuation feature. Connect the output of a Generate Video or Extend Video node."
      selected={selected}
      onRun={() => triggerRun("SINGLE", [id])}
      headerLeft={<VideoIcon className="h-3.5 w-3.5 shrink-0 text-violet-500" />}
    >
      <div className="space-y-4">
        {/* Video input (required) */}
        <div className="relative">
          <Handle
            id="video-input"
            type="target"
            position={Position.Left}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              left: -22,
              top: "50%",
              transform: "translateY(-50%)",
              background: colorForHandle("video"),
              borderColor: colorForHandle("video"),
              boxShadow: `${colorForHandle("video")}50 0 0 8px`,
            }}
          />
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-900">
              Input Video <span className="text-red-500">*</span>
            </span>
            {videoConnected && (
              <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-violet-700">
                Linked
              </span>
            )}
          </div>
          {videoConnected ? (
            <div className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-400">
              <VideoIcon className="h-3.5 w-3.5" /> Connected
            </div>
          ) : hasVideo ? (
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
              <VideoIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">
                {data?.inputVideoFile?.name ?? "video uploaded"}
              </span>
              <button
                onClick={() => updateNodeData(id, { inputVideoFile: null, inputVideoUrl: null })}
                className="nodrag shrink-0 text-gray-400 hover:text-red-500"
                title="Remove"
              >
                ×
              </button>
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
                accept="video/*"
                disabled={uploading}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadVideo(f);
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
                  Upload video
                </>
              )}
            </label>
          )}
          {!hasVideo && !videoConnected && (
            <p className="mt-1 text-[10px] text-red-500">Video input is required</p>
          )}
        </div>

        {/* Optional continuation prompt */}
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
            <span className="text-xs font-medium text-gray-900">Continuation Prompt</span>
            <span className="text-[10px] text-gray-400">optional</span>
          </div>
          <textarea
            value={promptValue}
            disabled={promptConnected}
            onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
            placeholder="Describe how the video should continue..."
            rows={2}
            className={cn(
              "nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white",
              promptConnected && "cursor-not-allowed bg-gray-50 text-gray-400",
            )}
          />
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
                      ? "border-violet-400 bg-violet-50 text-violet-700"
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
                      ? "border-violet-400 bg-violet-50 text-violet-700"
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
              placeholder="What to avoid in the extension..."
              rows={2}
              className="nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-1.5 text-[12px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
            />
          </label>
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
          <div className="flex gap-3">
            <div className="flex-1">
              <span className="mb-1 block text-[11px] font-medium text-gray-600">FPS</span>
              <div className="flex gap-1">
                {([24, 30] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => updateNodeData(id, { fps: data?.fps === f ? undefined : f })}
                    className={cn(
                      "nodrag rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                      data?.fps === f
                        ? "border-violet-400 bg-violet-50 text-violet-700"
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300",
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <span className="mb-1 block text-[11px] font-medium text-gray-600">Resolution</span>
              <div className="flex gap-1">
                {(["720p", "1080p"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => updateNodeData(id, { resolution: data?.resolution === r ? undefined : r })}
                    className={cn(
                      "nodrag rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                      data?.resolution === r
                        ? "border-violet-400 bg-violet-50 text-violet-700"
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300",
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="nodrag flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={data?.generateAudio ?? false}
                onChange={(e) => updateNodeData(id, { generateAudio: e.target.checked })}
                className="rounded accent-violet-500"
              />
              <span className="text-[11px] font-medium text-gray-600">Generate Audio</span>
            </label>
            <label className="nodrag flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={data?.enhancePrompt ?? false}
                onChange={(e) => updateNodeData(id, { enhancePrompt: e.target.checked })}
                className="rounded accent-violet-500"
              />
              <span className="text-[11px] font-medium text-gray-600">Enhance Prompt</span>
            </label>
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
          <span className="mb-1.5 block text-xs font-medium text-gray-900">Extended Video</span>
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
            <div className="flex h-16 items-center justify-center gap-2 rounded-lg border border-gray-100 bg-[#FAFAFA] text-[12px] text-violet-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Extending video…
            </div>
          ) : data?.outputUrl ? (
            <div className="overflow-hidden rounded-lg border border-violet-200 bg-violet-50">
              <video
                src={data.outputUrl}
                className="nodrag block max-h-40 w-full cursor-pointer object-contain"
                onClick={() => setModalOpen(true)}
                muted
                playsInline
              />
              <div className="flex items-center gap-1 border-t border-violet-100 px-2 py-1.5">
                <button
                  onClick={() => setModalOpen(true)}
                  className="nodrag flex flex-1 items-center gap-1.5 text-[11px] font-medium text-violet-700 hover:text-violet-900"
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
