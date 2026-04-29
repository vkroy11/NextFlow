"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  AlignLeft,
  Check,
  Copy,
  FileIcon,
  GripVertical,
  Hash,
  Image as ImageIcon,
  Info,
  Loader2,
  Maximize2,
  Music2,
  Plus,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { HANDLE_COLOR } from "@/lib/handleColors";
import { uploadFile as uploadToCdn } from "@/lib/uploadFile";
import { cn } from "@/lib/utils";

type FieldType = "text" | "number" | "boolean" | "image" | "audio" | "video" | "file";

type FileVal = { url: string; name?: string };

type Field = {
  key: string;
  label: string;
  type: FieldType;
  value: string | number | boolean | FileVal | null;
};

type Data = { fields?: Field[] };

const FIELD_HANDLE_COLOR: Record<FieldType, string> = {
  text: HANDLE_COLOR.text,
  number: HANDLE_COLOR.number,
  boolean: HANDLE_COLOR.boolean,
  image: HANDLE_COLOR.image,
  audio: HANDLE_COLOR.audio,
  video: HANDLE_COLOR.video,
  file: HANDLE_COLOR.file,
};

const TYPE_OPTIONS: { type: FieldType; label: string; icon: ReactNode }[] = [
  { type: "text", label: "Text", icon: <AlignLeft className="h-3.5 w-3.5" /> },
  { type: "number", label: "Number", icon: <Hash className="h-3.5 w-3.5" /> },
  { type: "boolean", label: "Boolean", icon: <Check className="h-3.5 w-3.5" /> },
  { type: "image", label: "Image", icon: <ImageIcon className="h-3.5 w-3.5" /> },
  { type: "audio", label: "Audio", icon: <Music2 className="h-3.5 w-3.5" /> },
  { type: "video", label: "Video", icon: <Video className="h-3.5 w-3.5" /> },
  { type: "file", label: "File", icon: <FileIcon className="h-3.5 w-3.5" /> },
];

const TYPE_DEFAULTS: Record<FieldType, Field["value"]> = {
  text: "",
  number: 0,
  boolean: false,
  image: null,
  audio: null,
  video: null,
  file: null,
};

