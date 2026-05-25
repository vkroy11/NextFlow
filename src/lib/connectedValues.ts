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
    sourceNode.type === "extendVideo" ||
    sourceNode.type === "generateAudio" ||
    sourceNode.type === "muxAudioVideo"
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
  return resolveAllConnectedImagesWithIds(nodes, edges, targetId, targetHandle).map((i) => i.url);
}

/**
 * Same as `resolveAllConnectedImageUrls` but each entry carries the
 * incoming edge id so the UI can attach stable identifiers when the user
 * reorders thumbnails. The edge id stays valid across re-renders even when
 * the upstream URL changes (e.g. when a generator regenerates).
 */
export function resolveAllConnectedImagesWithIds(
  nodes: Node[],
  edges: Edge[],
  targetId: string,
  targetHandle: string,
): Array<{ edgeId: string; url: string }> {
  const items: Array<{ edgeId: string; url: string }> = [];
  for (const edge of edges) {
    if (edge.target !== targetId || edge.targetHandle !== targetHandle) continue;
    const sourceNode = nodes.find((n) => n.id === edge.source);
    if (!sourceNode) continue;
    let url: string | null = null;
    if (sourceNode.type === "requestInputs") {
      const fields = (sourceNode.data?.fields as RequestInputsField[] | undefined) ?? [];
      const f = fields.find((field) => field.key === edge.sourceHandle);
      if (f?.value && typeof f.value === "object" && "url" in f.value) {
        url = (f.value as { url: string }).url;
      } else if (typeof f?.value === "string" && f.value) {
        url = f.value;
      }
    } else if (sourceNode.type === "cropImage" || sourceNode.type === "generateImage") {
      url = (sourceNode.data as { outputUrl?: string | null } | undefined)?.outputUrl ?? null;
    } else if (sourceNode.type === "input") {
      const v = (sourceNode.data as { value?: unknown } | undefined)?.value;
      if (v && typeof v === "object" && "url" in v) url = (v as { url: string }).url;
      else if (typeof v === "string" && v) url = v;
    }
    if (url) items.push({ edgeId: edge.id, url });
  }
  return items;
}
