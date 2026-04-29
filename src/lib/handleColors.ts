/**
 * Single source of truth for handle / edge colors. Every node imports from
 * here so a `text` handle on Request-Inputs, a `prompt` target on Gemini, and
 * the connecting edge between them all share the same orange. The `vision`
 * target is intentionally pink to match Galaxy.ai's multimodal handle.
 *
 * Resolution order matters: longer / more-specific keys are checked first so
 * `image_field` matches `image` (not nothing), `vision` matches `vision` (not
 * matched by `image`), and `response` matches its own entry instead of any
 * substring. Keep the most-specific keys at the top of each cluster.
 */
export const HANDLE_COLOR = {
  // text-like
  text: "#f59e0b",
  prompt: "#f59e0b",

  // numeric / boolean
  number: "#ec4899",
  boolean: "#22c55e",

  // image — vision routes to the same cyan as image since both carry image
  // data; the dedicated `vision` key still exists for type-system rules.
  vision: "#06b6d4",
  image: "#06b6d4",

  // av
  video: "#6366f1",
  audio: "#8b5cf6",
  file: "#71717a",

  // Gemini's response is always text, and Response collects that text — so
  // both handles take the text-orange shade for visual consistency. Crop
  // outputs (image/cyan) keep their type color on the edge stroke.
  response: "#f59e0b",
  result: "#f59e0b",

  // crop input/output are image-typed
  input: "#06b6d4",
  output: "#06b6d4",
} as const;

export type HandleColorKey = keyof typeof HANDLE_COLOR;

export const FALLBACK_HANDLE_COLOR = "#94a3b8";

export function colorForHandle(handleId?: string | null): string {
  if (!handleId) return FALLBACK_HANDLE_COLOR;
  const id = handleId.toLowerCase();
  for (const key of Object.keys(HANDLE_COLOR) as HandleColorKey[]) {
    if (id.includes(key)) return HANDLE_COLOR[key];
  }
  return FALLBACK_HANDLE_COLOR;
}
