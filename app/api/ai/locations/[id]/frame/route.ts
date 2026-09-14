export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, locationFrameDeleteSchema } from "@/lib/validations";
import { parseLocationExtra } from "@/lib/visual-style";
import { removeLocationFrame } from "@/lib/location-frames";

/**
 * Stage 46E — DELETE /api/ai/locations/[id]/frame  { slot: "master"|"reverse"|"detail"|"extra", index? }
 *
 * Removes ONE reference frame of the location. At least one frame must remain (400 otherwise). Deleting the
 * master promotes the first remaining frame into `imageUrl` (see lib/location-frames.ts). Rendered scenes of
 * episodes bound to this location are marked lookStale. No storage deletion, no refunds.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:location-frame", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const parsed = await parseBody(request, locationFrameDeleteSchema);
  if (!parsed.ok) return parsed.response;
  const { slot, index } = parsed.data;
  if (slot === "extra" && index === undefined) return NextResponse.json({ error: "An additional frame requires index" }, { status: 400 });

  const loc = await prisma.location.findFirst({
    where: { id, project: { userId: session.user.id } },
    select: { id: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true },
  });
  if (!loc) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  const result = removeLocationFrame(
    { imageUrl: loc.imageUrl, imageReverse: loc.imageReverse, imageDetail: loc.imageDetail, extras: parseLocationExtra(loc.imageExtra) },
    slot === "layout" ? "reverse" : slot, // Stage 111: "layout" = the mandatory elevated view stored in imageReverse (locked)
    index
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const s = result.state;
  const updated = await prisma.location.update({
    where: { id: loc.id },
    data: { imageUrl: s.imageUrl, imageReverse: s.imageReverse, imageDetail: s.imageDetail, imageExtra: s.extras.length ? JSON.stringify(s.extras) : null },
  });
  // The reference set changed → rendered scenes in this location no longer match it.
  await prisma.scene.updateMany({ where: { episode: { locationId: loc.id }, videoUrl: { not: null } }, data: { lookStale: true } });

  return NextResponse.json({ ok: true, location: updated });
}
