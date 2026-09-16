export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runBoardImageJob, BOARD_IMAGE_JOB_TYPE } from "@/lib/workers/storyboard-job";

/**
 * Stage 127 — POST /api/ai/storyboard/[boardId]/frame  →  { jobId, resumed }
 *
 * Render one board's 9:16 keyframe still (Seedream). The still becomes the START frame of the board's
 * image-to-video clip. Idempotent per board.
 */
export async function POST(request: Request, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:board-frame", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const { boardId } = await ctx.params;
    const board = await prisma.board.findFirst({
      where: { id: boardId, episode: { mode: "STORYBOARD", season: { project: { userId: session.user.id } } } },
      select: { id: true, episode: { select: { season: { select: { projectId: true } } } } },
    });
    if (!board) return NextResponse.json({ error: "Board not found" }, { status: 404 });
    const pid = board.episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: BOARD_IMAGE_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: BOARD_IMAGE_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"boardId":"${boardId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: BOARD_IMAGE_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId: pid, resultData: JSON.stringify({ boardId }) },
    });
    runInBackground(() => runBoardImageJob(job.id, pid, boardId));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Board frame error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
