import type { Edge, Node } from "reactflow";

type RequestInputsField = {
  key: string;
  type: string;
  value: unknown;
};

/**
 * Resolve the live value flowing into `targetId.targetHandle` from the
 * upstream graph. The Crop node uses this to mirror connected x/y/w/h
 * numbers and the input image url so its UI stays in sync with whatever
 * the user changes upstream.
 *
 * Returns `undefined` when the handle is not connected; nodes treat that
 * as "use the local data" path.
 */
export function resolveConnectedValue(
  nodes: Node[],
  edges: Edge[],
  targetId: string,
  targetHandle: string,
): unknown {
  const edge = edges.find((e) => e.target === targetId && e.targetHandle === targetHandle);
  if (!edge) return undefined;
  const sourceNode = nodes.find((n) => n.id === edge.source);
  if (!sourceNode) return undefined;

  if (sourceNode.type === "requestInputs") {
    const fields = (sourceNode.data?.fields as RequestInputsField[] | undefined) ?? [];
    const f = fields.find((field) => field.key === edge.sourceHandle);
    if (!f) return undefined;
    // Image / file fields wrap value in { url, name }; unwrap.
    if (f.value && typeof f.value === "object" && "url" in f.value) {
      return (f.value as { url: string }).url;
    }
    return f.value;
  }
  if (sourceNode.type === "cropImage") {
    return (sourceNode.data as { outputUrl?: string | null } | undefined)?.outputUrl ?? undefined;
  }
  if (sourceNode.type === "gemini") {
    return (sourceNode.data as { response?: string | null } | undefined)?.response ?? undefined;
  }
  if (
    sourceNode.type === "generateImage" ||
    sourceNode.type === "generateVideo" ||
    sourceNode.type === "enhanceVideo" ||
    sourceNode.type === "extendVideo"
  ) {
    return (sourceNode.data as { outputUrl?: string | null } | undefined)?.outputUrl ?? undefined;
  }
  return undefined;
}

export function isHandleConnected(
  edges: Edge[],
  targetId: string,
  targetHandle: string,
): boolean {
  return edges.some((e) => e.target === targetId && e.targetHandle === targetHandle);
}

/**
 * Like resolveConnectedValue but returns *every* image URL flowing into a
 * fan-in target handle (e.g. Gemini's vision input which accepts up to 3
 * images). Walks every incoming edge for the target handle and unwraps the
 * upstream value to a string URL.
 */
export function resolveAllConnectedImageUrls(
  nodes: Node[],
  edges: Edge[],
  targetId: string,
  targetHandle: string,
): string[] {
  const urls: string[] = [];
  for (const edge of edges) {
    if (edge.target !== targetId || edge.targetHandle !== targetHandle) continue;
    const sourceNode = nodes.find((n) => n.id === edge.source);
    if (!sourceNode) continue;
    if (sourceNode.type === "requestInputs") {
      const fields = (sourceNode.data?.fields as RequestInputsField[] | undefined) ?? [];
      const f = fields.find((field) => field.key === edge.sourceHandle);
      if (!f) continue;
      if (f.value && typeof f.value === "object" && "url" in f.value) {
        urls.push((f.value as { url: string }).url);
      } else if (typeof f.value === "string" && f.value) {
        urls.push(f.value);
      }
    } else if (sourceNode.type === "cropImage" || sourceNode.type === "generateImage") {
      const u = (sourceNode.data as { outputUrl?: string | null } | undefined)?.outputUrl;
      if (u) urls.push(u);
    } else if (sourceNode.type === "input") {
      const v = (sourceNode.data as { value?: unknown } | undefined)?.value;
      if (v && typeof v === "object" && "url" in v) urls.push((v as { url: string }).url);
      else if (typeof v === "string" && v) urls.push(v);
    }
  }
  return urls;
}
