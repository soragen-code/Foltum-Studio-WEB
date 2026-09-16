export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, storyboardBoardsSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runStoryboardBoardsJob, STORYBOARD_BOARDS_JOB_TYPE } from "@/lib/workers/storyboard-job";

/**
 * Stage 127 — POST /api/ai/storyboard/boards  { projectId?, episodeId }  →  { jobId, resumed }
 *
 * Split a STORYBOARD-mode episode's story into 12–15 boards (LLM). Runs as a background job (like the
 * scenes breakdown). Idempotent: an active split job for the episode is returned instead of a second one.
 *
 * GET /api/ai/storyboard/boards?projectId=...&episodeId=...  →  { boards, job }
 *   the persisted boards (with frame / clip status) + the latest split job, for the client to resume.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:storyboard-boards", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, storyboardBoardsSchema);
    if (!parsed.ok) return parsed.response;
    const { episodeId } = parsed.data;

    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { userId: session.user.id } } },
      select: { id: true, mode: true, season: { select: { projectId: true } } },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    if (episode.mode !== "STORYBOARD")
      return NextResponse.json({ error: "Episode is not in STORYBOARD mode" }, { status: 400 });
    const pid = episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: STORYBOARD_BOARDS_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: STORYBOARD_BOARDS_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"episodeId":"${episodeId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: STORYBOARD_BOARDS_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId: pid, resultData: JSON.stringify({ episodeId }) },
    });
    runInBackground(() => runStoryboardBoardsJob(job.id, pid, episodeId));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Storyboard boards error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const episodeId = url.searchParams.get("episodeId") ?? "";
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId: session.user.id } } },
    select: { id: true, mode: true, videoUrl: true, season: { select: { projectId: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const projectId = episode.season.projectId;

  const boards = await prisma.board.findMany({ where: { episodeId }, orderBy: { index: "asc" } });
  await failStaleJobs({ projectId, type: STORYBOARD_BOARDS_JOB_TYPE });
  const job = await prisma.generationJob.findFirst({
    where: { projectId, type: STORYBOARD_BOARDS_JOB_TYPE, resultData: { contains: `"episodeId":"${episodeId}"` } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    { mode: episode.mode, videoUrl: episode.videoUrl, boards, job },
    { headers: { "Cache-Control": "no-store" } },
  );
}
