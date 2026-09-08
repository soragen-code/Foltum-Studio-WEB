export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runTrailerJob } from "@/lib/workers/trailer-job";
import { TRAILER_JOB_TYPE, TRAILER_SEASON_NUMBER } from "@/lib/trailer";

/**
 * Test mode. POST /api/ai/trailer { projectId } → writes (or rewrites) the one-minute mini-trailer
 * script as Season 0 / Episode 1 and returns { jobId }. The clips are then generated from the
 * regular episode page («Сгенерировать все сцены» shows the exact cost before spending credits).
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await rateLimitByUser(request, "ai-trailer", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const projectId = String(body?.projectId ?? "");
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true, synopsis: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!project.synopsis) return NextResponse.json({ error: "Сначала утвердите синопсис" }, { status: 400 });

  await failStaleJobs({ projectId, type: TRAILER_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: TRAILER_JOB_TYPE, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) return NextResponse.json({ jobId: active.id, resumed: true });
  const job = await prisma.generationJob.create({ data: { type: TRAILER_JOB_TYPE, status: "pending", progress: 0, message: "Запуск...", projectId } });
  runInBackground(() => runTrailerJob(job.id, projectId));
  return NextResponse.json({ jobId: job.id, resumed: false });
}

/** GET /api/ai/trailer?projectId=... → { episode: {id,title,sceneCount,videoUrl,scenes:[{durationSec,status}]} | null, job } */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const [season, job] = await Promise.all([
    prisma.season.findFirst({ where: { projectId, number: TRAILER_SEASON_NUMBER }, include: { episodes: { orderBy: { number: "asc" }, take: 1, include: { scenes: { orderBy: { number: "asc" }, select: { durationSec: true, status: true, videoUrl: true } } } } } }),
    prisma.generationJob.findFirst({ where: { projectId, type: TRAILER_JOB_TYPE }, orderBy: { createdAt: "desc" } }),
  ]);
  const ep = season?.episodes[0];
  return NextResponse.json({
    episode: ep ? { id: ep.id, title: ep.title, videoUrl: ep.videoUrl, status: ep.status, scenes: ep.scenes } : null,
    job: job ? { id: job.id, status: job.status, progress: job.progress, message: job.message, error: job.error, resultData: job.resultData } : null,
  });
}
