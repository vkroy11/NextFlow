import { HANDLE_COMPAT, type HandleType } from "./types";

/**
 * Infer a HandleType from a React Flow handle id. Our node implementations
 * pick handle ids that hint at their type ("vision", "image_field", "result").
 * Falls back to "text" for unknown handles.
 */
export function inferHandleType(handleId: string | null | undefined): HandleType {
  if (!handleId) return "text";
  const id = handleId.toLowerCase();
  if (id === "x" || id === "y" || id === "w" || id === "h") return "number";
  if (id.includes("number")) return "number";
  if (id.includes("boolean")) return "boolean";
  if (id.includes("vision")) return "vision";
  if (id.includes("image")) return "image";
  if (id.includes("video")) return "video";
  if (id.includes("audio")) return "audio";
  if (id.includes("file")) return "file";
  if (id.includes("result") || id === "response") return "result";
  if (id.includes("output")) return "image"; // crop output
  if (id.includes("input")) return "image"; // crop input
  return "text";
}

export function isHandleConnectionValid(sourceHandle: string | null | undefined, targetHandle: string | null | undefined) {
  const s = inferHandleType(sourceHandle);
  const t = inferHandleType(targetHandle);
  // Response collects "the workflow's final output" regardless of upstream
  // type — text from Gemini, an image URL from Crop, a number from Input,
  // etc. Allow any source to land on a result target.
  if (t === "result") return true;
  return HANDLE_COMPAT[s]?.includes(t) ?? false;
}
