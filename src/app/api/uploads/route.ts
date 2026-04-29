import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { uploadBufferToTransloadit } from "@/lib/transloadit";

export const runtime = "nodejs";

// Per-request hard cap so a stray gigabyte file doesn't OOM the function.
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Receives a multipart upload from the canvas, hands the buffer to
 * Transloadit, and returns the resulting CDN URL. Workflow JSON then stores
 * just the URL — no base64 bloat in Postgres, no data-URL strings flowing
 * through downstream tasks.
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", limitBytes: MAX_BYTES },
      { status: 413 },
    );
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { url, assemblyId } = await uploadBufferToTransloadit(
      buf,
      file.name || "upload",
      file.type || "application/octet-stream",
    );
    return NextResponse.json({ url, name: file.name, assemblyId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "upload_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
