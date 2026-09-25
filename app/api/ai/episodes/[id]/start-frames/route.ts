export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runStartFramesJob, START_FRAMES_JOB_TYPE } from "@/lib/workers/start-frames-job";

/**
 * Simplified pipeline — step 9. POST /api/ai/episodes/[id]/start-frames  { all?: true, sceneIds?: string[] }
 * Renders one 9:16 start frame per beat scene (GPT Image 2.0, parallel) using the episode plate + cast refs.
 * Idempotent: an active start_frames job for the episode is returned as resumed.
 * GET → { job, scenes: [{ id, number, title, startFrameUrl }] }
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:start-frames", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id: episodeId } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const sceneIds: string[] | null =
      body?.all === true || !Array.isArray(body?.sceneIds)
        ? null
        : (body.sceneIds as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 25);

    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { userId: session.user.id } } },
      select: { id: true, season: { select: { projectId: true } }, _count: { select: { scenes: true } } },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    if (episode._count.scenes === 0) return NextResponse.json({ error: "Сначала создайте шот-лист / Build the shot list first" }, { status: 409 });
    const pid = episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: START_FRAMES_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: START_FRAMES_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"episodeId":"${episodeId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: START_FRAMES_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId: pid, resultData: JSON.stringify({ episodeId, sceneIds }) },
    });
    runInBackground(() => runStartFramesJob(job.id, pid, episodeId, sceneIds));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Start frames error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: episodeId } = await ctx.params;
  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId: session.user.id } } },
    select: { id: true, season: { select: { projectId: true } }, scenes: { orderBy: { number: "asc" }, select: { id: true, number: true, title: true, startFrameUrl: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const job = await prisma.generationJob.findFirst({
    where: { projectId: episode.season.projectId, type: START_FRAMES_JOB_TYPE, resultData: { contains: `"episodeId":"${episodeId}"` } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ job, scenes: episode.scenes });
}
