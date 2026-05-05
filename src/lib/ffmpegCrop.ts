import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadBufferToTransloadit } from "@/lib/transloadit";

const execFileP = promisify(execFile);
// The ffmpeg() build extension exports FFMPEG_PATH=/usr/bin/ffmpeg in
// deployed images. Fall back to PATH locally (dev: brew install ffmpeg).
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Crops `inputUrl` to a percentage box (x,y,w,h are 0-100) using ffmpeg
 * inside the Trigger.dev worker. The user mandated ffmpeg even though
 * this is a still image, so the pipeline is a workaround:
 *   image → 1-frame mp4 → ffmpeg crop filter → mp4 → jpg
 * The result is uploaded back through Transloadit's `/upload/handle` so
 * downstream nodes get the same `{ url }` shape they did under the old
 * Transloadit/ImageMagick crop.
 */
export async function cropImageViaFfmpeg(input: {
  inputUrl: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<{ url: string }> {
  const workdir = await mkdtemp(join(tmpdir(), "nf-ffcrop-"));
  const inExt = inferImageExtension(input.inputUrl);
  const inPath = join(workdir, `in.${inExt}`);
  const vidPath = join(workdir, "video.mp4");
  const cropPath = join(workdir, "cropped.mp4");
  const outPath = join(workdir, "out.jpg");

  try {
    await fetchToFile(input.inputUrl, inPath);

    // Step A — image → 1-frame mp4. mpeg4 codec is in every stock ffmpeg
    // build (no libx264 dependency). The intermediate file is throwaway.
    await runFfmpeg([
      "-y", "-loop", "1", "-i", inPath,
      "-frames:v", "1", "-t", "1",
      "-c:v", "mpeg4", "-q:v", "2",
      "-pix_fmt", "yuv420p",
      vidPath,
    ]);

    // Step B — crop the mp4. iw/ih let ffmpeg compute pixels from the
    // 0-100 percentage box without a separate ffprobe round-trip.
    const cropExpr =
      `crop=iw*${input.w}/100:ih*${input.h}/100:` +
      `iw*${input.x}/100:ih*${input.y}/100`;
    await runFfmpeg([
      "-y", "-i", vidPath,
      "-vf", cropExpr,
      "-frames:v", "1",
      "-c:v", "mpeg4", "-q:v", "2",
      "-pix_fmt", "yuv420p",
      cropPath,
    ]);

    // Step C — mp4 → jpg.
    await runFfmpeg([
      "-y", "-i", cropPath,
      "-frames:v", "1", "-q:v", "2",
      outPath,
    ]);

    const buf = await readFile(outPath);
    const { url } = await uploadBufferToTransloadit(buf, "cropped.jpg", "image/jpeg");
    return { url };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    // execFile (not exec/shell) — no shell interpolation = no injection
    // even if a future caller forwards a hostile URL or path.
    await execFileP(FFMPEG, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const tail = (typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? "")
      .split("\n").slice(-12).join("\n");
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg failed: ${msg}\n${tail}`);
  }
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) throw new Error("malformed data url");
    await writeFile(dest, Buffer.from(url.slice(comma + 1), "base64"));
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch input: ${res.status} ${res.statusText}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

function inferImageExtension(url: string): string {
  if (url.startsWith("data:")) {
    const meta = url.slice(0, url.indexOf(",")) || "";
    const m = /data:image\/([a-zA-Z0-9.+-]+)/.exec(meta);
    return (m?.[1]?.split(";")[0] ?? "jpg").toLowerCase();
  }
  const m = /\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/.exec(url);
  const ext = (m?.[1] ?? "jpg").toLowerCase();
  return /^(jpg|jpeg|png|webp|gif|bmp|tiff)$/.test(ext) ? ext : "jpg";
}
