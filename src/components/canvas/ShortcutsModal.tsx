"use client";

import { useEffect, useMemo } from "react";
import { X } from "lucide-react";

function buildShortcuts(meta: string) {
  const general: { label: string; keys: string[] }[] = [
    { label: "Undo", keys: [meta, "Z"] },
    { label: "Redo", keys: [meta, "Shift", "Z"] },
    { label: "Select all", keys: [meta, "A"] },
    { label: "Deselect all", keys: ["Esc"] },
    { label: "Pan canvas", keys: ["Space", "Drag"] },
    { label: "Zoom in", keys: ["+"] },
    { label: "Zoom out", keys: ["-"] },
    { label: "Fit view", keys: ["F"] },
    { label: "Toggle select mode", keys: ["S"] },
    { label: "Auto-arrange", keys: ["Shift", "A"] },
  ];
  const nodeOps: { label: string; keys: string[] }[] = [
    { label: "Copy", keys: [meta, "C"] },
    { label: "Paste", keys: [meta, "V"] },
    { label: "Duplicate", keys: [meta, "D"] },
    { label: "Duplicate with Edges", keys: [meta, "Shift", "D"] },
    { label: "Delete", keys: ["Delete"] },
  ];
  return { general, nodeOps };
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { general, nodeOps } = useMemo(() => {
    const meta = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
    return buildShortcuts(meta);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative max-h-[80vh] w-full max-w-[520px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between px-6 pb-4 pt-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Keyboard Shortcuts</h2>
            <p className="mt-0.5 text-sm text-gray-500">Quickly navigate and create with these shortcuts.</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[calc(80vh-100px)] space-y-5 overflow-y-auto px-6 pb-6">
          <Section title="General" items={general} />
          <Section title="Node Operations" items={nodeOps} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, items }: { title: string; items: { label: string; keys: string[] }[] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-gray-900">{title}</h3>
      <div className="space-y-0">
        {items.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between border-b border-gray-100 py-2 last:border-0"
          >
            <span className="text-sm text-gray-700">{row.label}</span>
            <div className="flex items-center gap-1">
              {row.keys.map((k) => (
                <kbd
                  key={k}
                  className="inline-flex h-7 min-w-[28px] items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-2 text-xs font-medium text-gray-600 shadow-sm"
                >
                  {k}
                </kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
