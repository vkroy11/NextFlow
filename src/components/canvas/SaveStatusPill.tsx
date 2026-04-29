"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { relativeTime } from "@/lib/relativeTime";

export function SaveStatusPill() {
  const saveState = useWorkflowStore((s) => s.saveState);
  const lastSavedAt = useWorkflowStore((s) => s.lastSavedAt);
  const saveError = useWorkflowStore((s) => s.saveError);

  const base = "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium";

  if (saveState === "saving") {
    return (
      <span className={`${base} bg-gray-100 text-gray-500`}>
        <Loader2 size={11} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (saveState === "error") {
    return (
      <span className={`${base} bg-red-50 text-red-600`} title={saveError ?? undefined}>
        <AlertTriangle size={11} />
        Save failed
      </span>
    );
  }
  if (saveState === "saved" && lastSavedAt) {
    return (
      <span className={`${base} bg-gray-100 text-gray-500`}>
        <CheckCircle2 size={11} className="text-green-500" />
        Saved {relativeTime(lastSavedAt)}
      </span>
    );
  }
  if (saveState === "dirty") {
    return <span className={`${base} bg-gray-100 text-gray-500`}>Editing…</span>;
  }
  return null;
}
