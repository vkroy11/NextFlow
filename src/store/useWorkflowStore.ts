import { create } from "zustand";
import {
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
} from "reactflow";
import { colorForHandle } from "@/lib/handleColors";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
export type RunStatus = "queued" | "running" | "success" | "failed";

export type Toast = { id: number; message: string };

const PROTECTED_TYPES = new Set(["requestInputs", "response"]);

function withDeletable(node: Node): Node {
  let next = node;
  if (PROTECTED_TYPES.has(node.type ?? "") && node.deletable !== false) {
    next = { ...next, deletable: false };
  }
  if (next.data?.locked && next.draggable !== false) {
    next = { ...next, draggable: false };
  }
  return next;
}

export type WorkflowState = {
  workflowId: string;
  workflowName: string;
  nodes: Node[];
  edges: Edge[];
  saveState: SaveState;
  saveError: string | null;
  lastSavedAt: number | null;
  past: { nodes: Node[]; edges: Edge[] }[];
  future: { nodes: Node[]; edges: Edge[] }[];
  runStatus: Record<string, RunStatus>;
  currentRunId: string | null;
  selectedNodeIds: string[];
  clipboard: { nodes: Node[]; edges: Edge[] } | null;
  toasts: Toast[];

  initWorkflow: (w: { id: string; name: string; nodes: Node[]; edges: Edge[] }) => void;
  setWorkflowName: (name: string) => void;
  setSaveState: (s: SaveState, opts?: { error?: string | null; savedAt?: number }) => void;

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  removeNode: (id: string) => void;

  takeSnapshot: () => void;
  undo: () => void;
  redo: () => void;

  selectAll: () => void;
  deselectAll: () => void;
  copySelection: () => void;
  pasteClipboard: () => void;
  duplicateSelection: (withEdges?: boolean) => void;
  duplicateNode: (id: string, withEdges?: boolean) => void;
  toggleLock: (id: string) => void;
  deleteSelection: () => void;

  pushToast: (message: string) => void;
  dismissToast: (id: number) => void;

  setRunStatus: (map: Record<string, RunStatus>) => void;
  patchNodeRunStatus: (id: string, status: RunStatus) => void;
  setCurrentRunId: (id: string | null) => void;
};

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  workflowId: "",
  workflowName: "",
  nodes: [],
  edges: [],
  saveState: "idle",
  saveError: null,
  lastSavedAt: null,
  past: [],
  future: [],
  runStatus: {},
  currentRunId: null,
  selectedNodeIds: [],
  clipboard: null,
  toasts: [],

  initWorkflow: ({ id, name, nodes, edges }) =>
    set({
      workflowId: id,
      workflowName: name,
      nodes: nodes.map(withDeletable),
      edges,
      past: [],
      future: [],
      saveState: "saved",
      saveError: null,
      lastSavedAt: Date.now(),
      runStatus: {},
      currentRunId: null,
    }),

  setWorkflowName: (name) => set({ workflowName: name, saveState: "dirty" }),

  setSaveState: (s, opts) =>
    set({
      saveState: s,
      saveError: opts?.error ?? null,
      lastSavedAt: opts?.savedAt ?? get().lastSavedAt,
    }),

  onNodesChange: (changes: NodeChange[]) => {
    const nodeMap = new Map(get().nodes.map((n) => [n.id, n]));
    let blocked = 0;
    const allowed: NodeChange[] = [];
    for (const c of changes) {
      if (c.type === "remove") {
        const n = nodeMap.get(c.id);
        if (n && PROTECTED_TYPES.has(n.type ?? "")) {
          blocked++;
          continue;
        }
      }
      allowed.push(c);
    }
    if (blocked > 0) {
      get().pushToast("These nodes cannot be deleted.");
    }
    const next = applyNodeChanges(allowed, get().nodes);
    const selected = next.filter((n) => n.selected).map((n) => n.id);
    set({ nodes: next, selectedNodeIds: selected, saveState: "dirty" });
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    set({ edges: applyEdgeChanges(changes, get().edges), saveState: "dirty" });
  },

  onConnect: (connection: Connection) => {
    get().takeSnapshot();
    const stroke = colorForHandle(connection.sourceHandle);
    set({
      edges: addEdge(
        {
          ...connection,
          animated: true,
          style: { stroke, strokeWidth: 2 },
          type: "removable",
        },
        get().edges,
      ),
      saveState: "dirty",
    });
  },

  setNodes: (nodes) => set({ nodes: nodes.map(withDeletable), saveState: "dirty" }),
  setEdges: (edges) => set({ edges, saveState: "dirty" }),

  addNode: (node) => {
    get().takeSnapshot();
    set({ nodes: [...get().nodes, withDeletable(node)], saveState: "dirty" });
  },

  updateNodeData: (id, patch) =>
    set({
      nodes: get().nodes.map((n) =>
        n.id === id ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n,
      ),
      saveState: "dirty",
    }),

  removeNode: (id) => {
    const n = get().nodes.find((x) => x.id === id);
    if (n && PROTECTED_TYPES.has(n.type ?? "")) {
      get().pushToast("These nodes cannot be deleted.");
      return;
    }
    if (n?.data?.locked) {
      get().pushToast("Unlock the node before deleting.");
      return;
    }
    get().takeSnapshot();
    set({
      nodes: get().nodes.filter((x) => x.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      saveState: "dirty",
    });
  },

  takeSnapshot: () => {
    const { nodes, edges, past } = get();
    set({
      past: [
        ...past,
        {
          nodes: JSON.parse(JSON.stringify(nodes)),
          edges: JSON.parse(JSON.stringify(edges)),
        },
      ].slice(-30),
      future: [],
    });
  },

  undo: () => {
    const { past, nodes, edges, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    set({
      nodes: previous.nodes,
      edges: previous.edges,
      past: past.slice(0, -1),
      future: [{ nodes, edges }, ...future],
      saveState: "dirty",
    });
  },

  redo: () => {
    const { past, nodes, edges, future } = get();
    if (future.length === 0) return;
    const [next, ...rest] = future;
    set({
      nodes: next.nodes,
      edges: next.edges,
      past: [...past, { nodes, edges }],
      future: rest,
      saveState: "dirty",
    });
  },

  selectAll: () => {
    set({
      nodes: get().nodes.map((n) => ({ ...n, selected: true })),
      selectedNodeIds: get().nodes.map((n) => n.id),
    });
  },

  deselectAll: () => {
    set({
      nodes: get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
      selectedNodeIds: [],
    });
  },

  copySelection: () => {
    const selectedNodes = get().nodes.filter((n) => n.selected);
    if (selectedNodes.length === 0) return;
    const ids = new Set(selectedNodes.map((n) => n.id));
    const selectedEdges = get().edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    set({
      clipboard: {
        nodes: JSON.parse(JSON.stringify(selectedNodes)),
        edges: JSON.parse(JSON.stringify(selectedEdges)),
      },
    });
    get().pushToast(`Copied ${selectedNodes.length} node${selectedNodes.length > 1 ? "s" : ""}`);
  },

  pasteClipboard: () => {
    const cb = get().clipboard;
    if (!cb || cb.nodes.length === 0) return;
    get().takeSnapshot();
    const idMap = new Map<string, string>();
    const newNodes: Node[] = cb.nodes
      .filter((n) => !PROTECTED_TYPES.has(n.type ?? ""))
      .map((n) => {
        const newId = `${n.type}-${crypto.randomUUID().slice(0, 8)}`;
        idMap.set(n.id, newId);
        return withDeletable({
          ...n,
          id: newId,
          position: { x: n.position.x + 40, y: n.position.y + 40 },
          selected: true,
          data: JSON.parse(JSON.stringify(n.data ?? {})),
        });
      });
    const newEdges: Edge[] = cb.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        ...e,
        id: `e-${crypto.randomUUID().slice(0, 8)}`,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
      }));
    const cleared: Node[] = get().nodes.map((n) => ({ ...n, selected: false }));
    set({
      nodes: [...cleared, ...newNodes],
      edges: [...get().edges, ...newEdges],
      selectedNodeIds: newNodes.map((n) => n.id),
      saveState: "dirty",
    });
  },

  duplicateNode: (id, withEdges = false) => {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    if (PROTECTED_TYPES.has(node.type ?? "")) {
      get().pushToast("This node cannot be duplicated.");
      return;
    }
    get().takeSnapshot();
    const newId = `${node.type}-${crypto.randomUUID().slice(0, 8)}`;
    const cloned: Node = withDeletable({
      ...node,
      id: newId,
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      selected: true,
      data: JSON.parse(JSON.stringify(node.data ?? {})),
    });
    const newEdges: Edge[] = withEdges
      ? get()
          .edges.filter((e) => e.source === id || e.target === id)
          .map((e) => ({
            ...e,
            id: `e-${crypto.randomUUID().slice(0, 8)}`,
            source: e.source === id ? newId : e.source,
            target: e.target === id ? newId : e.target,
          }))
      : [];
    const cleared: Node[] = get().nodes.map((n) => ({ ...n, selected: false }));
    set({
      nodes: [...cleared, cloned],
      edges: [...get().edges, ...newEdges],
      selectedNodeIds: [newId],
      saveState: "dirty",
    });
  },

  toggleLock: (id) => {
    const node = get().nodes.find((n) => n.id === id);
    if (!node) return;
    const nextLocked = !node.data?.locked;
    set({
      nodes: get().nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              draggable: nextLocked ? false : undefined,
              data: { ...(n.data ?? {}), locked: nextLocked },
            }
          : n,
      ),
      saveState: "dirty",
    });
  },

  duplicateSelection: (withEdges = false) => {
    const selected = get().nodes.filter((n) => n.selected && !PROTECTED_TYPES.has(n.type ?? ""));
    if (selected.length === 0) return;
    get().takeSnapshot();
    const idMap = new Map<string, string>();
    const newNodes: Node[] = selected.map((n) => {
      const newId = `${n.type}-${crypto.randomUUID().slice(0, 8)}`;
      idMap.set(n.id, newId);
      return withDeletable({
        ...n,
        id: newId,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        selected: true,
        data: JSON.parse(JSON.stringify(n.data ?? {})),
      });
    });
    const newEdges: Edge[] = withEdges
      ? get()
          .edges.filter((e) => idMap.has(e.source) && idMap.has(e.target))
          .map((e) => ({
            ...e,
            id: `e-${crypto.randomUUID().slice(0, 8)}`,
            source: idMap.get(e.source)!,
            target: idMap.get(e.target)!,
          }))
      : [];
    const cleared: Node[] = get().nodes.map((n) => ({ ...n, selected: false }));
    set({
      nodes: [...cleared, ...newNodes],
      edges: [...get().edges, ...newEdges],
      selectedNodeIds: newNodes.map((n) => n.id),
      saveState: "dirty",
    });
  },

  deleteSelection: () => {
    const allSelected = get().nodes.filter((n) => n.selected);
    if (allSelected.length === 0) return;
    const protectedSelected = allSelected.filter((n) => PROTECTED_TYPES.has(n.type ?? ""));
    const removable = allSelected.filter((n) => !PROTECTED_TYPES.has(n.type ?? ""));
    if (protectedSelected.length > 0) {
      get().pushToast("These nodes cannot be deleted.");
    }
    if (removable.length === 0) return;
    get().takeSnapshot();
    const removeIds = new Set(removable.map((n) => n.id));
    set({
      nodes: get().nodes.filter((n) => !removeIds.has(n.id)),
      edges: get().edges.filter((e) => !removeIds.has(e.source) && !removeIds.has(e.target)),
      selectedNodeIds: [],
      saveState: "dirty",
    });
  },

  pushToast: (message) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    set({ toasts: [...get().toasts, { id, message }] });
    setTimeout(() => get().dismissToast(id), 2400);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setRunStatus: (map) => set({ runStatus: map }),
  patchNodeRunStatus: (id, status) =>
    set({ runStatus: { ...get().runStatus, [id]: status } }),
  setCurrentRunId: (id) => set({ currentRunId: id }),
}));
