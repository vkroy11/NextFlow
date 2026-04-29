"use client";

import { useWorkflowStore } from "@/store/useWorkflowStore";

export function ToastBar() {
  const toasts = useWorkflowStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-24 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto rounded-lg border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-gray-900 shadow-lg"
          role="status"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
