/**
 * POSTs a File to /api/uploads and returns the Transloadit CDN URL. Used by
 * every upload UI on the canvas (Request-Inputs, Input, Crop, Gemini) so the
 * file lives at a real URL from the moment it leaves the user's machine —
 * no base64 data URLs in node data, no megabyte JSON in Postgres.
 */
export async function uploadFile(file: File): Promise<{ url: string; name: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body: formData });
  if (!res.ok) {
    let message = `upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as { url: string; name: string };
}
