"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  FileIcon,
  Loader2,
  Maximize2,
  Music2,
  Plus,
  Settings as SettingsIcon,
  Upload,
  Video as VideoIcon,
  X,
  Image as ImageIcon,
} from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { colorForHandle } from "@/lib/handleColors";
import {
  isHandleConnected,
  resolveAllConnectedImageUrls,
  resolveConnectedValue,
} from "@/lib/connectedValues";
import { uploadFile as uploadToCdn } from "@/lib/uploadFile";
import { CopyButton } from "@/components/CopyButton";
import { useWorkflowRun } from "../canvas/RunContext";
import { cn } from "@/lib/utils";

type FileVal = { url: string; name?: string };

type Data = {
  model?: string;
  prompt?: string;
  systemPrompt?: string;
  temperature?: number;
  response?: string | null;
  vision?: FileVal | null;
  videoFile?: FileVal | null;
  audio?: FileVal | null;
  file?: FileVal | null;
};

const MODEL_LABELS: Record<string, string> = {
  // Gemini 3 family — currently published as -preview on v1beta.
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
  // Stable 2.5 family.
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  // Legacy fictional ids — same labels so previously-saved nodes still title
  // correctly even before the alias kicks in at runtime.
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.1-flash": "Gemini 3 Flash",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
};

// What kind of Request-Inputs field does each handle map to when the user
// hits "+ Add to Request"?
const HANDLE_FIELD_TYPE: Record<string, "text" | "image" | "video" | "audio" | "file"> = {
  prompt: "text",
  system_prompt: "text",
  vision: "image",
  video: "video",
  audio: "audio",
  file: "file",
};

type RequestField = { key: string; label: string; type: string; value: unknown };

const TYPE_DEFAULT_VALUE: Record<string, unknown> = {
  text: "",
  number: 0,
  boolean: false,
  image: null,
  audio: null,
  video: null,
  file: null,
};

