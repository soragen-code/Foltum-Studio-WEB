export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * Stage 60 — POST /api/ai/scenes/[id]/undo
 *
 * One-step undo: restores the scene fields saved into `prevSnapshot` by the last revise —
 * previous scene text AND the previously rendered clip URL — then clears the snapshot.
 * No-op (404) when there is nothing to undo.
 * Ownership: scene → episode → season → project → userId.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:scene-undo", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  const snap = scene.prevSnapshot as Record<string, unknown> | null;
  if (!snap) return NextResponse.json({ error: "Nothing to undo" }, { status: 404 });

  const { kind, ...fields } = snap;
  void kind;
  const updated = await prisma.scene.update({
    where: { id },
    data: { ...fields, prevSnapshot: null },
  });
  return NextResponse.json({ ok: true, scene: updated });
}
