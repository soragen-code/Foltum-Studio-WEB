export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * Stage 60 — POST /api/ai/characters/[id]/undo
 *
 * One-step undo: restores the character fields saved into `prevSnapshot` by the last mutating
 * edit (revise / appearance / regenerate) — including previous text AND previous generated images —
 * then clears the snapshot. No-op (404) when there is nothing to undo.
 * Ownership: character → project → userId.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:character-undo", session.user.email, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const character = await prisma.character.findFirst({ where: { id, project: { userId: user.id } } });
  if (!character) return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });

  const snap = character.prevSnapshot as Record<string, unknown> | null;
  if (!snap) return NextResponse.json({ error: "Нечего отменять" }, { status: 404 });

  const { kind, ...fields } = snap;
  void kind;
  const updated = await prisma.character.update({
    where: { id },
    data: { ...fields, prevSnapshot: null },
  });
  return NextResponse.json({ ok: true, character: updated });
}
