"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactFlow, {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "reactflow";
import {
  ArrowLeft,
  Calculator,
  Clock,
  Download,
  Loader2,
  Map as MapIcon,
  Minimize2,
  MoreHorizontal,
  Play,
  Plus,
  Redo2,
  StickyNote,
  Undo2,
  Upload,
  Wallet,
} from "lucide-react";
import { useWorkflowStore, type RunStatus } from "@/store/useWorkflowStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCanvasShortcuts } from "@/hooks/useCanvasShortcuts";
import { isHandleConnectionValid } from "@/lib/handles";
import { RequestInputsNode } from "@/components/nodes/RequestInputsNode";
import { CropImageNode } from "@/components/nodes/CropImageNode";
import { Gemini31ProNode } from "@/components/nodes/Gemini31ProNode";
import { ResponseNode } from "@/components/nodes/ResponseNode";
import { InputNode } from "@/components/nodes/InputNode";
import { StickyNoteNode } from "@/components/nodes/StickyNote";
import { RemovableEdge } from "./RemovableEdge";
import { WorkflowRunProvider, type RunScope } from "./RunContext";
import { NodePicker } from "./NodePicker";
import { SaveStatusPill } from "./SaveStatusPill";
import { HistorySidebar } from "./HistorySidebar";
import { CanvasToolbar } from "./CanvasToolbar";
import { ShortcutsModal } from "./ShortcutsModal";
import { ToastBar } from "./ToastBar";
import { RealtimeCoordinator } from "./RealtimeCoordinator";

const nodeTypes = {
  requestInputs: RequestInputsNode,
  cropImage: CropImageNode,
  gemini: Gemini31ProNode,
  response: ResponseNode,
  input: InputNode,
  stickyNote: StickyNoteNode,
};

// Override the built-in "default" edge with our removable variant so legacy
// edges stored as `type: "default"` also pick up the hover-to-remove X.
const edgeTypes = {
  default: RemovableEdge,
  removable: RemovableEdge,
};

type InitialWorkflow = {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
};

const STATUS_TO_RUN: Record<string, RunStatus> = {
  QUEUED: "queued",
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed",
  PARTIAL: "failed",
  CANCELLED: "failed",
};

