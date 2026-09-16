export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, episodeModeSchema } from "@/lib/validations";

/**
 * Stage 127 — POST /api/ai/storyboard/mode  { episodeId, mode }  →  { mode }
 *
 * Choose the episode's PRODUCTION MODE after the story is built: "SCENES" (classic 9-scene pipeline)
 * or "STORYBOARD" (12–15 image-to-video boards). This only writes Episode.mode; it never deletes
 * scenes or boards, so an author can switch back and forth while deciding.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:storyboard-mode", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const parsed = await parseBody(request, episodeModeSchema);
  if (!parsed.ok) return parsed.response;
  const { episodeId, mode } = parsed.data;

  const owned = await prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId: session.user.id } } },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  await prisma.episode.update({ where: { id: episodeId }, data: { mode } });
  return NextResponse.json({ mode });
}
