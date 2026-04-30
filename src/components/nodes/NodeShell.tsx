"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Copy,
  CopyPlus,
  Info,
  Lock,
  LockOpen,
  MoreHorizontal,
  Play,
  RotateCcw,
  Loader2,
  Trash2,
} from "lucide-react";
import { useWorkflowStore } from "@/store/useWorkflowStore";
import { useWorkflowRun } from "../canvas/RunContext";
import { cn } from "@/lib/utils";

type NodeShellProps = {
  id: string;
  title: string;
  tooltip?: string;
  selected?: boolean;
  children: ReactNode;
  width?: number;
  deletable?: boolean;
  showRun?: boolean;
  showMenu?: boolean;
  onRun?: () => void;
  headerLeft?: ReactNode;
  headerExtras?: ReactNode;
  customHeader?: ReactNode;
};

export function NodeShell({
  id,
  title,
  tooltip,
  selected,
  children,
  width = 380,
  deletable = true,
  showRun = true,
  showMenu,
  onRun,
  headerLeft,
  headerExtras,
  customHeader,
}: NodeShellProps) {
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const duplicateNode = useWorkflowStore((s) => s.duplicateNode);
  const toggleLock = useWorkflowStore((s) => s.toggleLock);
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === id));
  const locked = Boolean(node?.data?.locked);
  const runStatus = useWorkflowStore((s) => s.runStatus[id]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Default: show the menu only when the node is deletable. RequestInputs +
  // Response (deletable=false) hide the menu entirely; Gemini + Crop keep it.
  const shouldShowMenu = showMenu ?? deletable;

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  // Three distinct flags drive the Run button:
  //   - `nodeIsRunning` — this node's worker is currently executing on
  //     Trigger.dev. Drives the pulsate animation on the card and the
  //     Run-button spinner.
  //   - `globalRunning` — *any* run (full-flow or single-node) is in
  //     flight; flips on synchronously when the user fires `triggerRun`.
  //     Disables every Run button on the canvas to prevent competing runs.
  //   - `submitting` — local optimistic flag, set to `true` synchronously
  //     the moment this node's Run is clicked. Closes the perceptible gap
  //     between the click and the API/poll cycle confirming the run has
  //     started: without this, the button was rendering as enabled until
  //     `runStatus` reached "running" several seconds later.
  const { isRunning: globalRunning } = useWorkflowRun();
  const nodeIsRunning = runStatus === "running";
  const [submitting, setSubmitting] = useState(false);

  // Clear the optimistic flag once we observe real signal — either the
  // worker picked up the task (nodeIsRunning) or the entire run is over
  // (globalRunning back to false). React's officially-recommended
  // "adjust state in response to prop changes" pattern is to compare a
  // snapshot during render rather than do it in useEffect (which trips
  // the react-hooks/set-state-in-effect lint and can cascade renders).
  const [signalSnapshot, setSignalSnapshot] = useState({ nodeIsRunning, globalRunning });
  if (
    signalSnapshot.nodeIsRunning !== nodeIsRunning ||
    signalSnapshot.globalRunning !== globalRunning
  ) {
    setSignalSnapshot({ nodeIsRunning, globalRunning });
    if (submitting && (nodeIsRunning || !globalRunning)) {
      setSubmitting(false);
    }
  }

  const runDisabled = nodeIsRunning || globalRunning || submitting;
  const showRunSpinner = nodeIsRunning || submitting;

  const handleRunClick = () => {
    if (runDisabled) return;
    setSubmitting(true);
    onRun?.();
  };

  return (
    <div
      style={{ width }}
      className={cn(
        "rounded-xl border bg-white shadow-2xl transition-all duration-200",
        selected
          ? "border-gray-200 ring-2 ring-workflow-accent-500"
          : "border-gray-200",
        nodeIsRunning && "nf-running",
        runStatus === "success" && "border-green-400/60",
        runStatus === "failed" && "border-red-400/60",
      )}
    >
      {customHeader ?? (
        <div className="flex items-start justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {headerLeft}
            <span className="w-full min-w-0 cursor-grab select-none truncate text-sm font-medium text-gray-900 flex items-center gap-1">
              {title}
              {tooltip && (
              <span className="group/tip relative shrink-0">
                <Info className="h-3.5 w-3.5 cursor-default text-gray-400" />
                <span className="pointer-events-none absolute left-1/2 top-full z-[9999] mt-1.5 hidden w-max max-w-[260px] -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] font-normal leading-relaxed text-gray-700 shadow-lg group-hover/tip:block">
                  {tooltip}
                </span>
              </span>
            )}
            </span>
            
          </div>
          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
            {headerExtras}
            {showRun && (
              <>
                <button
                  className="nodrag rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  title="Reset node"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={handleRunClick}
                  disabled={runDisabled}
                  className="nodrag flex items-center gap-1.5 rounded-md border border-green-500/30 bg-green-500/20 px-3 py-1.5 text-xs font-medium text-green-600 transition-all hover:bg-green-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {/* Spinner shows on either the actively-executing node or
                   *  the node whose Run was just clicked but hasn't reached
                   *  Trigger yet. Other cards on the canvas remain idle but
                   *  disabled while a competing run is in flight. */}
                  {showRunSpinner ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3 fill-current" />
                  )}
                  <span>Run</span>
                </button>
              </>
            )}
            {shouldShowMenu && (
              <div ref={menuRef} className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="nodrag inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-[#F5F5F5] text-gray-500 hover:bg-gray-100"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  title="More"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-[9999] mt-1.5 w-52 overflow-hidden rounded-xl border border-gray-200 bg-white py-1.5 text-[13px] text-gray-700 shadow-xl"
                  >
                    <button
                      onClick={() => {
                        duplicateNode(id, false);
                        setMenuOpen(false);
                      }}
                      className="nodrag flex w-full items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 hover:text-gray-900"
                    >
                      <Copy className="h-3.5 w-3.5 text-gray-500" />
                      Duplicate
                    </button>
                    <button
                      onClick={() => {
                        duplicateNode(id, true);
                        setMenuOpen(false);
                      }}
                      className="nodrag flex w-full items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 hover:text-gray-900"
                    >
                      <CopyPlus className="h-3.5 w-3.5 text-gray-500" />
                      Duplicate with Edges
                    </button>
                    <div className="my-1 border-t border-gray-100" />
                    <button
                      onClick={() => {
                        toggleLock(id);
                        setMenuOpen(false);
                      }}
                      className="nodrag flex w-full items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 hover:text-gray-900"
                    >
                      {locked ? (
                        <LockOpen className="h-3.5 w-3.5 text-gray-500" />
                      ) : (
                        <Lock className="h-3.5 w-3.5 text-gray-500" />
                      )}
                      {locked ? "Unlock" : "Lock"}
                    </button>
                    {deletable && (
                      <>
                        <div className="my-1 border-t border-gray-100" />
                        <button
                          onClick={() => {
                            removeNode(id);
                            setMenuOpen(false);
                          }}
                          className="nodrag flex w-full items-center gap-2.5 px-3 py-1.5 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}
