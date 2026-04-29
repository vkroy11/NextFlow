import sharp from "sharp";

/**
 * Crops `inputUrl` (http(s):// or data:image/...) to a percentage box and
 * returns the result as a data URL. Bypasses Transloadit so cropping works
 * without third-party auth — Gemini already inlines data URLs (see
 * src/lib/gemini.ts).
 */
export async function cropImageWithSharp(input: {
  inputUrl: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): Promise<{ url: string; bytes: number }> {
  const buffer = await loadImageBuffer(input.inputUrl);

  const meta = await sharp(buffer).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("could not determine image dimensions");

  const left = clamp(Math.round((input.x / 100) * W), 0, Math.max(0, W - 1));
  const top = clamp(Math.round((input.y / 100) * H), 0, Math.max(0, H - 1));
  const width = clamp(Math.round((input.w / 100) * W), 1, W - left);
  const height = clamp(Math.round((input.h / 100) * H), 1, H - top);

  const out = await sharp(buffer)
    .extract({ left, top, width, height })
    .jpeg({ quality: 88 })
    .toBuffer();

  const url = `data:image/jpeg;base64,${out.toString("base64")}`;
  return { url, bytes: out.byteLength };
}

async function loadImageBuffer(inputUrl: string): Promise<Buffer> {
  if (inputUrl.startsWith("data:")) {
    const commaIdx = inputUrl.indexOf(",");
    if (commaIdx === -1) throw new Error("malformed data url");
    const base64 = inputUrl.slice(commaIdx + 1);
    return Buffer.from(base64, "base64");
  }
  const res = await fetch(inputUrl);
  if (!res.ok) throw new Error(`fetch image failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
