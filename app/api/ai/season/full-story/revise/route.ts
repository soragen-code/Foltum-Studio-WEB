export const dynamic = "force-dynamic";
export const maxDuration = 800; // the story rewrite + first season-job advance run in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";
import { runStoryReviseJob, STORY_REVISE_JOB_TYPE } from "@/lib/workers/story-revise-job";

/**
 * POST /api/ai/season/full-story/revise { projectId, instruction, force? }
 *
 * Stage 12/69 — the «Сюжет» screen edit-by-prompt («Что изменить в сюжете»). This used to run the whole
 * prose rewrite synchronously (client held an open fetch, no progress bar). It now creates a background
 * GenerationJob (type "story_revise") and returns { jobId } immediately; the prose rewrite + episode
 * structure sync + affected-episode script rewrite all run via runStoryReviseJob() in the background,
 * and the frontend polls GET /api/jobs/[id] for a smooth 0→100 % bar.
 *
 * The force/needsForce confirmation (an affected episode already has generated video) is surfaced via
 * the job result ({ needsForce, withVideo, episodes }) instead of an HTTP 409.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await rateLimitByUser(request, "ai-season-story-revise", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const projectId = String(body?.projectId ?? "");
  const instruction = String(body?.instruction ?? "").trim();
  const force = body?.force === true;
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  if (instruction.length < 3) return NextResponse.json({ error: "Опишите, что изменить в сюжете" }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true, synopsis: true } });
  if (!project?.synopsis) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Reap dead jobs of both kinds first.
  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  await failStaleJobs({ projectId, type: STORY_REVISE_JOB_TYPE });

  // Don't start a revise while the season story is still being written.
  const activeSeason = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } } });
  if (activeSeason) return NextResponse.json({ error: "Сюжет сезона ещё пишется — дождитесь окончания, затем внесите правки." }, { status: 409 });

  // Idempotent: a refresh (without force) reuses the active revise job instead of starting a second.
  if (!force) {
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: STORY_REVISE_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });
  }

  const job = await prisma.generationJob.create({
    data: { type: STORY_REVISE_JOB_TYPE, status: "pending", progress: 0, message: "Запуск…", projectId },
  });
  runInBackground(() => runStoryReviseJob(job.id, projectId, { instruction, force }));
  return NextResponse.json({ jobId: job.id, resumed: false });
}

/**
 * GET /api/ai/season/full-story/revise?projectId=… → the latest story-revise job (with its parsed
 * result), so the client can resume the progress bar after a reload.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: STORY_REVISE_JOB_TYPE });
  const latest = await prisma.generationJob.findFirst({
    where: { projectId, type: STORY_REVISE_JOB_TYPE },
    orderBy: { createdAt: "desc" },
  });
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return NextResponse.json(
    { job: latest ? { ...latest, result } : null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
