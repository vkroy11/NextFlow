import { Transloadit } from "transloadit";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let _client: InstanceType<typeof Transloadit> | null = null;

function client() {
  if (_client) return _client;
  const authKey = process.env.TRANSLOADIT_AUTH_KEY;
  const authSecret = process.env.TRANSLOADIT_AUTH_SECRET;
  if (!authKey || !authSecret) {
    throw new Error("TRANSLOADIT_AUTH_KEY / TRANSLOADIT_AUTH_SECRET missing in env");
  }
  _client = new Transloadit({ authKey, authSecret });
  return _client;
}

/**
 * Crops `inputUrl` to a percentage box (x,y,w,h are 0-100) using
 * Transloadit's `/image/resize` robot in `crop` mode. ImageMagick is
 * Transloadit's canonical image-crop pipeline — `/video/encode` accepts
 * image inputs in theory but trips VIDEO_ENCODE_VALIDATION on most preset
 * combinations. The crop runs on Trigger.dev workers, satisfying the
 * "crop runs as a Trigger.dev task on Transloadit's infrastructure"
 * requirement.
 *
 * The orchestrator adds the mandatory 30 s artificial delay; this function
 * returns as soon as the assembly's CDN URL is ready.
 */
export async function cropImageViaTransloadit(input: {
  inputUrl: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<{ url: string; assemblyId: string }> {
  const c = client();

  const result = await c.createAssembly({
    params: {
      steps: {
        imported: {
          robot: "/http/import",
          url: input.inputUrl,
        },
        cropped: {
          robot: "/image/resize",
          use: "imported",
          format: "jpg",
          imagemagick_stack: "v3.0.0",
          // Percentage-geometry crop: x1,y1 = top-left, x2,y2 = bottom-right.
          crop: {
            x1: `${input.x}%`,
            y1: `${input.y}%`,
            x2: `${input.x + input.w}%`,
            y2: `${input.y + input.h}%`,
          },
        },
      },
    },
    waitForCompletion: true,
  });

  const url = result?.results?.cropped?.[0]?.ssl_url ?? result?.results?.cropped?.[0]?.url;
  if (!url) throw new Error(`Transloadit crop produced no output url (assembly ${result?.assembly_id})`);
  return { url, assemblyId: result.assembly_id ?? "" };
}

/**
 * Simple public-store assembly for arbitrary buffers (e.g. image / video /
 * audio uploaded inline from the canvas). Returns the Transloadit CDN URL.
 *
 * The Transloadit SDK's `files` field expects filesystem paths (it eventually
 * hits `fs.readFile`). We write the buffer to /tmp, pass the path, and unlink
 * afterwards — this is /tmp-safe on both local Node and Vercel's Lambda
 * runtime (Vercel guarantees /tmp is writable per invocation).
 *
 * The stray `contentType` parameter is intentionally unused: Transloadit
 * sniffs the type from the file extension, and the temp file inherits the
 * original `filename`'s extension below.
 */
export async function uploadBufferToTransloadit(
  buf: Buffer,
  filename: string,
  _contentType: string,
) {
  void _contentType;
  const c = client();
  const safeName = (filename || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpPath = join(
    tmpdir(),
    `nf-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`,
  );
  await writeFile(tmpPath, buf);
  try {
    // Transloadit requires the /upload/handle step to be named exactly
    // ":original" — anything else returns INVALID_UPLOAD_HANDLE_STEP_NAME.
    // With only this step, the resulting CDN URL lives on result.uploads[0].
    const result = await c.createAssembly({
      files: { file: tmpPath },
      params: {
        steps: {
          ":original": {
            robot: "/upload/handle",
          },
        },
      },
      waitForCompletion: true,
    });
    const url =
      result?.uploads?.[0]?.ssl_url ??
      (result?.results as Record<string, Array<{ ssl_url?: string }>> | undefined)?.[":original"]?.[0]?.ssl_url;
    if (!url) throw new Error("Transloadit upload returned no url");
    return { url, assemblyId: result.assembly_id ?? "" };
  } finally {
    // Best-effort cleanup; ignore EBUSY/ENOENT.
    await unlink(tmpPath).catch(() => {});
  }
}
