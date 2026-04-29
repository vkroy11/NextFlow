import type { CanvasEdge, CanvasNode } from "./types";

export type AdjacencyMap = Map<string, string[]>;

/**
 * Build forward (outgoing) and reverse (incoming) adjacency maps from edges.
 */
export function buildAdjacency(nodes: CanvasNode[], edges: CanvasEdge[]) {
  const out: AdjacencyMap = new Map(nodes.map((n) => [n.id, []] as [string, string[]]));
  const inn: AdjacencyMap = new Map(nodes.map((n) => [n.id, []] as [string, string[]]));
  for (const e of edges) {
    out.get(e.source)?.push(e.target);
    inn.get(e.target)?.push(e.source);
  }
  return { out, inn };
}

/**
 * Kahn's algorithm. Returns topo order, or null if a cycle exists.
 */
export function topoSort(nodes: CanvasNode[], edges: CanvasEdge[]): string[] | null {
  const { out, inn } = buildAdjacency(nodes, edges);
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, inn.get(n.id)?.length ?? 0);
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return order.length === nodes.length ? order : null;
}

export function hasCycle(nodes: CanvasNode[], edges: CanvasEdge[]) {
  return topoSort(nodes, edges) === null;
}

/**
 * Returns the set of upstream node ids (transitive) for `targetIds`. Used to
 * decide which nodes to execute for a SINGLE/MULTI scope run.
 */
export function upstreamClosure(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  targetIds: string[],
): Set<string> {
  const { inn } = buildAdjacency(nodes, edges);
  const visited = new Set<string>(targetIds);
  const stack = [...targetIds];
  while (stack.length) {
    const id = stack.pop()!;
    for (const parent of inn.get(id) ?? []) {
      if (!visited.has(parent)) {
        visited.add(parent);
        stack.push(parent);
      }
    }
  }
  return visited;
}