export function Gemini31ProNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onConnect = useWorkflowStore((s) => s.onConnect);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const { triggerRun } = useWorkflowRun();

  const [showSettings, setShowSettings] = useState(false);
  const [expandedField, setExpandedField] = useState<"prompt" | "system_prompt" | null>(null);

  const model = data?.model ?? "gemini-3.1-pro";
  const modelLabel = MODEL_LABELS[model] ?? model;

  // ---- Connected-state per handle (live from the store)
  const promptConnected = isHandleConnected(edges, id, "prompt");
  const systemConnected = isHandleConnected(edges, id, "system_prompt");
  const visionConnected = isHandleConnected(edges, id, "vision");
  const videoConnected = isHandleConnected(edges, id, "video");
  const audioConnected = isHandleConnected(edges, id, "audio");
  const fileConnected = isHandleConnected(edges, id, "file");

  // ---- Effective values (upstream takes priority when connected)
  const upstreamPrompt = resolveConnectedValue(nodes, edges, id, "prompt");
  const upstreamSystem = resolveConnectedValue(nodes, edges, id, "system_prompt");
  const upstreamVideo = resolveConnectedValue(nodes, edges, id, "video");
  const upstreamAudio = resolveConnectedValue(nodes, edges, id, "audio");
  const upstreamFile = resolveConnectedValue(nodes, edges, id, "file");

  const promptValue =
    promptConnected && typeof upstreamPrompt === "string" ? upstreamPrompt : data?.prompt ?? "";
  const systemValue =
    systemConnected && typeof upstreamSystem === "string" ? upstreamSystem : data?.systemPrompt ?? "";

  function pickUpstreamUrl(v: unknown): string | null {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && "url" in v) return (v as { url: string }).url;
    return null;
  }

  // Vision is fan-in (up to 3): collect every connected image URL plus the
  // local upload as the last slot, capped at 3 total previews.
  const connectedVisionUrls = resolveAllConnectedImageUrls(nodes, edges, id, "vision");
  const visionUrls: string[] = [...connectedVisionUrls];
  if (!visionConnected && data?.vision?.url) visionUrls.push(data.vision.url);
  const visionDisplay = visionUrls.slice(0, 3);
  const visionAtCap = connectedVisionUrls.length >= 3;
  const videoUrl = videoConnected ? pickUpstreamUrl(upstreamVideo) : data?.videoFile?.url ?? null;
  const audioUrl = audioConnected ? pickUpstreamUrl(upstreamAudio) : data?.audio?.url ?? null;
  const fileUrl = fileConnected ? pickUpstreamUrl(upstreamFile) : data?.file?.url ?? null;

  const pushToast = useWorkflowStore((s) => s.pushToast);

  async function uploadFile(file: File, dataKey: keyof Data) {
    try {
      const { url, name } = await uploadToCdn(file);
      updateNodeData(id, { [dataKey]: { url, name } });
    } catch (err) {
      pushToast(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  // "+ Add to Request" — append a typed field to the workflow's Request-Inputs
  // node and immediately wire it to this Gemini's specific handle. After the
  // edge lands the local input is automatically blocked because the
  // *connected* selectors above flip to true.
  function addToRequest(targetHandle: string) {
    const fieldType = HANDLE_FIELD_TYPE[targetHandle];
    if (!fieldType) return;
    const requestNode = nodes.find((n) => n.type === "requestInputs");
    if (!requestNode) return;
    const existing = (requestNode.data?.fields as RequestField[] | undefined) ?? [];
    const base = `${fieldType}_field`;
    let key = base;
    let i = 2;
    while (existing.some((f) => f.key === key)) {
      key = `${base}_${i++}`;
    }
    const next: RequestField = {
      key,
      label: key,
      type: fieldType,
      value: TYPE_DEFAULT_VALUE[fieldType] ?? null,
    };
    updateNodeData(requestNode.id, { fields: [...existing, next] });
    onConnect({
      source: requestNode.id,
      sourceHandle: key,
      target: id,
      targetHandle,
    });
  }

  return (
    <NodeShell
      id={id}
      title={modelLabel}
      tooltip="Google Gemini multimodal LLM. Supports text, images, video, audio."
      selected={selected}
      onRun={() => triggerRun("SINGLE", [id])}
    >
      <div className="space-y-4">
        <PromptRow
          handleId="prompt"
          label="Prompt"
          required
          connected={promptConnected}
          value={promptValue}
          placeholder="Enter your prompt..."
          onChange={(v) => updateNodeData(id, { prompt: v })}
          onAddToRequest={() => addToRequest("prompt")}
          onExpand={() => setExpandedField("prompt")}
        />

        <PromptRow
          handleId="system_prompt"
          label="System Prompt"
          connected={systemConnected}
          value={systemValue}
          placeholder="You are a helpful assistant..."
          onChange={(v) => updateNodeData(id, { systemPrompt: v })}
          onAddToRequest={() => addToRequest("system_prompt")}
          onExpand={() => setExpandedField("system_prompt")}
        />

        <VisionRow
          previews={visionDisplay}
          atCap={visionAtCap}
          localValue={data?.vision ?? null}
          // No upstream connection means the user can use the local upload
          // slot as the (only) image. As soon as anything is wired in we lock
          // the local upload to avoid double-feeding the model.
          uploadDisabled={visionConnected}
          onUpload={(f) => uploadFile(f, "vision")}
          onClear={() => updateNodeData(id, { vision: null })}
          onAddToRequest={() => addToRequest("vision")}
        />

        <UploadRow
          handleId="video"
          label="Video"
          accept="video/*"
          icon={<VideoIcon className="h-3.5 w-3.5" />}
          uploadLabel="Upload video"
          connected={videoConnected}
          previewUrl={videoUrl}
          previewName={data?.videoFile?.name}
          onUpload={(f) => uploadFile(f, "videoFile")}
          onClear={() => updateNodeData(id, { videoFile: null })}
          onAddToRequest={() => addToRequest("video")}
        />

        <UploadRow
          handleId="audio"
          label="Audio"
          accept="audio/*"
          icon={<Music2 className="h-3.5 w-3.5" />}
          uploadLabel="Upload audio"
          connected={audioConnected}
          previewUrl={audioUrl}
          previewName={data?.audio?.name}
          onUpload={(f) => uploadFile(f, "audio")}
          onClear={() => updateNodeData(id, { audio: null })}
          onAddToRequest={() => addToRequest("audio")}
        />

        <UploadRow
          handleId="file"
          label="File"
          accept="*/*"
          icon={<FileIcon className="h-3.5 w-3.5" />}
          uploadLabel="Upload file"
          connected={fileConnected}
          previewUrl={fileUrl}
          previewName={data?.file?.name}
          onUpload={(f) => uploadFile(f, "file")}
          onClear={() => updateNodeData(id, { file: null })}
          onAddToRequest={() => addToRequest("file")}
        />

        <Collapsible
          label="Settings"
          icon={<SettingsIcon className="h-3.5 w-3.5" />}
          open={showSettings}
          onToggle={() => setShowSettings((v) => !v)}
        >
          <label className="flex flex-col gap-1 text-[12px] font-medium text-gray-700">
            <span className="text-xs text-gray-500">Temperature ({data?.temperature ?? 0.7})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={data?.temperature ?? 0.7}
              onChange={(e) => updateNodeData(id, { temperature: Number(e.target.value) })}
              className="nodrag h-1 cursor-pointer appearance-none rounded-full bg-gray-200 accent-workflow-accent-500"
            />
          </label>
        </Collapsible>

        {/* Response section with output handle on right edge */}
        <div className="relative">
          <span className="text-xs font-medium text-gray-900">Response</span>
          <Handle
            id="response"
            type="source"
            position={Position.Right}
            className="!h-3.5 !w-3.5 !rounded-full !border-2"
            style={{
              right: -22,
              top: 9,
              transform: "translateY(-50%)",
              background: colorForHandle("response"),
              borderColor: colorForHandle("response"),
              boxShadow: `${colorForHandle("response")}50 0 0 8px`,
            }}
          />
          <div className="relative mt-1.5">
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-gray-100 bg-[#FAFAFA] p-3 pr-9 text-[12px] leading-relaxed text-gray-700">
              {data?.response ?? <span className="text-gray-400">No output yet</span>}
            </div>
            {/* Copy floats over the top-right of the response box. The pr-9
             *  on the inner div above reserves space so long lines don't
             *  slide under the icon. */}
            <CopyButton
              text={data?.response ?? null}
              label="Copy response"
              className="absolute right-1.5 top-1.5 bg-white/80 backdrop-blur-sm"
            />
          </div>
        </div>

        {/* Cost indicator (placeholder estimate) */}
        <div className="-mb-1 flex items-center justify-end gap-1 text-[11px] tabular-nums text-gray-400">
          <Coins className="h-3 w-3" />
          ~0.0001M
        </div>
      </div>

      {expandedField && (
        <ExpandedTextEditor
          label={expandedField === "prompt" ? "Prompt" : "System Prompt"}
          value={expandedField === "prompt" ? promptValue : systemValue}
          readOnly={expandedField === "prompt" ? promptConnected : systemConnected}
          onChange={(v) =>
            updateNodeData(
              id,
              expandedField === "prompt" ? { prompt: v } : { systemPrompt: v },
            )
          }
          onClose={() => setExpandedField(null)}
        />
      )}
    </NodeShell>
  );
}

// --------- sub-components ---------

function PromptRow({
  handleId,
  label,
  required,
  connected,
  value,
  placeholder,
  onChange,
  onAddToRequest,
  onExpand,
}: {
  handleId: string;
  label: string;
  required?: boolean;
  connected: boolean;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onAddToRequest: () => void;
  onExpand: () => void;
}) {
  const handleColor = colorForHandle(handleId);
  return (
    <div className="relative">
      <Handle
        id={handleId}
        type="target"
        position={Position.Left}
        className="!h-3.5 !w-3.5 !rounded-full !border-2"
        style={{
          left: -22,
          top: 8,
          transform: "translateY(-50%)",
          background: handleColor,
          borderColor: handleColor,
          boxShadow: `${handleColor}50 0 0 8px`,
        }}
      />
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-gray-900">
            {label}
            {required && <span className="text-red-500"> *</span>}
          </span>
          {connected && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-700">
              Linked
            </span>
          )}
        </div>
        <PlusAddBtn disabled={connected} onClick={onAddToRequest} />
      </div>
      <div className="relative">
        <textarea
          value={value}
          disabled={connected}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={cn(
            "nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 pr-9 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white",
            connected && "cursor-not-allowed bg-gray-50 text-gray-400",
          )}
        />
        <button
          onClick={onExpand}
          title="Expand"
          className="nodrag absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function VisionRow({
  previews,
  atCap,
  localValue,
  uploadDisabled,
  onUpload,
  onClear,
  onAddToRequest,
}: {
  previews: string[];
  atCap: boolean;
  localValue: FileVal | null;
  uploadDisabled: boolean;
  onUpload: (file: File) => void;
  onClear: () => void;
  onAddToRequest: () => void;
}) {
  const handleColor = colorForHandle("vision");
  const hasAny = previews.length > 0 || !!localValue;

  return (
    <div className="relative">
      <Handle
        id="vision"
        type="target"
        position={Position.Left}
        className="!h-3.5 !w-3.5 !rounded-full !border-2"
        style={{
          left: -22,
          top: "50%",
          transform: "translateY(-50%)",
          background: handleColor,
          borderColor: handleColor,
          boxShadow: `${handleColor}50 0 0 8px`,
        }}
      />
      <div className="flex items-center gap-2">
        <div className="flex w-[88px] shrink-0 items-center gap-1 text-xs font-medium text-gray-900">
          Image (Vision)
        </div>
        <div className="flex-1">
          {uploadDisabled ? (
            <div className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-400">
              <ImageIcon className="h-3.5 w-3.5" /> Upload image
            </div>
          ) : (
            <UploadInputLabel
              accept="image/*"
              idleIcon={<Upload className="h-3.5 w-3.5" />}
              idleLabel={localValue ? "Change image" : "Upload image"}
              onUpload={onUpload}
            />
          )}
        </div>
        <PlusAddBtn disabled={atCap} onClick={onAddToRequest} />
      </div>

      {hasAny && (
        <div className="mt-2 flex items-center justify-end gap-2 pl-[96px]">
          {previews.map((url, i) => (
            <div
              key={`${url.slice(0, 32)}-${i}`}
              className="relative h-16 w-16 overflow-hidden rounded-lg border border-gray-200 bg-[#FAFAFA]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`vision ${i + 1}`} className="block h-full w-full object-cover" />
              {/* The clear-X is only shown for the local upload slot — upstream
               *  connections are managed by removing the edge. */}
              {!uploadDisabled && localValue && url === localValue.url && (
                <button
                  onClick={onClear}
                  title="Remove"
                  className="nodrag absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-600 shadow-sm hover:border-red-300 hover:bg-red-50 hover:text-red-500"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          <span className="text-[10px] text-gray-400 tabular-nums">{previews.length}/3</span>
        </div>
      )}
    </div>
  );
}

function UploadRow({
  handleId,
  label,
  accept,
  icon,
  uploadLabel,
  connected,
  previewUrl,
  previewName,
  isImagePreview,
  onUpload,
  onClear,
  onAddToRequest,
}: {
  handleId: string;
  label: string;
  accept: string;
  icon: ReactNode;
  uploadLabel: string;
  connected: boolean;
  previewUrl: string | null;
  previewName?: string;
  isImagePreview?: boolean;
  onUpload: (file: File) => void;
  onClear: () => void;
  onAddToRequest: () => void;
}) {
  const handleColor = colorForHandle(handleId);
  const filled = !!previewUrl;

  return (
    <div className="relative">
      <Handle
        id={handleId}
        type="target"
        position={Position.Left}
        className="!h-3.5 !w-3.5 !rounded-full !border-2"
        style={{
          left: -22,
          top: "50%",
          transform: "translateY(-50%)",
          background: handleColor,
          borderColor: handleColor,
          boxShadow: `${handleColor}50 0 0 8px`,
        }}
      />
      <div className="flex items-center gap-2">
        <div className="flex w-[88px] shrink-0 items-center gap-1 text-xs font-medium text-gray-900">
          {label}
        </div>
        <div className="flex-1">
          {filled ? (
            <FilePreview
              url={previewUrl!}
              name={previewName}
              isImage={!!isImagePreview}
              canRemove={!connected}
              onRemove={onClear}
            />
          ) : connected ? (
            <div className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-400">
              {icon} {uploadLabel}
            </div>
          ) : (
            <UploadInputLabel
              accept={accept}
              idleIcon={<Upload className="h-3.5 w-3.5" />}
              idleLabel={uploadLabel}
              onUpload={onUpload}
            />
          )}
        </div>
        <PlusAddBtn disabled={connected} onClick={onAddToRequest} />
      </div>
    </div>
  );
}

function FilePreview({
  url,
  name,
  isImage,
  canRemove,
  onRemove,
}: {
  url: string;
  name?: string;
  isImage: boolean;
  canRemove: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-gray-200 bg-white">
      {isImage ? (
        <div className="flex max-h-32 items-center justify-center bg-[#FAFAFA] py-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={name ?? "uploaded"} className="block max-h-28 max-w-full object-contain" />
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-gray-700">
          <FileIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span className="min-w-0 flex-1 truncate">{name ?? "uploaded"}</span>
        </div>
      )}
      {canRemove && (
        <button
          onClick={onRemove}
          title="Remove"
          className="nodrag absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-600 shadow-sm hover:border-red-300 hover:bg-red-50 hover:text-red-500"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function UploadInputLabel({
  accept,
  idleIcon,
  idleLabel,
  onUpload,
}: {
  accept: string;
  idleIcon: ReactNode;
  idleLabel: string;
  onUpload: (file: File) => void | Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <label
      className={cn(
        "nodrag inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[12px] font-medium text-gray-500",
        uploading ? "cursor-progress opacity-80" : "cursor-pointer hover:bg-gray-50",
      )}
    >
      <input
        type="file"
        accept={accept}
        disabled={uploading}
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setUploading(true);
          try {
            await onUpload(f);
          } finally {
            setUploading(false);
            e.target.value = "";
          }
        }}
      />
      {uploading ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Uploading…
        </>
      ) : (
        <>
          {idleIcon}
          {idleLabel}
        </>
      )}
    </label>
  );
}

function PlusAddBtn({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Already linked" : "Add to Request-Inputs"}
      className={cn(
        "nodrag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition-colors",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:bg-gray-100 hover:text-gray-700",
      )}
    >
      <Plus className="h-4 w-4" />
    </button>
  );
}

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
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="nodrag flex w-full items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-900"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        {label}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

function ExpandedTextEditor({
  label,
  value,
  readOnly,
  onClose,
  onChange,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  onClose: () => void;
  onChange: (v: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <span className="text-sm font-medium text-gray-900">{label}</span>
          <button
            onClick={onClose}
            title="Close"
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <textarea
          autoFocus
          readOnly={readOnly}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter text..."
          className={cn(
            "min-h-[320px] flex-1 resize-none px-4 py-3 text-[14px] leading-relaxed text-gray-800 outline-none",
            readOnly && "bg-gray-50 text-gray-500",
          )}
        />
        <div className="flex items-center justify-end border-t border-gray-100 px-4 py-2">
          <button
            onClick={onClose}
            className="rounded-lg bg-workflow-accent-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-workflow-accent-600"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
