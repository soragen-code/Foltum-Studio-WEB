export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, storyboardBoardsSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runStoryboardBoardsJob, STORYBOARD_BOARDS_JOB_TYPE, BOARD_IMAGE_JOB_TYPE, BOARD_VIDEO_JOB_TYPE } from "@/lib/workers/storyboard-job";
import { selectAuthoritativeBoardJob } from "@/lib/board-job-select";
import { gatherMissingAssets, reconcileEpisodeAssets } from "@/lib/asset-gathering";

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

    // Stage 174 — ASSET GATHERING GATE: before splitting the story into boards, make sure every character
    // and location reference the boards will consume already exists. If any are missing, charge + kick off
    // their generation via the EXISTING reference workers and DO NOT start the split; the advance-chains cron
    // resumes the split automatically once all assets are ready (no open tab needed). An episode whose assets
    // are all present reconciles with blockingMissing === 0 and passes straight through — no charge, no delay
    // (exactly the pre-Stage-174 behaviour).
    const recon = await reconcileEpisodeAssets(episodeId);
    if (recon.blockingMissing > 0) {
      const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, credits: true } });
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
      const gathered = await gatherMissingAssets({ user, projectId: pid, episodeId });
      if (gathered.insufficientCredits) {
        return NextResponse.json(
          { error: `Недостаточно кредитов для генерации недостающих ассетов: нужно ${gathered.insufficientCredits.need}, доступно ${gathered.insufficientCredits.have}`, assets: gathered.reconciliation },
          { status: 402 },
        );
      }
      await prisma.episode.update({ where: { id: episodeId }, data: { boardGate: "assets" } });
      return NextResponse.json({ gated: true, assets: gathered.reconciliation, charged: gathered.charged, creditsRemaining: gathered.creditsRemaining });
    }
    // Assets all present → clear any stale gate and split immediately (unchanged behaviour).
    await prisma.episode.updateMany({ where: { id: episodeId, boardGate: { not: null } }, data: { boardGate: null } });

    // Stage 154 — retire any prior FAILED board-planning jobs for this episode before starting a new
    // one, so an obsolete failure (e.g. the pre-Stage-148 "outside the required 12–15" message) can
    // never resurface in the UI once a fresh plan is under way.
    await prisma.generationJob.updateMany({
      where: { projectId: pid, type: STORYBOARD_BOARDS_JOB_TYPE, status: "failed", resultData: { contains: `"episodeId":"${episodeId}"` } },
      data: { status: "superseded", message: "Superseded by a new board plan", error: null },
    });

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
    select: { id: true, mode: true, videoUrl: true, boardGate: true, season: { select: { projectId: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const projectId = episode.season.projectId;

  // Stage 174 — asset-gathering status for the "Ассеты" panel (STORYBOARD only; cheap DB reads, no LLM).
  const assets = episode.mode === "STORYBOARD" ? await reconcileEpisodeAssets(episodeId) : null;

  const boards = await prisma.board.findMany({ where: { episodeId }, orderBy: { index: "asc" } });
  await failStaleJobs({ projectId, type: STORYBOARD_BOARDS_JOB_TYPE });
  // Stage 154 — do NOT blindly surface the newest job: a stale FAILED plan (e.g. the obsolete
  // "outside the required 12–15" message) must not block/mislead the UI once boards exist or a newer
  // non-failed job is present. selectAuthoritativeBoardJob keeps genuine current failures visible.
  const jobs = await prisma.generationJob.findMany({
    where: { projectId, type: STORYBOARD_BOARDS_JOB_TYPE, resultData: { contains: `"episodeId":"${episodeId}"` } },
    orderBy: { createdAt: "desc" },
  });
  const job = selectAuthoritativeBoardJob(jobs, boards.length > 0);

  // Resume-on-reload — attach the id of any ACTIVE (pending/processing) board-level job to each board, so the
  // client can re-attach its frame / clip progress bar after a page reload (poll state is memory-only otherwise).
  const activeBoardJobs = await prisma.generationJob.findMany({
    where: { projectId, type: { in: [BOARD_IMAGE_JOB_TYPE, BOARD_VIDEO_JOB_TYPE] }, status: { in: ["pending", "processing"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, resultData: true },
  });
  const jobBoardId = (resultData: string | null): string | null => {
    if (!resultData) return null;
    try {
      const parsed = JSON.parse(resultData);
      return typeof parsed?.boardId === "string" ? parsed.boardId : null;
    } catch {
      const m = resultData.match(/"boardId":"([^"]+)"/);
      return m ? m[1] : null;
    }
  };
  // activeBoardJobs is newest-first, so the FIRST match per board is the newest active job of that kind.
  const enrichedBoards = boards.map((b) => {
    const frameJobId = activeBoardJobs.find((j) => j.type === BOARD_IMAGE_JOB_TYPE && jobBoardId(j.resultData) === b.id)?.id ?? null;
    const animateJobId = activeBoardJobs.find((j) => j.type === BOARD_VIDEO_JOB_TYPE && jobBoardId(j.resultData) === b.id)?.id ?? null;
    return { ...b, frameJobId, animateJobId };
  });

  return NextResponse.json(
    { mode: episode.mode, videoUrl: episode.videoUrl, boards: enrichedBoards, job, assets, boardGate: episode.boardGate ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
