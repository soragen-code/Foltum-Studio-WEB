export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { isChainMode } from "@/lib/chain-run";

/**
 * PATCH /api/ai/episodes/[id]/chain-mode { chainMode: "parallel" | "chain" }
 * Stage 40: how «Сгенерировать все» runs for this episode — all scenes at once (parallel, joined by
 * the scripted end-state) or strictly one after another (chain, joined by the ACTUAL last-frame
 * description). Changing the mode while a chain run is active also stops that run.
 * Ownership: episode → season → project → userId.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:chain-mode", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => null) as { chainMode?: unknown } | null;
  const chainMode = body?.chainMode;
  if (!isChainMode(chainMode)) return NextResponse.json({ error: "Некорректный режим: ожидается parallel или chain" }, { status: 400 });
  const episode = await prisma.episode.findFirst({ where: { id, season: { project: { userId: session.user.id } } }, select: { id: true, chainMode: true } });
  if (!episode) return NextResponse.json({ error: "Эпизод не найден" }, { status: 404 });
  const updated = await prisma.episode.update({
    where: { id: episode.id },
    data: { chainMode, ...(chainMode !== episode.chainMode ? { chainRunActive: false, chainRunNote: null } : {}) },
    select: { chainMode: true, chainRunActive: true, chainRunNote: true },
  });
  return NextResponse.json({ ok: true, ...updated });
}
