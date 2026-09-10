export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { failStaleJobs } from "@/lib/jobs";
import { ASSEMBLE_JOB_TYPE } from "@/lib/assemble-plan";

/**
 * GET /api/ai/assemble-episode/status?episodeId=...
 *
 * Returns the ACTIVE (pending/processing) episode_assemble job for this episode, if any, so the
 * client can auto-resume polling after a reload / navigation. Falls back to the most recent
 * assemble job for the episode (any status) as `lastJob` for reference.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const episodeId = url.searchParams.get("episodeId");
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId: session.user.id } } },
    select: { season: { select: { projectId: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const projectId = episode.season.projectId;
  await failStaleJobs({ projectId, type: ASSEMBLE_JOB_TYPE });

  const jobs = await prisma.generationJob.findMany({
    where: { projectId, type: ASSEMBLE_JOB_TYPE },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const forEpisode = jobs.filter((j) => {
    try { return JSON.parse(j.resultData ?? "{}")?.episodeId === episodeId; } catch { return false; }
  });
  const activeJob = forEpisode.find((j) => j.status === "pending" || j.status === "processing") ?? null;

  return NextResponse.json(
    { activeJobId: activeJob?.id ?? null, lastJobId: forEpisode[0]?.id ?? null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
