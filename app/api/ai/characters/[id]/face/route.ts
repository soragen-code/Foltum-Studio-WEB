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
import { USER_REF_MIME_EXT, USER_REF_MAX_BYTES } from "@/lib/character-user-refs";
import { requireFeature } from "@/lib/entitlements";

/**
 * Optional single "face photo" for a character — uploaded at character creation so the user can cast
 * their own face in the lead role. The photo is stored on Character.faceImageUrl (a public S3 URL) and
 * fed FIRST into every character reference generation (see combineFaceAndUserRefs).
 *
 * POST   multipart/form-data { file }  (image/jpeg|png|webp, ≤ 8 MB) → uploads to S3 (public key), replaces
 *        Character.faceImageUrl (deleting the previous photo best-effort). Returns { faceImageUrl }.
 * DELETE → clears Character.faceImageUrl (best-effort S3 delete). Returns { faceImageUrl: null }.
 * Ownership: character → project → userId. No credits are charged here (upload only, no generation).
 */
async function loadOwned(id: string, userId: string) {
  return prisma.character.findFirst({
    where: { id, project: { userId } },
    select: { id: true, faceImageUrl: true, refLocked: true },
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
    const limited = rateLimitByUser(request, "ai:character-face", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    // Feature gate: uploading a real face photo ("own_face") requires an active Basic+ subscription.
    const gateUser = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { subscriptionTier: true, subscriptionExpiresAt: true },
    });
    const denied = requireFeature(gateUser, "own_face");
    if (denied) return NextResponse.json(denied, { status: 403 });

    const { id } = await ctx.params;
    const char = await loadOwned(id, session.user.id);
    if (!char) return NextResponse.json({ error: "Character not found" }, { status: 404 });
    if (char.refLocked) return NextResponse.json({ error: "Character reference is locked — the photo cannot be changed" }, { status: 409 });

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
    const key = `${folderPrefix}public/character-face/${char.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const url = await uploadBufferToS3(buffer, key, mime);

    await prisma.character.update({ where: { id: char.id }, data: { faceImageUrl: url } });

    // Best-effort delete of the previously stored face photo (only our own public objects).
    if (char.faceImageUrl && char.faceImageUrl !== url) {
      const prevKey = keyFromPublicUrl(char.faceImageUrl);
      if (prevKey && prevKey.includes("/public/character-face/")) await deleteFile(prevKey).catch(() => {});
    }
    return NextResponse.json({ ok: true, faceImageUrl: url });
  } catch (err: any) {
    console.error("[characters/face] POST error:", err);
    return NextResponse.json({ error: "Failed to upload photo: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:character-face", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const { id } = await ctx.params;
    const char = await loadOwned(id, session.user.id);
    if (!char) return NextResponse.json({ error: "Character not found" }, { status: 404 });
    if (char.refLocked) return NextResponse.json({ error: "Character reference is locked — the photo cannot be changed" }, { status: 409 });

    if (char.faceImageUrl) {
      await prisma.character.update({ where: { id: char.id }, data: { faceImageUrl: null } });
      const key = keyFromPublicUrl(char.faceImageUrl);
      if (key && key.includes("/public/character-face/")) await deleteFile(key).catch(() => {});
    }
    return NextResponse.json({ ok: true, faceImageUrl: null });
  } catch (err: any) {
    console.error("[characters/face] DELETE error:", err);
    return NextResponse.json({ error: "Failed to delete photo: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
