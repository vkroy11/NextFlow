import { AbortTaskRunError } from "@trigger.dev/sdk/v3";

/**
 * Classify external-API errors into "retryable" vs "permanent" so the
 * Trigger.dev retry policy doesn't burn attempts on requests that will
 * never succeed (bad API key, malformed input, validation failure, etc.).
 *
 * The ground truth is each provider's documented error code, but
 * different SDKs surface errors differently — Google's GenAI SDK throws
 * `Error` with the GAPI status name in the message; Transloadit's SDK
 * throws errors whose `.message` contains the assembly error code. We
 * pattern-match on message content rather than introspecting unstable
 * shapes — slightly fragile, but easy to extend when a new permanent
 * error type shows up in production logs.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  // Google AI / Gemini permanent errors
  /\bINVALID_ARGUMENT\b/i,
  /\bFAILED_PRECONDITION\b/i,
  /\bUNAUTHENTICATED\b/i,
  /\bPERMISSION_DENIED\b/i,
  /\bNOT_FOUND\b/i,
  /API key not valid/i,
  /API_KEY_INVALID/i,

  // Transloadit permanent assembly errors (image/video/upload validation)
  /ASSEMBLY_INVALID/i,
  /VIDEO_ENCODE_VALIDATION/i,
  /HTTP_IMPORT_VALIDATION/i,
  /INVALID_UPLOAD_HANDLE/i,
  /GET_ACCOUNT_UNKNOWN_AUTH_KEY/i,
  /TRANSLOADIT_AUTH_KEY missing/i,
];

export function isPermanentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return PERMANENT_PATTERNS.some((re) => re.test(msg));
}

/**
 * Throw `AbortTaskRunError` (Trigger short-circuits remaining retries)
 * for permanent errors; otherwise rethrow the original so the retry
 * policy applies.
 */
export function rethrowClassified(err: unknown): never {
  if (isPermanentError(err)) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AbortTaskRunError(msg);
  }
  throw err;
}
