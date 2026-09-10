export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * POST /api/ai/locations/[id]/lock
 *
 * Stage 22 — "Сохранить навсегда": finalize a location reference without regeneration.
 * Once locked, the references UI hides the prompt input, the revise button and the
 * save-forever button, and shows a lock badge. Locking persists across reloads.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:location-lock", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const { id } = await ctx.params;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const location = await prisma.location.findFirst({
      where: { id, project: { userId: user.id } },
    });
    if (!location) return NextResponse.json({ error: "Location not found" }, { status: 404 });

    const updated = await prisma.location.update({
      where: { id },
      data: { refLocked: true },
    });

    return NextResponse.json({ location: updated });
  } catch (err: any) {
    console.error("Location lock error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
