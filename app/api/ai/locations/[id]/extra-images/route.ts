export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { startLocationExtraImageJob, EXTRA_ANGLES_PER_REQUEST } from "@/lib/location-refs";

/**
 * POST /api/ai/locations/[id]/extra-images — generate N EXTRA angle shots of one location
 * (beyond the base 3). Body: { count?: number }. Charges CHARACTER_REFERENCE_COST per shot;
 * refunds any that fail. Idempotent while a job for the same location runs.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:location-extra-image", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;
    let count = EXTRA_ANGLES_PER_REQUEST;
    try {
      const body = await request.json();
      if (body && typeof body.count === "number") count = body.count;
    } catch { /* no body → default count */ }
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const location = await prisma.location.findFirst({ where: { id, project: { userId: user.id } } });
    if (!location) return NextResponse.json({ error: "Location not found" }, { status: 404 });
    const started = await startLocationExtraImageJob({ user, projectId: location.projectId, locationId: id, count });
    if ("error" in started) return NextResponse.json(started, { status: started.status });
    return NextResponse.json(started);
  } catch (err: any) {
    console.error("Location extra image error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
