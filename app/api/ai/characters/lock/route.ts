export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * POST /api/ai/characters/lock  { characterId }
 *
 * Stage 22 — "Save forever": finalize a character reference without regeneration.
 * Once locked, the references UI hides the prompt input, the revise button and the
 * save-forever button, and shows a lock badge. Locking persists across reloads.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:character-lock", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    let body: any = {};
    try { body = await request.json(); } catch { body = {}; }
    const characterId = typeof body?.characterId === "string" ? body.characterId : "";
    if (!characterId) return NextResponse.json({ error: "characterId is required" }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const character = await prisma.character.findFirst({
      where: { id: characterId, project: { userId: user.id } },
    });
    if (!character) return NextResponse.json({ error: "Character not found" }, { status: 404 });

    const updated = await prisma.character.update({
      where: { id: characterId },
      data: { refLocked: true },
    });

    return NextResponse.json({ character: updated });
  } catch (err: any) {
    console.error("Character lock error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
