export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManualUser } from "@/lib/manual-credits";

/** Stage 234 — DELETE /api/manual/history/[id] — remove one of the user's manual generations (no refund). */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const authed = await requireManualUser(request, "manual:history-delete");
  if ("response" in authed) return authed.response;
  const { id } = await ctx.params;
  const gen = await prisma.manualGeneration.findFirst({ where: { id, userId: authed.user.id }, select: { id: true } });
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.manualGeneration.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
