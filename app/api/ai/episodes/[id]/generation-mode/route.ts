export const dynamic = "force-dynamic";
export const maxDuration = 300; // building a shot plan is a text-only LLM call (no paid video generation)

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, generationModeSchema } from "@/lib/validations";
import { persistShotPlanForApprovedEpisode } from "@/lib/workers/shot-plan-persist";

/**
 * POST /api/ai/episodes/[id]/generation-mode  { mode: "scene" | "shots" }  →  { mode, shotPlan? }
 *
 * Choose the episode's VIDEO GENERATION MODE after the storyboard is ready:
 *   • "scene" (default) — 1 scene = 1 prompt = 1 clip. The classic per-scene chain.
 *   • "shots" (optional «Шоты» mode) — the shot is the atomic unit.
 *
 * Switching to «Шоты» transparently BUILDS the shot plan (a pure LLM planning call — FREE, not paid
 * video generation) so the producer can review/edit it. It NEVER starts any paid rendering; the
 * producer explicitly triggers generation afterwards from the normal generate endpoints.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:generation-mode", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const parsed = await parseBody(request, generationModeSchema);
  if (!parsed.ok) return parsed.response;
  const { mode } = parsed.data;

  const owned = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    select: { id: true, status: true },
  });
  if (!owned) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  await prisma.episode.update({ where: { id }, data: { generationMode: mode } }).catch((e) => {
    console.warn("Could not persist episode.generationMode (column missing?):", (e as any)?.message);
  });

  // «Шоты»: build the shot plan up front (FREE text-only LLM planning) so it can be reviewed/edited.
  // This must NOT start any paid video rendering.
  let shotPlan: { ok: boolean; reason?: string } | null = null;
  if (mode === "shots") {
    const existing = await prisma.shot.count({ where: { scene: { episodeId: id } } });
    if (existing === 0 && owned.status !== "shot_plan_failed") {
      const result = await persistShotPlanForApprovedEpisode(id).catch((e) => ({ ok: false, reason: (e as any)?.message ?? "shot plan failed" }));
      shotPlan = { ok: result.ok, reason: (result as { reason?: string }).reason };
    } else {
      shotPlan = { ok: existing > 0 };
    }
  }

  return NextResponse.json({ mode, shotPlan });
}