function CanvasInner({ initial }: { initial: InitialWorkflow }) {
  useAutoSave();
  const initWorkflow = useWorkflowStore((s) => s.initWorkflow);
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    undo,
    redo,
    workflowName,
    setWorkflowName,
    setNodes,
    setEdges,
    setRunStatus,
    setCurrentRunId,
    resetStreamingText,
    currentRunId,
    updateNodeData,
    addNode,
  } = useWorkflowStore();
  const reactFlow = useReactFlow();
  const fileRef = useRef<HTMLInputElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [running, setRunning] = useState(false);
  // Captured from POST /run's response body. Together they let
  // `HistorySidebar` subscribe to live Trigger.dev updates instead of
  // polling our `/runs` endpoint on a `setInterval`. Sidebar's own
  // 5 s `setInterval` fallback covers the case where the token mint
  // failed or the SSE stream errors.
  const [realtimeTag, setRealtimeTag] = useState<string | null>(null);
  const [publicAccessToken, setPublicAccessToken] = useState<string | null>(null);
  const [showMinimap, setShowMinimap] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [panMode, setPanMode] = useState(true);

  const autoArrange = useCallback(() => {
    const current = useWorkflowStore.getState().nodes;
    if (current.length === 0) return;
    const incoming = new Map<string, number>();
    current.forEach((n) => incoming.set(n.id, 0));
    useWorkflowStore.getState().edges.forEach((e) => {
      incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    });
    // Simple layered layout: column = depth from any source
    const depth = new Map<string, number>();
    const queue: string[] = current.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
    queue.forEach((id) => depth.set(id, 0));
    while (queue.length > 0) {
      const id = queue.shift()!;
      const d = depth.get(id) ?? 0;
      useWorkflowStore.getState().edges
        .filter((e) => e.source === id)
        .forEach((e) => {
          const next = Math.max(d + 1, depth.get(e.target) ?? 0);
          if (next !== depth.get(e.target)) {
            depth.set(e.target, next);
            queue.push(e.target);
          }
        });
    }
    const cols = new Map<number, string[]>();
    current.forEach((n) => {
      const d = depth.get(n.id) ?? 0;
      const arr = cols.get(d) ?? [];
      arr.push(n.id);
      cols.set(d, arr);
    });
    const COL_W = 460;
    const ROW_H = 540;
    const positioned = current.map((n) => {
      const d = depth.get(n.id) ?? 0;
      const arr = cols.get(d) ?? [];
      const idx = arr.indexOf(n.id);
      return { ...n, position: { x: d * COL_W, y: idx * ROW_H } };
    });
    setNodes(positioned);
  }, [setNodes]);

  useCanvasShortcuts({
    onToggleSelect: () => setPanMode((v) => !v),
    onAutoArrange: autoArrange,
  });

  useEffect(() => {
    if (!overflowOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as globalThis.Node | null;
      if (target && overflowRef.current && !overflowRef.current.contains(target)) setOverflowOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [overflowOpen]);

  useEffect(() => {
    initWorkflow(initial);
  }, [initial, initWorkflow]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify({ name: workflowName, nodes, edges }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflowName.replace(/\s+/g, "-").toLowerCase() || "workflow"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [workflowName, nodes, edges]);

  const importJson = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string);
          if (Array.isArray(data.nodes) && Array.isArray(data.edges)) {
            setNodes(data.nodes);
            setEdges(data.edges);
            if (typeof data.name === "string" && data.name.trim()) setWorkflowName(data.name.trim());
          }
        } catch {
          // ignore
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [setNodes, setEdges, setWorkflowName],
  );

  // Slow output-fetching loop. The canvas glow / `runStatus` is now
  // driven primarily by `RealtimeCoordinator` over SSE; this loop's
  // job is narrower:
  //   - Read each NodeRun's persisted `output` once it succeeds and
  //     write it onto canvas state via `updateNodeData` (Gemini
  //     `response`, Response `result`/`results`, Crop `outputUrl`).
  //   - Detect terminal `WorkflowRun.status` and flip `setRunning(false)`.
  // It also still calls `setRunStatus(map)` as a true fallback for the
  // glow if the realtime token mint or SSE stream failed — in that
  // case this is the only thing keeping the canvas live. Cadence is
  // 5 s instead of the original 2 s because realtime is the primary
  // path.
  const pollRun = useCallback(
    async (runId: string) => {
      const seenOutputs = new Set<string>();
      let done = false;
      while (!done) {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) break;
        const { run } = await res.json();
        const map: Record<string, RunStatus> = {};
        for (const nr of run.nodeRuns) {
          map[nr.nodeId] = STATUS_TO_RUN[nr.status] ?? "queued";
          if (nr.status === "SUCCESS" && nr.output && !seenOutputs.has(nr.id)) {
            seenOutputs.add(nr.id);
            const out = nr.output as {
              text?: string;
              result?: string | null;
              perEdge?: Record<string, string>;
              url?: string;
            };
            if (nr.nodeType === "gemini" && typeof out.text === "string") {
              updateNodeData(nr.nodeId, { response: out.text });
            } else if (nr.nodeType === "response") {
              updateNodeData(nr.nodeId, {
                result: out.result ?? null,
                results: out.perEdge ?? {},
              });
            } else if (nr.nodeType === "cropImage" && typeof out.url === "string") {
              updateNodeData(nr.nodeId, { outputUrl: out.url });
            }
          }
        }
        setRunStatus(map);
        if (["SUCCESS", "FAILED", "PARTIAL", "CANCELLED"].includes(run.status)) {
          done = true;
          setRunning(false);
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      setHistoryKey((k) => k + 1);
    },
    [setRunStatus, updateNodeData],
  );

  const triggerRun = useCallback(
    async (scope: RunScope, targetNodeIds?: string[]) => {
      if (running) return;
      setRunning(true);
      setHistoryOpen(true);
      // Clear any previous run's streamed text so partially-rendered
      // chunks don't ghost a fresh run.
      resetStreamingText();
      try {
        const res = await fetch(`/api/workflows/${initial.id}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope, targetNodeIds }),
        });
        if (!res.ok) {
          setRunning(false);
          return;
        }
        const json = (await res.json()) as {
          runId: string;
          triggerRunId?: string;
          publicAccessToken?: string | null;
          realtimeTag?: string | null;
        };
        setCurrentRunId(json.runId);
        setRealtimeTag(json.realtimeTag ?? null);
        setPublicAccessToken(json.publicAccessToken ?? null);
        setHistoryKey((k) => k + 1);
        pollRun(json.runId);
      } catch {
        setRunning(false);
      }
    },
    [initial.id, pollRun, running, setCurrentRunId, resetStreamingText],
  );

  return (
    <WorkflowRunProvider value={{ triggerRun, isRunning: running }}>
    {currentRunId && running ? <RealtimeCoordinator workflowRunId={currentRunId} /> : null}
    <div style={{ height: "calc(100vh - 3.5rem)", width: "100%" }} className="relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(c) => {
          if (!isHandleConnectionValid(c.sourceHandle, c.targetHandle)) return false;
          // Vision accepts up to 3 image inputs (image-vision multi-fan-in
          // per the PRD). Reject the 4th attempt so the cap is enforced at
          // drag-time, not just at runtime.
          if ((c.targetHandle ?? "").toLowerCase() === "vision") {
            const existing = edges.filter(
              (e) => e.target === c.target && e.targetHandle === "vision",
            ).length;
            if (existing >= 3) return false;
          }
          return true;
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: "removable", animated: true }}
        // ReactFlow's defaults clamp zoom to [0.5, 2]. Big workflows that
        // span 5–7 nodes horizontally can't fit in viewport at 0.5×, so
        // open up the lower bound to 0.15 (the toolbar percentage and the
        // pinch-zoom gesture both honour this).
        minZoom={0.15}
        maxZoom={2}
        fitView
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        panOnDrag={panMode}
        selectionOnDrag={!panMode}
        multiSelectionKeyCode={["Shift", "Meta", "Control"]}
      >
        <Background gap={20} size={1} color="#d4d4d8" variant={BackgroundVariant.Dots} />

        {/* Top-left: back arrow + title input */}
        <Panel position="top-left" className="!m-4">
          <div className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-white/85 px-2 py-1.5 shadow-md backdrop-blur">
            <Link
              href="/dashboard"
              title="Back to Dashboard"
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="relative">
              <input
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                placeholder="Untitled"
                maxLength={120}
                className="h-8 w-[120px] bg-transparent text-[14px] font-normal text-gray-900 outline-none placeholder:text-gray-400 sm:w-[180px]"
              />
            </div>
            <SaveStatusPill />
          </div>
        </Panel>

        {/* Top-right: estimate / balance / run / history */}
        <Panel position="top-right" className="!m-4">
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-gray-200 bg-white/90 px-2.5 text-[11px] font-medium text-gray-700 shadow-sm backdrop-blur">
                <Calculator className="h-3.5 w-3.5" />
                <span className="text-gray-500">Est</span>
                <span className="tabular-nums">0.95</span>
                <span className="text-gray-500">M</span>
              </span>
            </span>
            <span className="hidden sm:inline-flex">
              <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-gray-200 bg-white/90 px-2.5 text-[11px] font-medium text-gray-700 shadow-sm backdrop-blur">
                <Wallet className="h-3.5 w-3.5" />
                <span className="text-gray-500">Bal</span>
                <span className="tabular-nums">0.00</span>
                <span className="text-gray-500">M</span>
              </span>
            </span>

            <button
              onClick={() => triggerRun("FULL")}
              disabled={running}
              title="Run Workflow"
              className="flex h-8 w-9 items-center justify-center rounded-lg border border-workflow-accent-400 bg-workflow-accent-500 text-white shadow-sm transition-all hover:bg-workflow-accent-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
            </button>

            <button
              onClick={() => setHistoryOpen((v) => !v)}
              title="Execution History"
              className="flex h-8 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-800 shadow-sm transition-all hover:bg-gray-100"
            >
              <Clock className="h-3.5 w-3.5" />
            </button>

            <div ref={overflowRef} className="relative">
              <button
                onClick={() => setOverflowOpen((v) => !v)}
                title="More"
                className="flex h-8 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-100"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {overflowOpen && (
                <div className="absolute right-0 top-full z-[9999] mt-1 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 text-[12px] shadow-lg">
                  <button
                    onClick={() => {
                      undo();
                      setOverflowOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-50"
                  >
                    <Undo2 className="h-3.5 w-3.5" /> Undo
                  </button>
                  <button
                    onClick={() => {
                      redo();
                      setOverflowOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-50"
                  >
                    <Redo2 className="h-3.5 w-3.5" /> Redo
                  </button>
                  <div className="my-1 border-t border-gray-100" />
                  <button
                    onClick={() => {
                      fileRef.current?.click();
                      setOverflowOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-50"
                  >
                    <Upload className="h-3.5 w-3.5" /> Import JSON
                  </button>
                  <button
                    onClick={() => {
                      exportJson();
                      setOverflowOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-gray-700 hover:bg-gray-50"
                  >
                    <Download className="h-3.5 w-3.5" /> Export JSON
                  </button>
                </div>
              )}
              <input type="file" ref={fileRef} accept=".json" className="hidden" onChange={importJson} />
            </div>
          </div>
        </Panel>

        {/* Bottom-left: zoom / undo / shortcuts toolbar */}
        <Panel position="bottom-left" className="!m-4">
          <CanvasToolbar
            panMode={panMode}
            onTogglePanMode={() => setPanMode((v) => !v)}
            onAutoArrange={autoArrange}
            onShowShortcuts={() => setShortcutsOpen(true)}
          />
        </Panel>

        {/* Bottom-center: notes / add node bar */}
        <Panel position="bottom-center" className="!m-4">
          <div className="flex items-center gap-1 overflow-visible rounded-xl border border-gray-200 bg-white/95 px-2 py-1.5 shadow-sm backdrop-blur-sm">
            <button
              type="button"
              title="Add sticky note"
              onClick={() => {
                const center = reactFlow.screenToFlowPosition({
                  x: window.innerWidth / 2,
                  y: window.innerHeight / 2,
                });
                addNode({
                  id: `stickyNote-${crypto.randomUUID().slice(0, 8)}`,
                  type: "stickyNote",
                  position: { x: center.x - 130, y: center.y - 90 },
                  data: { text: "", color: "yellow" },
                });
              }}
              className="rounded-lg p-2 text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <StickyNote className="h-4 w-4" />
            </button>
            <NodePicker
              renderTrigger={(open, toggle) => (
                <button
                  type="button"
                  title="Add node"
                  onClick={toggle}
                  aria-expanded={open}
                  className="rounded p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            />
          </div>
        </Panel>

        {/* Bottom-right: minimap toggle */}
        <Panel position="bottom-right" className="!m-4">
          <button
            type="button"
            title={showMinimap ? "Hide minimap" : "Show minimap"}
            onClick={() => setShowMinimap((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-md transition-all hover:bg-gray-50"
          >
            <MapIcon className="h-4 w-4" />
          </button>
        </Panel>

        {showMinimap && (
          <>
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              className="!rounded-xl !border !border-zinc-700 !bg-zinc-900 !shadow-md"
              style={{ marginRight: 64, marginBottom: 16 }}
              nodeStrokeColor="#27272a"
              nodeColor={(node) => {
                switch (node.type) {
                  case "requestInputs":
                    return "#fbbf24"; // amber — text-input host
                  case "input":
                    return "#f59e0b"; // orange — single input
                  case "cropImage":
                    return "#06b6d4"; // cyan — image
                  case "gemini":
                    return "#a855f7"; // violet — LLM
                  case "response":
                    return "#22c55e"; // green — terminal
                  case "stickyNote":
                    return "#facc15"; // yellow — note
                  default:
                    return "#94a3b8";
                }
              }}
              maskColor="rgba(0,0,0,0.55)"
            />
            <button
              type="button"
              onClick={() => setShowMinimap(false)}
              title="Hide minimap"
              className="absolute z-20 rounded-lg border border-gray-200 bg-white p-1.5 text-gray-500 shadow-sm transition-colors hover:bg-gray-100"
              style={{ bottom: 172, right: 16 }}
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}

      </ReactFlow>

      <ToastBar />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <HistorySidebar
        workflowId={initial.id}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        refreshKey={historyKey}
        realtimeTag={realtimeTag}
        publicAccessToken={publicAccessToken}
      />
    </div>
    </WorkflowRunProvider>
  );
}

export function WorkflowCanvas(props: { initial: InitialWorkflow }) {
  return (
    <ReactFlowProvider>
      <CanvasInner initial={props.initial} />
    </ReactFlowProvider>
  );
}
