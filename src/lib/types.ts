import { z } from "zod";

/**
 * The four node types NextFlow supports. Picker entries beyond these are
 * rendered disabled — see the PRD's "no marketing/home page", LLM-only scope.
 */
export const NodeTypeEnum = z.enum([
  "requestInputs",
  "cropImage",
  "gemini",
  "response",
  "input",
  "stickyNote",
  "generateImage",
  "generateVideo",
  "enhanceVideo",
  "extendVideo",
  "generateAudio",
  "muxAudioVideo",
]);
export type NodeType = z.infer<typeof NodeTypeEnum>;

/**
 * Handle data types. Type-safe connections gate the canvas: an `image` source
 * only connects to an `image` or `vision` target, etc. (PRD §Workflow Features:
 * "Type-safe connections + connected-input greyed-out state + DAG validation".)
 */
export const HandleTypeEnum = z.enum([
  "text",
  "number",
  "boolean",
  "image",
  "vision",
  "video",
  "audio",
  "file",
  "result",
]);
export type HandleType = z.infer<typeof HandleTypeEnum>;

export const CanvasNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeEnum,
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.string(), z.unknown()).optional(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  selected: z.boolean().optional(),
  dragging: z.boolean().optional(),
  positionAbsolute: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const CanvasEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
  type: z.string().optional(),
  animated: z.boolean().optional(),
  style: z.record(z.string(), z.unknown()).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;

export const WorkflowGraphSchema = z.object({
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
});

export const SaveWorkflowSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema),
});

export const RunRequestSchema = z.object({
  scope: z.enum(["FULL", "SINGLE", "MULTI"]).default("FULL"),
  targetNodeIds: z.array(z.string()).optional(),
});

/**
 * Canonical type compatibility map for type-safe connections + greyed handles.
 * `vision` accepts multiple `image` connections (PRD's Image (Vision) handle).
 */
export const HANDLE_COMPAT: Record<HandleType, HandleType[]> = {
  text: ["text"],
  number: ["number"],
  boolean: ["boolean"],
  image: ["image", "vision"],
  vision: ["image", "vision"],
  video: ["video"],
  audio: ["audio"],
  file: ["file"],
  result: ["result", "text"],
};

export function handlesCompatible(source: HandleType, target: HandleType) {
  return HANDLE_COMPAT[source]?.includes(target) ?? false;
}
