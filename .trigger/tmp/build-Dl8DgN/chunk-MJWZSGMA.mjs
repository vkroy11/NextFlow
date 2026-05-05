import {
  AbortTaskRunError
} from "./chunk-4JND62D4.mjs";
import {
  __name,
  init_esm
} from "./chunk-FUV6SSYK.mjs";

// src/lib/triggerErrors.ts
init_esm();
var PERMANENT_PATTERNS = [
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
  /TRANSLOADIT_AUTH_KEY missing/i
];
function isPermanentError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return PERMANENT_PATTERNS.some((re) => re.test(msg));
}
__name(isPermanentError, "isPermanentError");
function rethrowClassified(err) {
  if (isPermanentError(err)) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AbortTaskRunError(msg);
  }
  throw err;
}
__name(rethrowClassified, "rethrowClassified");

export {
  rethrowClassified
};
//# sourceMappingURL=chunk-MJWZSGMA.mjs.map
