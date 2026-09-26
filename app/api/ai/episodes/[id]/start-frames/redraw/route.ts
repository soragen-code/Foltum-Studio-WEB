export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runRedrawStartFramesJob, REDRAW_START_FRAME_JOB_TYPE } from "@/lib/workers/redraw-start-frame-job";

/**
 * Simplified pipeline — step 9. POST /api/ai/episodes/[id]/start-frames/redraw
 * Redraws the start frames of ALL scenes of the episode that already have one (grid panels) at full
 * resolution — GPT Image 2.0, 9:16, 2K — with progress "Полноразмерные старт-кадры: X/N".
 * Idempotent: an active redraw job for the episode is returned as resumed. The grid is untouched.
 * GET → { job }
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:start-frame-redraw", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id: episodeId } = await ctx.params;

    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { userId: session.user.id } } },
      select: {
        id: true, season: { select: { projectId: true } },
        scenes: { where: { startFrameUrl: { not: null } }, orderBy: { number: "asc" }, select: { id: true } },
      },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    const sceneIds = episode.scenes.map((s) => s.id);
    if (sceneIds.length === 0) return NextResponse.json({ error: "Нет старт-кадров — сначала нарежьте лист / No start frames yet — slice the grid first" }, { status: 409 });
    const pid = episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: REDRAW_START_FRAME_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: REDRAW_START_FRAME_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"episodeId":"${episodeId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: {
        type: REDRAW_START_FRAME_JOB_TYPE, status: "pending", progress: 0, message: `Полноразмерные старт-кадры: 0/${sceneIds.length}`, projectId: pid,
        resultData: JSON.stringify({ episodeId, sceneIds, single: false }),
      },
    });
    runInBackground(() => runRedrawStartFramesJob(job.id, pid, episodeId, sceneIds));
    return NextResponse.json({ jobId: job.id, resumed: false, total: sceneIds.length });
  } catch (err: any) {
    console.error("Start frames redraw error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: episodeId } = await ctx.params;
  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId: session.user.id } } },
    select: { id: true, season: { select: { projectId: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const job = await prisma.generationJob.findFirst({
    where: { projectId: episode.season.projectId, type: REDRAW_START_FRAME_JOB_TYPE, resultData: { contains: `"episodeId":"${episodeId}"` } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ job });
}
