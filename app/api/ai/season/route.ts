export const dynamic = "force-dynamic";
export const maxDuration = 800; // the season job runs in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSeasonScriptJob, advanceSeasonJob, SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";
import { SEASON_MIN_EPISODES, SEASON_MAX_EPISODES, SEASON_DEFAULT_EPISODES, STORY_EPISODE_BATCH } from "@/lib/season";

/**
 * POST /api/ai/season { projectId, episodeCount?, action? }
 * Starts (or resumes) the season-script job. Idempotent: an active job is returned as-is;
 * finished episodes are never regenerated — only missing scripts are filled in.
 *
 * Stage 210 — the season STORY (per-episode synopses) is generated in batches of STORY_EPISODE_BATCH (=3):
 *   • action omitted / "start": generate the FIRST batch (episodes 1..3) of a `episodeCount`-episode season.
 *   • action "next-batch": generate the NEXT batch, continuing from the episodes already written.
 * Returns { jobId, resumed }.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await rateLimitByUser(request, "ai-season", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const projectId = String(body?.projectId ?? "");
  const action = String(body?.action ?? "start");
  const episodeCount = Math.min(SEASON_MAX_EPISODES, Math.max(SEASON_MIN_EPISODES, Number(body?.episodeCount) || SEASON_DEFAULT_EPISODES));
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, userId: session.user.id }, select: { id: true, synopsis: true, charactersApproved: true, storyEpisodesGenerated: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!project.synopsis) return NextResponse.json({ error: "First approve the synopsis" }, { status: 400 });

  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) return NextResponse.json({ jobId: active.id, resumed: true });

  // Resolve the batch bounds. The season's own episodeCount (once created) is the authoritative TOTAL;
  // before that (first batch) the producer-chosen episodeCount from the body applies.
  const season = await prisma.season.findFirst({ where: { projectId, number: 1 }, select: { episodeCount: true, _count: { select: { episodes: true } } } });
  const total = season?.episodeCount ?? episodeCount;
  const generated = project.storyEpisodesGenerated ?? season?._count.episodes ?? 0;
  const from = action === "next-batch" ? generated + 1 : 1;
  const to = Math.min(from + STORY_EPISODE_BATCH - 1, total);
  if (from > total) return NextResponse.json({ error: "All episodes already generated" }, { status: 400 });
  const storyBatch = { from, to, total };

  const job = await prisma.generationJob.create({ data: { type: SEASON_JOB_TYPE, status: "pending", progress: 0, message: "Starting…", projectId } });
  runInBackground(() => runSeasonScriptJob(job.id, projectId, total, storyBatch));
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
      include: { episodes: { orderBy: { number: "asc" }, include: { location: true, characters: { include: { character: { select: { id: true, name: true, imageFront: true } } } }, scenes: { orderBy: { number: "asc" }, select: { id: true, number: true, status: true, videoUrl: true, shotType: true, durationSec: true, locationDesc: true } } } } },
    }),
    prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE }, orderBy: { createdAt: "desc" } }),
  ]);
  return NextResponse.json({ season, job });
}
