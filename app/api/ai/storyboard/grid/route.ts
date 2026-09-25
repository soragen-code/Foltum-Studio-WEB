export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import {
  runStoryboardGridJob,
  STORYBOARD_GRID_JOB_TYPE,
} from "@/lib/workers/storyboard-grid-job";

/**
 * Stage 240 — GRID STORYBOARD.
 *
 * POST /api/ai/storyboard/grid  { episodeId, prompt? }  →  { jobId, resumed }
 *   Render the episode's single 5×5 storyboard sheet (25 panels) with GPT Image 2.0. Optional `prompt`
 *   overrides the template for THIS render (also persisted). Idempotent: an active grid job is returned.
 *
 * GET /api/ai/storyboard/grid?episodeId=...  →  { gridUrl, gridPrompt, gridApproved, panels, job }
 *   The current sheet + approval state + per-scene sliced panels + the latest grid job (for resume).
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:storyboard-grid", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const body = await request.json().catch(() => ({}));
    const episodeId = typeof body?.episodeId === "string" ? body.episodeId : "";
    const promptOverride = typeof body?.prompt === "string" && body.prompt.trim() ? String(body.prompt) : null;
    if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { userId: session.user.id } } },
      select: { id: true, season: { select: { projectId: true } } },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    const pid = episode.season.projectId;

    await failStaleJobs({ projectId: pid, type: STORYBOARD_GRID_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: STORYBOARD_GRID_JOB_TYPE, status: { in: ["pending", "processing"] }, resultData: { contains: `"episodeId":"${episodeId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    // If a prompt override arrived from the modal, persist it before rendering so a reload keeps the edit.
    if (promptOverride) {
      await prisma.episode.update({ where: { id: episodeId }, data: { gridPrompt: promptOverride } });
    }

    const job = await prisma.generationJob.create({
      data: { type: STORYBOARD_GRID_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId: pid, resultData: JSON.stringify({ episodeId }) },
    });
    await prisma.episode.update({ where: { id: episodeId }, data: { gridJobId: job.id } });
    runInBackground(() => runStoryboardGridJob(job.id, pid, episodeId, promptOverride));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Storyboard grid error:", err);
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
    select: {
      id: true,
      gridUrl: true,
      gridPrompt: true,
      gridApproved: true,
      season: { select: { projectId: true } },
      scenes: { orderBy: { number: "asc" }, select: { id: true, number: true, title: true, startFrameUrl: true, gridPanelIndex: true } },
    },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const projectId = episode.season.projectId;

  await failStaleJobs({ projectId, type: STORYBOARD_GRID_JOB_TYPE });
  const job = await prisma.generationJob.findFirst({
    where: { projectId, type: STORYBOARD_GRID_JOB_TYPE, resultData: { contains: `"episodeId":"${episodeId}"` } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    {
      gridUrl: episode.gridUrl,
      gridPrompt: episode.gridPrompt,
      gridApproved: episode.gridApproved,
      panels: episode.scenes,
      job,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
