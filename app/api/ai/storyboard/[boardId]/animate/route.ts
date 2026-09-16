export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runBoardVideoJob, BOARD_VIDEO_JOB_TYPE } from "@/lib/workers/storyboard-job";

/**
 * Stage 127 — POST /api/ai/storyboard/[boardId]/animate  →  { jobId, resumed }
 *
 * Animate one board's 9:16 keyframe still into a 4-6s clip via IMAGE-TO-VIDEO (the still is the START
 * frame). This is the Storyboard-only path where the keyframe/i2v ban is intentionally lifted; the ban
 * remains in force for SCENES (text-to-video, no start-frame pose). Idempotent per board.
 */
export async function POST(request: Request, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:board-animate", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const { boardId } = await ctx.params;
    const board = await prisma.board.findFirst({
      where: { id: boardId, episode: { mode: "STORYBOARD", season: { project: { userId: session.user.id } } } },
      select: { id: true, imageUrl: true, episode: { select: { season: { select: { projectId: true } } } } },
    });
    if (!board) return NextResponse.json({ error: "Board not found" }, { status: 404 });
    if (!board.imageUrl) {
      return NextResponse.json({ error: "Generate the board frame before animating it" }, { status: 400 });
    }
    const pid = board.episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: BOARD_VIDEO_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: BOARD_VIDEO_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"boardId":"${boardId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: BOARD_VIDEO_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId: pid, resultData: JSON.stringify({ boardId }) },
    });
    runInBackground(() => runBoardVideoJob(job.id, pid, boardId));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Board animate error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
