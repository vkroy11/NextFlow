"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
  ExternalLink,
} from "lucide-react";
import { relativeTime } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";

type WorkflowSummary = {
  id: string;
  name: string;
  updatedAt: string;
  lastStatus: string | null;
};

const statusColor: Record<string, string> = {
  SUCCESS: "bg-green-500/15 text-green-700 ring-green-500/30",
  FAILED: "bg-red-500/15 text-red-700 ring-red-500/30",
  PARTIAL: "bg-amber-500/15 text-amber-700 ring-amber-500/30",
  RUNNING: "bg-violet-500/15 text-violet-700 ring-violet-500/30",
  QUEUED: "bg-zinc-500/15 text-zinc-700 ring-zinc-500/30",
  CANCELLED: "bg-zinc-500/15 text-zinc-700 ring-zinc-500/30",
};

export function DashboardClient({ initialWorkflows }: { initialWorkflows: WorkflowSummary[] }) {
  const router = useRouter();
  const [workflows, setWorkflows] = useState(initialWorkflows);
  const [isCreating, startCreating] = useTransition();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function createWorkflow() {
    startCreating(async () => {
      const res = await fetch("/api/workflows", { method: "POST" });
      if (!res.ok) return;
      const { workflow } = await res.json();
      router.push(`/workflows/${workflow.id}`);
    });
  }

  async function commitRename(name: string) {
    if (!renameTarget) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    const id = renameTarget.id;
    const res = await fetch(`/api/workflows/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      setWorkflows((prev) => prev.map((w) => (w.id === id ? { ...w, name: trimmed } : w)));
    }
    setBusy(false);
    setRenameTarget(null);
    setOpenMenu(null);
  }

  async function commitDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    const id = deleteTarget.id;
    const res = await fetch(`/api/workflows/${id}`, { method: "DELETE" });
    if (res.ok) {
      setWorkflows((prev) => prev.filter((w) => w.id !== id));
    }
    setBusy(false);
    setDeleteTarget(null);
    setOpenMenu(null);
  }

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Workflows</h1>
          <p className="mt-1 text-sm text-gray-500">Build, run, and review your LLM workflows.</p>
        </div>
        <button
          onClick={createWorkflow}
          disabled={isCreating}
          className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-700 disabled:opacity-60"
        >
          {isCreating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          New Workflow
        </button>
      </div>

      {workflows.length === 0 ? (
        <div className="mt-12 grid place-items-center rounded-2xl border border-dashed border-node-border bg-white px-6 py-20 text-center">
          <p className="text-sm font-medium text-gray-700">No workflows yet</p>
          <p className="mt-1 max-w-md text-sm text-gray-500">
            Create your first workflow — Request-Inputs and Response are placed for you.
          </p>
          <button
            onClick={createWorkflow}
            disabled={isCreating}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white"
          >
            {isCreating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            Create your first workflow
          </button>
        </div>
      ) : (
        <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((w) => (
            <li
              key={w.id}
              className="group relative flex flex-col rounded-2xl border border-node-border bg-white p-4 shadow-sm transition hover:border-node-border-strong hover:shadow"
            >
              <Link href={`/workflows/${w.id}`} className="flex flex-1 flex-col">
                <span className="line-clamp-2 text-sm font-semibold text-gray-900">{w.name}</span>
                <span className="mt-1 text-xs text-gray-500">Last edited {relativeTime(w.updatedAt)}</span>
                <div className="mt-4 flex items-center justify-between">
                  {w.lastStatus ? (
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
                        statusColor[w.lastStatus] ?? statusColor.QUEUED,
                      )}
                    >
                      {w.lastStatus.toLowerCase()}
                    </span>
                  ) : (
                    <span className="text-[11px] text-gray-400">never run</span>
                  )}
                  <ExternalLink size={14} className="text-gray-400 transition group-hover:text-gray-600" />
                </div>
              </Link>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  setOpenMenu(openMenu === w.id ? null : w.id);
                }}
                className="absolute right-3 top-3 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                aria-label="More actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {openMenu === w.id && (
                <div className="absolute right-3 top-10 z-10 w-40 overflow-hidden rounded-xl border border-node-border bg-white text-sm shadow-lg">
                  <button
                    onClick={() => {
                      setRenameTarget({ id: w.id, name: w.name });
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-50"
                  >
                    <Pencil size={14} /> Rename
                  </button>
                  <button
                    onClick={() => {
                      setDeleteTarget({ id: w.id, name: w.name });
                      setOpenMenu(null);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {renameTarget && (
        <RenameDialog
          initialName={renameTarget.name}
          busy={busy}
          onCancel={() => setRenameTarget(null)}
          onSubmit={commitRename}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="Delete workflow"
          message={
            <>
              Delete <span className="font-medium text-gray-900">&ldquo;{deleteTarget.name}&rdquo;</span>?
              This cannot be undone.
            </>
          }
          confirmLabel="Delete"
          tone="danger"
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={commitDelete}
        />
      )}
    </div>
  );
}

// ---------- modals ----------

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

function RenameDialog({
  initialName,
  busy,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <ModalShell onClose={onCancel}>
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-900">Rename workflow</span>
          <button
            onClick={onCancel}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(name);
          }}
          className="flex flex-col gap-3 px-5 py-4"
        >
          <label className="text-xs font-medium text-gray-700">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="mt-1.5 block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-workflow-accent-400"
            />
          </label>
          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  tone,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  tone: "danger" | "default";
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell onClose={onCancel}>
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-900">{title}</span>
          <button
            onClick={onCancel}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 text-sm text-gray-600">{message}</div>
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60",
              tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-gray-900 hover:bg-gray-700",
            )}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