const TYPE_INFO: Record<FieldType, string> = {
  text: "Text input — only accepts a string.",
  number: "Number — accepts a numeric value.",
  boolean: "Boolean — true or false.",
  image: "Image URL — paste a link or upload a file.",
  audio: "Audio URL — paste a link or upload a file.",
  video: "Video URL — paste a link or upload a file.",
  file: "File URL — paste a link or upload a file.",
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

const DRAG_MIME = "application/x-nextflow-field";

export function RequestInputsNode({ id, data, selected }: NodeProps<Data>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const pushToast = useWorkflowStore((s) => s.pushToast);
  const fields: Field[] = data?.fields ?? [
    { key: "image_field", label: "image_field", type: "image", value: null },
    { key: "text_field", label: "text_field", type: "text", value: "" },
  ];

  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ key: string; pos: "before" | "after" } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  function setFields(next: Field[]) {
    updateNodeData(id, { fields: next });
  }

  function patchField(key: string, patch: Partial<Field>) {
    setFields(fields.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  function uniqueKey(base: string) {
    const used = new Set(fields.map((f) => f.key));
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  function addField(type: FieldType) {
    const base = `${type}_field`;
    const key = uniqueKey(base);
    setFields([...fields, { key, label: key, type, value: TYPE_DEFAULTS[type] }]);
    setMenuOpen(false);
  }

  function removeField(key: string) {
    setFields(fields.filter((f) => f.key !== key));
  }

  async function copyFieldValue(key: string) {
    const f = fields.find((x) => x.key === key);
    if (!f) return;
    let text = "";
    if (f.value === null || f.value === undefined) text = "";
    else if (typeof f.value === "string") text = f.value;
    else if (typeof f.value === "number" || typeof f.value === "boolean") text = String(f.value);
    else if (typeof f.value === "object" && "url" in f.value) text = f.value.url;
    else text = JSON.stringify(f.value);
    try {
      await navigator.clipboard.writeText(text);
      pushToast(text ? "Value copied" : "Field is empty");
    } catch {
      pushToast("Could not copy value");
    }
  }

  function renameField(key: string, nextLabel: string) {
    const trimmed = nextLabel.trim();
    if (!trimmed) {
      setEditingKey(null);
      return;
    }
    const sanitized = trimmed.replace(/\s+/g, "_");
    const used = new Set(fields.filter((f) => f.key !== key).map((f) => f.key));
    let finalKey = sanitized;
    let i = 2;
    while (used.has(finalKey)) {
      finalKey = `${sanitized}_${i++}`;
    }
    patchField(key, { key: finalKey, label: finalKey });
    setEditingKey(null);
  }

  function reorder(sourceKey: string, targetKey: string, position: "before" | "after") {
    if (sourceKey === targetKey) return;
    const next = [...fields];
    const srcIdx = next.findIndex((f) => f.key === sourceKey);
    if (srcIdx === -1) return;
    const [moved] = next.splice(srcIdx, 1);
    let insertAt = next.findIndex((f) => f.key === targetKey);
    if (insertAt === -1) return;
    if (position === "after") insertAt += 1;
    next.splice(insertAt, 0, moved);
    setFields(next);
  }

  async function uploadFile(file: File, key: string) {
    try {
      const { url, name } = await uploadToCdn(file);
      patchField(key, { value: { url, name } });
    } catch (err) {
      pushToast(`Upload failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  const expandedField = expandedKey ? fields.find((f) => f.key === expandedKey) ?? null : null;

  return (
    <>
      <NodeShell
        id={id}
        title="Request-Inputs"
        tooltip="Define the input fields for your workflow. These become the request parameters when running."
        selected={selected}
        deletable={false}
        showRun={false}
        headerExtras={
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="Add field"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={cn(
                "nodrag flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-[#F5F5F5] text-gray-500 transition-colors",
                "hover:bg-gray-100 hover:text-gray-700",
                menuOpen && "bg-gray-100 text-gray-700",
              )}
            >
              <Plus className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-[9999] mt-1.5 w-44 overflow-hidden rounded-xl border border-gray-200 bg-white py-1.5 shadow-xl"
              >
                {TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.type}
                    onClick={() => addField(opt.type)}
                    className="nodrag flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900"
                  >
                    <span className="text-gray-500">{opt.icon}</span>
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          {fields.map((f, i) => (
            <FieldRow
              key={f.key}
              field={f}
              index={i}
              isEditing={editingKey === f.key}
              isDragging={draggingKey === f.key}
              dropIndicator={dropIndicator?.key === f.key ? dropIndicator.pos : null}
              onStartEdit={() => setEditingKey(f.key)}
              onCommitEdit={(label) => renameField(f.key, label)}
              onCancelEdit={() => setEditingKey(null)}
              onPatchValue={(value) => patchField(f.key, { value })}
              onCopyValue={() => copyFieldValue(f.key)}
              onRemove={() => removeField(f.key)}
              onUploadFile={(file) => uploadFile(file, f.key)}
              onExpand={() => setExpandedKey(f.key)}
              onDragStart={() => setDraggingKey(f.key)}
              onDragEnd={() => {
                setDraggingKey(null);
                setDropIndicator(null);
              }}
              onDragOverRow={(pos) => setDropIndicator({ key: f.key, pos })}
              onDropRow={(sourceKey, pos) => {
                reorder(sourceKey, f.key, pos);
                setDropIndicator(null);
                setDraggingKey(null);
              }}
            />
          ))}
        </div>
      </NodeShell>

      {expandedField && expandedField.type === "text" && (
        <ExpandedTextEditor
          field={expandedField}
          onClose={() => setExpandedKey(null)}
          onChange={(value) => patchField(expandedField.key, { value })}
        />
      )}
    </>
  );
}

type FieldRowProps = {
  field: Field;
  index: number;
  isEditing: boolean;
  isDragging: boolean;
  dropIndicator: "before" | "after" | null;
  onStartEdit: () => void;
  onCommitEdit: (label: string) => void;
  onCancelEdit: () => void;
  onPatchValue: (value: Field["value"]) => void;
  onCopyValue: () => void;
  onRemove: () => void;
  onUploadFile: (file: File) => void;
  onExpand: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (pos: "before" | "after") => void;
  onDropRow: (sourceKey: string, pos: "before" | "after") => void;
};

function FieldRow({
  field: f,
  index,
  isEditing,
  isDragging,
  dropIndicator,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onPatchValue,
  onCopyValue,
  onRemove,
  onUploadFile,
  onExpand,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropRow,
}: FieldRowProps) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, f.key);
    e.dataTransfer.effectAllowed = "move";
    onDragStart();
  };

  return (
    <div
      className={cn(
        "group/row relative w-full transition-opacity",
        isDragging && "opacity-50",
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        onDragOverRow(e.clientY < mid ? "before" : "after");
      }}
      onDrop={(e) => {
        const sourceKey = e.dataTransfer.getData(DRAG_MIME);
        if (!sourceKey) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        onDropRow(sourceKey, e.clientY < mid ? "before" : "after");
      }}
    >
      {dropIndicator === "before" && (
        <div className="absolute -top-1.5 left-0 right-0 h-0.5 rounded-full bg-workflow-accent-500" />
      )}
      {dropIndicator === "after" && (
        <div className="absolute -bottom-1.5 left-0 right-0 h-0.5 rounded-full bg-workflow-accent-500" />
      )}

      <div className="mb-2 flex w-full min-w-0 items-center gap-2">
        <span
          draggable
          onDragStart={handleDragStart}
          onDragEnd={onDragEnd}
          title="Drag to reorder"
          className="nodrag nopan shrink-0 cursor-grab text-gray-400 hover:text-gray-600 active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        {isEditing ? (
          <LabelEditor initial={f.label} onCommit={onCommitEdit} onCancel={onCancelEdit} />
        ) : (
          <button
            onClick={onStartEdit}
            title="Click to rename"
            className="nodrag min-w-0 max-w-[60%] truncate text-left text-xs font-medium text-gray-900 hover:text-workflow-accent-600"
          >
            {f.label}
          </button>
        )}
        <span className="group/tip relative shrink-0">
          <Info className="h-3 w-3 cursor-default text-gray-400 hover:text-gray-600" />
          <span className="pointer-events-none absolute left-1/2 top-full z-[9999] mt-1.5 hidden w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-normal leading-relaxed text-gray-700 shadow-lg group-hover/tip:block">
            {TYPE_INFO[f.type]}
          </span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
          <button
            onClick={onCopyValue}
            title="Copy value"
            className="nodrag rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            onClick={onRemove}
            title="Remove"
            className="nodrag rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <FieldEditor field={f} onPatchValue={onPatchValue} onUploadFile={onUploadFile} onExpand={onExpand} />

      <Handle
        id={f.key}
        type="source"
        position={Position.Right}
        className="!h-3.5 !w-3.5 !rounded-full !border-2"
        style={{
          right: -22,
          top: index === 0 ? 12 : "calc(12px + 2px)",
          transform: "translateY(-50%)",
          background: FIELD_HANDLE_COLOR[f.type],
          borderColor: FIELD_HANDLE_COLOR[f.type],
          boxShadow: `${FIELD_HANDLE_COLOR[f.type]}50 0 0 8px`,
        }}
      />
    </div>
  );
}

function LabelEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
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
      className="nodrag h-6 min-w-0 max-w-[60%] flex-1 rounded border border-gray-200 bg-white px-1.5 text-xs font-medium text-gray-900 outline-none focus:border-workflow-accent-400"
    />
  );
}

function FieldEditor({
  field: rawField,
  onPatchValue,
  onUploadFile,
  onExpand,
}: {
  field: Field;
  onPatchValue: (value: Field["value"]) => void;
  onUploadFile: (file: File) => void;
  onExpand: () => void;
}) {
  // Legacy workflows may have fields stored without a `type` (the original
  // /api/workflows seed didn't include it). Default to "text" so a missing
  // type never accidentally renders the upload UI.
  const f: Field = rawField.type ? rawField : { ...rawField, type: "text" };
  if (f.type === "text") {
    return (
      <div className="relative">
        <textarea
          value={typeof f.value === "string" ? f.value : ""}
          onChange={(e) => onPatchValue(e.target.value)}
          placeholder="Enter text..."
          rows={2}
          className="nodrag w-full resize-y rounded-lg border border-gray-200 bg-[#FAFAFA] px-3 py-2 pr-9 text-[13px] text-gray-800 outline-none focus:border-workflow-accent-400 focus:bg-white"
        />
        <button
          onClick={onExpand}
          title="Expand"
          className="nodrag absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
    );
  }
  if (f.type === "number") {
    return (
      <input
        type="number"
        value={typeof f.value === "number" ? f.value : 0}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          onPatchValue(Number.isFinite(n) ? n : 0);
        }}
        className="nodrag w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] tabular-nums text-gray-800 outline-none focus:border-workflow-accent-400"
      />
    );
  }
  if (f.type === "boolean") {
    const checked = f.value === true;
    return (
      <button
        onClick={() => onPatchValue(!checked)}
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
  // image / audio / video / file all share the upload pattern
  const fileType = f.type as Extract<FieldType, "image" | "audio" | "video" | "file">;
  const filled = typeof f.value === "object" && f.value !== null && "url" in f.value;
  if (filled) {
    const v = f.value as FileVal;
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
          onClick={() => onPatchValue(null)}
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

// Local upload dropzone that owns its own "uploading" spinner state. Each
// row therefore feedback-isolates: starting an image upload doesn't grey out
// the textarea or any other field.
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
            // Reset the input so re-selecting the same file still fires onChange.
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

function ExpandedTextEditor({
  field,
  onClose,
  onChange,
}: {
  field: Field;
  onClose: () => void;
  onChange: (value: string) => void;
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
          <span className="text-sm font-medium text-gray-900">{field.label}</span>
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
          value={typeof field.value === "string" ? field.value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter text..."
          className="min-h-[320px] flex-1 resize-none px-4 py-3 text-[14px] leading-relaxed text-gray-800 outline-none"
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
