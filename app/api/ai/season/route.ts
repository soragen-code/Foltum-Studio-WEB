export const dynamic = "force-dynamic";
export const maxDuration = 800; // the season job runs in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSeasonScriptJob, advanceSeasonJob, SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";
import { SEASON_MIN_EPISODES, SEASON_MAX_EPISODES, SEASON_DEFAULT_EPISODES } from "@/lib/season";

/**
 * POST /api/ai/season { projectId, episodeCount? }
 * Starts (or resumes) the season-script job. Idempotent: an active job is returned as-is;
 * finished episodes are never regenerated — only missing scripts are filled in.
 * Returns { jobId, resumed }.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await rateLimitByUser(request, "ai-season", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const projectId = String(body?.projectId ?? "");
  const episodeCount = Math.min(SEASON_MAX_EPISODES, Math.max(SEASON_MIN_EPISODES, Number(body?.episodeCount) || SEASON_DEFAULT_EPISODES));
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true, synopsis: true, charactersApproved: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!project.synopsis) return NextResponse.json({ error: "Сначала утвердите синопсис" }, { status: 400 });

  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) return NextResponse.json({ jobId: active.id, resumed: true });

  const job = await prisma.generationJob.create({ data: { type: SEASON_JOB_TYPE, status: "pending", progress: 0, message: "Запуск…", projectId } });
  runInBackground(() => runSeasonScriptJob(job.id, projectId, episodeCount));
  return NextResponse.json({ jobId: job.id, resumed: false });
}

/**
 * GET /api/ai/season?projectId=… → season with episodes (scripts + scene counts) and the latest job.
 * Polling drives the season job: an active job is advanced here (poll the OpenAI background response,
 * persist a finished step, start the next one) — no long-running work lives in any single request.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  const latest = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE }, orderBy: { createdAt: "desc" } });
  if (latest && ["pending", "processing"].includes(latest.status)) await advanceSeasonJob(latest);
  const [season, job] = await Promise.all([
    prisma.season.findFirst({
      where: { projectId, number: 1 },
      include: { episodes: { orderBy: { number: "asc" }, include: { characters: { include: { character: { select: { id: true, name: true, imageFront: true } } } }, scenes: { orderBy: { number: "asc" }, select: { id: true, number: true, status: true, videoUrl: true, shotType: true, durationSec: true } } } } },
    }),
    prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE }, orderBy: { createdAt: "desc" } }),
  ]);
  return NextResponse.json({ season, job });
}
