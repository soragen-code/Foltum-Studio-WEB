export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * Stage 60 — POST /api/ai/locations/[id]/undo
 *
 * One-step undo: restores the location fields saved into `prevSnapshot` by the last mutating
 * edit (revise / image regeneration) — text AND previous reference images — then clears the
 * snapshot. No-op (404) when there is nothing to undo.
 * Ownership: location → project → userId.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:location-undo", session.user.email, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const location = await prisma.location.findFirst({ where: { id, project: { userId: user.id } } });
  if (!location) return NextResponse.json({ error: "Локация не найдена" }, { status: 404 });

  const snap = location.prevSnapshot as Record<string, unknown> | null;
  if (!snap) return NextResponse.json({ error: "Нечего отменять" }, { status: 404 });

  const { kind, ...fields } = snap;
  void kind;
  const updated = await prisma.location.update({
    where: { id },
    data: { ...fields, prevSnapshot: null },
  });
  // Keep bound episodes' display fields in sync when name/description are part of the restore.
  if ("name" in fields || "description" in fields) {
    await prisma.episode.updateMany({
      where: { locationId: id },
      data: { locationName: updated.name, locationDesc: updated.description },
    }).catch(() => {});
  }
  return NextResponse.json({ ok: true, location: updated });
}
