export const dynamic = "force-dynamic";
export const maxDuration = 300; // перевод фреймов/меток на English при первом построении

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { ensureStoryboardV2AutoPrompt } from "@/lib/storyboard-v2-prompt";
import { setEpisodeStoryboardV2 } from "@/lib/episode-storyboard-v2-store";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * Поток v2 · кнопка «Промпт» на вкладке «Сториборд».
 * POST { projectId, episode, force? } → { autoPrompt, cached, refs }:
 *  промпт уже построен и актуален для текущих шотов/рефов → отдаётся сразу из кэша;
 *  иначе строится (перевод «Фрейма» каждого шота + меток рефов), сохраняется и отдаётся.
 */
const schema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(1).max(999), force: z.boolean().optional() });

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:v2:storyboard:prompt", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const deniedView = await denyFeature(session.user.email, "prompt_view"); if (deniedView) return deniedView; // просмотр промпта — Studio
    const { projectId, episode, force } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    const project = user
      ? await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, episodeShotsV2: true, episodeRefsV2: true, episodeStoryboardV2: true } })
      : null;
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // «Пересобрать» (force): авто-промпт строится заново по актуальным шотам/рефам из БД, ручной override сбрасывается.
    if (force) await setEpisodeStoryboardV2(projectId, episode, { promptOverride: null });
    const built = await ensureStoryboardV2AutoPrompt(projectId, episode, project, { force });
    if (!built.autoPrompt) return NextResponse.json({ error: "Сначала разбейте сценарий на кадры" }, { status: 400 });
    const refs = built.inputs.refs.map((r) => ({ id: r.id, label: r.label, kind: r.kind, imageUrl: r.imageUrl }));
    return NextResponse.json({ autoPrompt: built.autoPrompt, cached: built.cached, refs }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.error("Episode storyboard v2 prompt error:", err);
    return NextResponse.json({ error: "Prompt build failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
