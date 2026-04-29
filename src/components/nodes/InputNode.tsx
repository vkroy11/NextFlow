"use client";

import { useState, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  AlignLeft,
  Check,
  FileIcon,
  Hash,
  Image as ImageIcon,
  Loader2,
  Music2,
  Upload,
  Video as VideoIcon,
  X,
} from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { HANDLE_COLOR } from "@/lib/handleColors";
import { uploadFile as uploadToCdn } from "@/lib/uploadFile";
import { cn } from "@/lib/utils";

type FieldType = "text" | "number" | "boolean" | "image" | "audio" | "video" | "file";

type FileVal = { url: string; name?: string };

type Data = {
  fieldType?: FieldType;
  label?: string;
  value?: string | number | boolean | FileVal | null;
};

const TYPE_LABEL: Record<FieldType, string> = {
  text: "Text Input",
  number: "Number Input",
  boolean: "Boolean Input",
  image: "Image Input",
  audio: "Audio Input",
  video: "Video Input",
  file: "File Input",
};

const TYPE_ICON: Record<FieldType, ReactNode> = {
  text: <AlignLeft className="h-3.5 w-3.5" />,
  number: <Hash className="h-3.5 w-3.5" />,
  boolean: <Check className="h-3.5 w-3.5" />,
  image: <ImageIcon className="h-3.5 w-3.5" />,
  audio: <Music2 className="h-3.5 w-3.5" />,
  video: <VideoIcon className="h-3.5 w-3.5" />,
  file: <FileIcon className="h-3.5 w-3.5" />,
};

const FILE_ACCEPTS: Record<Extract<FieldType, "image" | "audio" | "video" | "file">, string> = {
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
  file: "*/*",
};

const FILE_LABELS: Record<Extract<FieldType, "image" | "audio" | "video" | "file">, string> = {
  image: "Upload image",
  audio: "Upload audio",
  video: "Upload video",
  file: "Upload file",
};

const FIELD_HANDLE_COLOR: Record<FieldType, string> = {
  text: HANDLE_COLOR.text,
  number: HANDLE_COLOR.number,
  boolean: HANDLE_COLOR.boolean,
  image: HANDLE_COLOR.image,
  audio: HANDLE_COLOR.audio,
  video: HANDLE_COLOR.video,
  file: HANDLE_COLOR.file,
};

export function InputNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const pushToast = useWorkflowStore((s) => s.pushToast);
  const fieldType: FieldType = data?.fieldType ?? "text";
  const label = data?.label ?? TYPE_LABEL[fieldType];
  const handleColor = FIELD_HANDLE_COLOR[fieldType];

  async function uploadFile(file: File) {
    try {
      const { url, name } = await uploadToCdn(file);
      updateNodeData(id, { value: { url, name } });
    } catch (err) {
      pushToast(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return (
    <NodeShell
      id={id}
      title={label}
      width={320}
      showRun={false}
      selected={selected}
      headerLeft={<span className="text-gray-500">{TYPE_ICON[fieldType]}</span>}
    >
      <div className="relative">
        <FieldEditor
          data={data ?? {}}
          fieldType={fieldType}
          onChange={(value) => updateNodeData(id, { value })}
          onUploadFile={uploadFile}
        />
        <Handle
          id={fieldType}
          type="source"
          position={Position.Right}
          className="!h-3.5 !w-3.5 !rounded-full !border-2"
          style={{
            right: -22,
            top: "50%",
            transform: "translateY(-50%)",
            background: handleColor,
            borderColor: handleColor,
            boxShadow: `${handleColor}50 0 0 8px`,
          }}
        />
      </div>
    </NodeShell>
  );
}

function FieldEditor({
  data,
  fieldType,
  onChange,
  onUploadFile,
}: {
  data: Data;
  fieldType: FieldType;
  onChange: (value: Data["value"]) => void;
  onUploadFile: (file: File) => void;
}) {
  if (fieldType === "text") {
    return (
      <textarea
        value={typeof data.value === "string" ? data.value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter text..."
        rows={3}
        className="nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
      />
    );
  }
  if (fieldType === "number") {
    return (
      <input
        type="number"
        value={typeof data.value === "number" ? data.value : 0}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="nodrag w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] tabular-nums text-gray-800 outline-none focus:border-workflow-accent-400"
      />
    );
  }
  if (fieldType === "boolean") {
    const checked = data.value === true;
    return (
      <button
        onClick={() => onChange(!checked)}
        className="nodrag flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-800 hover:bg-gray-50"
      >
        <span>{checked ? "True" : "False"}</span>
        <span
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
            checked ? "bg-workflow-accent-500" : "bg-gray-300",
          )}
        >
          <span
            className={cn(
              "absolute h-4 w-4 rounded-full bg-white shadow transition-transform",
              checked ? "translate-x-[18px]" : "translate-x-[2px]",
            )}
          />
        </span>
      </button>
    );
  }
  const fileType = fieldType as Extract<FieldType, "image" | "audio" | "video" | "file">;
  const filled = typeof data.value === "object" && data.value !== null && "url" in data.value;
  if (filled) {
    const v = data.value as FileVal;
    return (
      <div className="relative overflow-hidden rounded-lg border border-gray-200 bg-white">
        {fileType === "image" ? (
          <div className="flex max-h-56 items-center justify-center bg-[#FAFAFA] py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={v.url}
              alt={v.name ?? "uploaded"}
              className="block max-h-52 max-w-full object-contain"
            />
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-gray-700">
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <span className="min-w-0 flex-1 truncate">{v.name ?? "uploaded"}</span>
          </div>
        )}
        <button
          onClick={() => onChange(null)}
          title="Remove"
          className="nodrag absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 bg-white/95 text-gray-600 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-500"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  return <UploadDropzone fileType={fileType} onUploadFile={onUploadFile} />;
}

function UploadDropzone({
  fileType,
  onUploadFile,
}: {
  fileType: Extract<FieldType, "image" | "audio" | "video" | "file">;
  onUploadFile: (file: File) => void | Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <label
      className={cn(
        "nodrag flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-[#FAFAFA] px-3 py-3 text-[12px] font-medium text-gray-500",
        uploading ? "cursor-progress opacity-80" : "cursor-pointer hover:bg-gray-50",
      )}
    >
      <input
        type="file"
        accept={FILE_ACCEPTS[fileType]}
        disabled={uploading}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setUploading(true);
          try {
            await onUploadFile(file);
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
          <Upload className="h-3.5 w-3.5" />
          {FILE_LABELS[fileType]}
        </>
      )}
    </label>
  );
}
