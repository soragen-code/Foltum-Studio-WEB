export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { episodeRefsV2From, inheritEpisodeRefsV2 } from "@/lib/idea-v2";
import { setEpisodeRefsV2, activeEpisodeJob } from "@/lib/episode-refs-v2-store";
import { EPISODE_REF_IMAGES_V2_JOB_TYPE } from "@/lib/workers/episode-ref-images-v2-job";
import { denyFeature } from "@/lib/feature-gate";

/**
 * Поток v2 · рефы серии n: взять те же рефы из ранних серий (1..n-1) без генерации и без списания кредитов.
 * POST { projectId, episode } → { items, inherited }. Совпавшие персонажи/локации/реквизит получают картинку,
 * промпт и фото-референс источника и помечаются inheritedFrom (источник из ранней серии побеждает всегда).
 */
const schema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(2).max(999) });

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
    const limited = rateLimitByUser(request, "ai:v2:refs:inherit", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, episode } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, episodeRefsV2: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (await activeEpisodeJob(projectId, EPISODE_REF_IMAGES_V2_JOB_TYPE, episode)) return NextResponse.json({ error: "Reference images are being generated" }, { status: 409 });

    const current = episodeRefsV2From(project.episodeRefsV2, episode);
    if (!current.length) return NextResponse.json({ error: "No references in this episode" }, { status: 400 });
    const { items, inherited } = inheritEpisodeRefsV2(project.episodeRefsV2, episode, current, true);
    if (inherited) await setEpisodeRefsV2(projectId, episode, items);
    return NextResponse.json({ items, inherited });
  } catch (err: any) {
    console.error("Episode refs inherit v2 error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
