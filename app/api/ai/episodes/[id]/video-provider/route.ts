export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { videoProviderSchema } from "@/lib/validations";

/**
 * PATCH /api/ai/episodes/[id]/video-provider { videoProvider: "seedance" | "kling" }
 * Stage 47: which video model renders the scenes of this episode — Seedance 2.5 (Replicate, default)
 * or Kling 3.0 Omni (multi-image reference). Read by the video worker at job start; already running
 * jobs keep the provider they were submitted with.
 * Ownership: episode → season → project → userId.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:video-provider", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => null);
  const parsed = videoProviderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Некорректная модель видео: ожидается seedance или kling" }, { status: 400 });
  const episode = await prisma.episode.findFirst({ where: { id, season: { project: { userId: session.user.id } } }, select: { id: true } });
  if (!episode) return NextResponse.json({ error: "Эпизод не найден" }, { status: 404 });
  const updated = await prisma.episode.update({
    where: { id: episode.id },
    data: { videoProvider: parsed.data.videoProvider },
    select: { videoProvider: true },
  });
  return NextResponse.json({ ok: true, ...updated });
}
