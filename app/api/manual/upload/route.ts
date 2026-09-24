export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { requireManualUser } from "@/lib/manual-credits";

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Stage 234 — POST /api/manual/upload (multipart, field "file") → { url } public S3 URL of a reference image. */
export async function POST(request: Request) {
  const authed = await requireManualUser(request, "manual:upload");
  if ("response" in authed) return authed.response;
  let form: FormData;
  try { form = await request.formData(); } catch { return NextResponse.json({ error: "Invalid form data" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "File is required" }, { status: 400 });
  const type = file.type || "image/png";
  if (!ALLOWED.has(type)) return NextResponse.json({ error: "Only PNG, JPEG or WebP images are allowed" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File is too large (max 15 MB)" }, { status: 400 });
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const buffer = Buffer.from(await file.arrayBuffer());
  const key = `manual/${authed.user.id}/refs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const url = await uploadBufferToS3(buffer, key, type);
  return NextResponse.json({ url });
}
