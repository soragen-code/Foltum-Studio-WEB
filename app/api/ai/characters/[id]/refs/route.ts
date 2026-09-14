export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { getBucketConfig } from "@/lib/aws-config";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { deleteFile } from "@/lib/s3";
import { parseUserRefs, USER_REFS_MAX, USER_REF_MIME_EXT, USER_REF_MAX_BYTES } from "@/lib/character-user-refs";

/**
 * Stage 75 — user-uploaded photo references for a character (fed as image_input to every reference shot).
 *
 * POST   multipart/form-data { file }  (image/jpeg|png|webp, ≤ 8 MB) → uploads to S3 (public key), appends
 *        the URL to Character.userRefs (max USER_REFS_MAX → 409). Returns { userRefs }.
 * DELETE JSON { url } → removes the URL from userRefs (best-effort S3 delete). Returns { userRefs }.
 * Ownership: character → project → userId. No credits are charged here.
 */
async function loadOwned(id: string, userId: string) {
  return prisma.character.findFirst({
    where: { id, project: { userId } },
    select: { id: true, projectId: true, userRefs: true, refLocked: true },
  });
}

/** Bucket key of a public S3 URL produced by uploadBufferToS3, or null when it is not ours. */
function keyFromPublicUrl(url: string): string | null {
  const { bucketName } = getBucketConfig();
  if (!bucketName) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.startsWith(`${bucketName}.s3.`)) return null;
    const key = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    return key || null;
  } catch {
    return null;
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:character-refs", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const { id } = await ctx.params;
    const char = await loadOwned(id, session.user.id);
    if (!char) return NextResponse.json({ error: "Character not found" }, { status: 404 });
    if (char.refLocked) return NextResponse.json({ error: "Character reference is locked — the photo cannot be changed" }, { status: 409 });

    const current = parseUserRefs(char.userRefs);
    if (current.length >= USER_REFS_MAX) return NextResponse.json({ error: "Up to 4 photo references", userRefs: current }, { status: 409 });

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "Expected multipart/form-data with a file field" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const mime = (file.type || "").toLowerCase() === "image/jpg" ? "image/jpeg" : (file.type || "").toLowerCase();
    const ext = USER_REF_MIME_EXT[mime];
    if (!ext) return NextResponse.json({ error: "Only JPEG, PNG, and WebP are supported" }, { status: 415 });
    if (file.size <= 0) return NextResponse.json({ error: "Empty file" }, { status: 400 });
    if (file.size > USER_REF_MAX_BYTES) return NextResponse.json({ error: "File is larger than 8 MB" }, { status: 413 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const { folderPrefix } = getBucketConfig();
    // RULE: public assets must live under `${folderPrefix}public/...` (otherwise 403).
    const key = `${folderPrefix}public/character-refs/${char.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const url = await uploadBufferToS3(buffer, key, mime);

    // Re-read to avoid clobbering a concurrent upload, then append.
    const fresh = await prisma.character.findUnique({ where: { id: char.id }, select: { userRefs: true } });
    const list = parseUserRefs(fresh?.userRefs);
    if (list.length >= USER_REFS_MAX) {
      await deleteFile(key).catch(() => {});
      return NextResponse.json({ error: "Up to 4 photo references", userRefs: list }, { status: 409 });
    }
    const userRefs = [...list, url];
    await prisma.character.update({ where: { id: char.id }, data: { userRefs: JSON.stringify(userRefs) } });
    return NextResponse.json({ ok: true, userRefs });
  } catch (err: any) {
    console.error("[characters/refs] POST error:", err);
    return NextResponse.json({ error: "Failed to upload photo: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:character-refs", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const { id } = await ctx.params;
    const char = await loadOwned(id, session.user.id);
    if (!char) return NextResponse.json({ error: "Character not found" }, { status: 404 });
    if (char.refLocked) return NextResponse.json({ error: "Character reference is locked — the photo cannot be changed" }, { status: 409 });

    let body: { url?: unknown } = {};
    try { body = await request.json(); } catch { body = {}; }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return NextResponse.json({ error: "No url specified" }, { status: 400 });

    const list = parseUserRefs(char.userRefs);
    const userRefs = list.filter((u) => u !== url);
    if (userRefs.length !== list.length) {
      await prisma.character.update({ where: { id: char.id }, data: { userRefs: userRefs.length ? JSON.stringify(userRefs) : null } });
      const key = keyFromPublicUrl(url);
      if (key && key.includes("/public/character-refs/")) await deleteFile(key).catch(() => {});
    }
    return NextResponse.json({ ok: true, userRefs });
  } catch (err: any) {
    console.error("[characters/refs] DELETE error:", err);
    return NextResponse.json({ error: "Failed to delete photo: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
