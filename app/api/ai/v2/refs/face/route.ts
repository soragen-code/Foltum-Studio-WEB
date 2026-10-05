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
import { episodeRefsV2From } from "@/lib/idea-v2";
import { patchEpisodeRefV2 } from "@/lib/episode-refs-v2-store";
import { denyFeature } from "@/lib/feature-gate";

/**
 * Поток v2 · пользовательское фото-референс для рефа ПЕРСОНАЖА серии n.
 * Пользователь прикрепляет своё фото, и внешность персонажа генерируется похожей на него
 * (фото подаётся первым в image_input генерации изображения рефа — см. episode-ref-images-v2-job).
 * Хранится в EpisodeRefV2.userRefUrl (публичный S3 URL) внутри Project.episodeRefsV2 (JSON).
 *
 * POST   multipart/form-data { projectId, episode, id, file } (image/jpeg|png|webp, ≤ 8 МБ)
 *        → загрузка в S3 (public key), запись userRefUrl, удаление прежнего фото best-effort. Возвращает { userRefUrl }.
 * DELETE multipart/form-data { projectId, episode, id } → очистка userRefUrl (S3 delete best-effort). Возвращает { userRefUrl: null }.
 * Фича «own_references» (Studio). Владение: ref → project → userId. Кредиты не списываются (только загрузка).
 */
async function ownedRef(email: string, projectId: string, episode: number, id: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return { denied: "Unauthorized" as const };
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, episodeRefsV2: true } });
  if (!project) return { denied: "Project not found" as const };
  const ref = episodeRefsV2From(project.episodeRefsV2, episode).find((r) => r.id === id);
  if (!ref) return { denied: "Reference not found" as const };
  if (ref.kind !== "character") return { denied: "Only character references support a face photo" as const };
  return { ref };
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

function parseIds(form: FormData): { projectId: string; episode: number; id: string } | null {
  const projectId = String(form.get("projectId") ?? "").trim();
  const id = String(form.get("id") ?? "").trim();
  const episode = Number(form.get("episode"));
  if (!projectId || !id || !Number.isInteger(episode) || episode < 1 || episode > 999) return null;
  return { projectId, episode, id };
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) return NextResponse.json({ error: "Login required" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
    const limited = rateLimitByUser(request, "ai:v2:refs-face", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    // Feature gate: uploading a real face photo ("own_references") requires an active Studio subscription.
    const gateUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { subscriptionTier: true, subscriptionExpiresAt: true } });
    const denied = requireFeature(gateUser, "own_references");
    if (denied) return NextResponse.json(denied, { status: 403 });

    let form: FormData;
    try { form = await request.formData(); } catch { return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 }); }
    const ids = parseIds(form);
    if (!ids) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

    const owned = await ownedRef(session.user.email, ids.projectId, ids.episode, ids.id);
    if ("denied" in owned) {
      const status = owned.denied === "Unauthorized" ? 401 : owned.denied === "Project not found" || owned.denied === "Reference not found" ? 404 : 409;
      return NextResponse.json({ error: owned.denied }, { status });
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
    const key = `${folderPrefix}public/v2-ref-face/${ids.projectId}/${ids.episode}/${ids.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const url = await uploadBufferToS3(buffer, key, mime);

    await patchEpisodeRefV2(ids.projectId, ids.episode, ids.id, { userRefUrl: url });

    // Best-effort delete of the previously stored photo (only our own public objects).
    const prev = owned.ref.userRefUrl;
    if (prev && prev !== url) {
      const prevKey = keyFromPublicUrl(prev);
      if (prevKey && prevKey.includes("/public/v2-ref-face/")) await deleteFile(prevKey).catch(() => {});
    }
    return NextResponse.json({ ok: true, userRefUrl: url });
  } catch (err: any) {
    console.error("[v2/refs/face] POST error:", err);
    return NextResponse.json({ error: "Failed to upload photo: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) return NextResponse.json({ error: "Login required" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
    const limited = rateLimitByUser(request, "ai:v2:refs-face", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    let form: FormData;
    try { form = await request.formData(); } catch { return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 }); }
    const ids = parseIds(form);
    if (!ids) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

    const owned = await ownedRef(session.user.email, ids.projectId, ids.episode, ids.id);
    if ("denied" in owned) {
      const status = owned.denied === "Unauthorized" ? 401 : owned.denied === "Project not found" || owned.denied === "Reference not found" ? 404 : 409;
      return NextResponse.json({ error: owned.denied }, { status });
    }

    const prev = owned.ref.userRefUrl;
    if (prev) {
      await patchEpisodeRefV2(ids.projectId, ids.episode, ids.id, { userRefUrl: null });
      const key = keyFromPublicUrl(prev);
      if (key && key.includes("/public/v2-ref-face/")) await deleteFile(key).catch(() => {});
    }
    return NextResponse.json({ ok: true, userRefUrl: null });
  } catch (err: any) {
    console.error("[v2/refs/face] DELETE error:", err);
    return NextResponse.json({ error: "Failed to delete photo: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
