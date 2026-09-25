export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import {
  runStoryboardGridSliceJob,
  STORYBOARD_GRID_SLICE_JOB_TYPE,
} from "@/lib/workers/storyboard-grid-job";

/**
 * Stage 240 — POST /api/ai/storyboard/grid/approve  { episodeId }  →  { jobId, resumed }
 *
 * Approve the rendered 5×5 sheet and slice it into 25 per-scene start frames (background job). Requires a
 * generated grid (Episode.gridUrl). Idempotent: an active slice job for the episode is returned instead.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:storyboard-grid-approve", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const body = await request.json().catch(() => ({}));
    const episodeId = typeof body?.episodeId === "string" ? body.episodeId : "";
    if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { userId: session.user.id } } },
      select: { id: true, gridUrl: true, season: { select: { projectId: true } } },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    if (!episode.gridUrl) return NextResponse.json({ error: "Сначала сгенерируйте лист сториборда" }, { status: 400 });
    const pid = episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: STORYBOARD_GRID_SLICE_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: STORYBOARD_GRID_SLICE_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"episodeId":"${episodeId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: STORYBOARD_GRID_SLICE_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId: pid, resultData: JSON.stringify({ episodeId }) },
    });
    runInBackground(() => runStoryboardGridSliceJob(job.id, pid, episodeId));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Storyboard grid approve error:", err);
    return NextResponse.json({ error: "Approve failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
