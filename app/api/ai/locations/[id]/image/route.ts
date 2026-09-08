export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { startLocationImageJob } from "@/lib/location-refs";

/**
 * POST /api/ai/locations/[id]/image — (re)generate the photoreal reference of one location.
 * Charges CHARACTER_REFERENCE_COST (same price as a character reference). Idempotent while a job runs.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:location-image", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const location = await prisma.location.findFirst({ where: { id, project: { userId: user.id } } });
    if (!location) return NextResponse.json({ error: "Location not found" }, { status: 404 });
    const started = await startLocationImageJob({ user, projectId: location.projectId, locationIds: [id] });
    if ("error" in started) return NextResponse.json(started, { status: started.status });
    return NextResponse.json(started);
  } catch (err: any) {
    console.error("Location image error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/** DELETE /api/ai/locations/[id] is not offered; locations are edited via revise. */
