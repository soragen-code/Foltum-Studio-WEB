export const dynamic = "force-dynamic";
export const maxDuration = 800; // hosts the shot_list worker via after(): one streaming Opus 5 call (minutes)

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runShotListJob, SHOT_LIST_JOB_TYPE } from "@/lib/workers/shot-list-job";

/**
 * SIMPLIFIED PIPELINE — step 5.
 *
 * POST /api/ai/episodes/[id]/shot-list → { jobId, resumed }
 *   Build the 5 × 5 shot list from the episode's plain-text screenplay (Claude Opus 5, streaming) and persist
 *   it as 25 Scene rows (one per beat, `Scene.beatMeta`). Replaces the episode's existing scenes.
 *   409 when the episode has no script; an active shot_list job for this episode is returned as `resumed`.
 *
 * GET /api/ai/episodes/[id]/shot-list → { job, scenes }
 *   Latest shot_list job for this episode + the current beat rows (for the table / resume after reload).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:shot-list", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    select: { id: true, script: true, season: { select: { projectId: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (!episode.script?.trim()) return NextResponse.json({ error: "Write the episode script first" }, { status: 409 });
  const projectId = episode.season.projectId;

  await failStaleJobs({ projectId, type: SHOT_LIST_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({
    where: { projectId, type: SHOT_LIST_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"episodeId":"${id}"` } },
    select: { id: true },
  });
  if (active) return NextResponse.json({ jobId: active.id, resumed: true });

  const job = await prisma.generationJob.create({
    data: { type: SHOT_LIST_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify({ episodeId: id }) },
  });
  runInBackground(() => runShotListJob(job.id, projectId, id));
  return NextResponse.json({ jobId: job.id, resumed: false });
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    select: {
      id: true,
      season: { select: { projectId: true } },
      scenes: { orderBy: { number: "asc" }, select: { id: true, number: true, title: true, action: true, shotType: true, locationDesc: true, beatMeta: true, startFrameUrl: true, videoUrl: true, status: true } },
    },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  await failStaleJobs({ projectId: episode.season.projectId, type: SHOT_LIST_JOB_TYPE });
  const job = await prisma.generationJob.findFirst({
    where: { projectId: episode.season.projectId, type: SHOT_LIST_JOB_TYPE, resultData: { contains: `"episodeId":"${id}"` } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ job, scenes: episode.scenes }, { headers: { "Cache-Control": "no-store" } });
}
