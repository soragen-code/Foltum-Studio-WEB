export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, sceneModeSchema } from "@/lib/validations";

/**
 * PATCH /api/ai/episodes/[id]/scene-mode { sceneMode: "text" | "storyboard" }
 * Stage 64: how the scenes of this episode are generated — straight from text + references (as before)
 * or from an approved 9:16 storyboard frame per scene. Switching NEVER touches already rendered scenes
 * or existing storyboard frames — it only changes what the next generation does.
 * Ownership: episode → season → project → userId.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:scene-mode", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const parsed = await parseBody(request, sceneModeSchema);
  if (!parsed.ok) return parsed.response;
  const episode = await prisma.episode.findFirst({ where: { id, season: { project: { userId: session.user.id } } }, select: { id: true } });
  if (!episode) return NextResponse.json({ error: "Эпизод не найден" }, { status: 404 });
  const updated = await prisma.episode.update({ where: { id: episode.id }, data: { sceneMode: parsed.data.sceneMode }, select: { sceneMode: true } });
  return NextResponse.json({ ok: true, ...updated });
}
