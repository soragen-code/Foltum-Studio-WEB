export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runRedrawStartFramesJob, REDRAW_START_FRAME_JOB_TYPE } from "@/lib/workers/redraw-start-frame-job";

/**
 * Simplified pipeline — step 9. POST /api/ai/scenes/[id]/start-frame
 * Redraws ONE scene's start frame at full resolution (GPT Image 2.0, 9:16, 2K) from the current grid panel +
 * location plate + cast refs. Overwrites Scene.startFrameUrl. The grid sheet itself is untouched.
 * Idempotent: an active redraw job that includes this scene is returned as resumed.
 * GET → { job } (latest redraw job touching this scene).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:start-frame-redraw", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id: sceneId } = await ctx.params;

    const scene = await prisma.scene.findFirst({
      where: { id: sceneId, episode: { season: { project: { userId: session.user.id } } } },
      select: { id: true, startFrameUrl: true, episodeId: true, episode: { select: { season: { select: { projectId: true } } } } },
    });
    if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
    if (!scene.startFrameUrl) return NextResponse.json({ error: "У сцены нет старт-кадра / The scene has no start frame yet" }, { status: 409 });
    const pid = scene.episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: REDRAW_START_FRAME_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: REDRAW_START_FRAME_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"${sceneId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: {
        type: REDRAW_START_FRAME_JOB_TYPE, status: "pending", progress: 0, message: "Рисуем...", projectId: pid,
        resultData: JSON.stringify({ episodeId: scene.episodeId, sceneIds: [sceneId], single: true }),
      },
    });
    runInBackground(() => runRedrawStartFramesJob(job.id, pid, scene.episodeId, [sceneId]));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Start frame redraw error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: sceneId } = await ctx.params;
  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, episode: { season: { project: { userId: session.user.id } } } },
    select: { id: true, startFrameUrl: true, episode: { select: { season: { select: { projectId: true } } } } },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
  const job = await prisma.generationJob.findFirst({
    where: { projectId: scene.episode.season.projectId, type: REDRAW_START_FRAME_JOB_TYPE, resultData: { contains: `"${sceneId}"` } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ job, startFrameUrl: scene.startFrameUrl });
}
