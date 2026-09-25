export const dynamic = "force-dynamic";
export const maxDuration = 800; // hosts the season_script worker via after(): the Opus 5 script call is blocking and can exceed 5 min

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSeasonScriptJob, initialSeasonState, SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";

/**
 * POST /api/ai/episodes/[id]/revise { instruction, force? } → { jobId }
 * LLM rewrites the whole episode script by the author's instruction (same schema: 10–15 scenes,
 * timing, language, coherence with neighbouring episodes) and rebuilds the episode's Scene rows.
 * Runs as a season_script job (poll GET /api/ai/season or /api/jobs/[id]).
 * Safety: scenes that already have a generated video are NOT deleted — the request is refused with
 * 409 unless `force: true` is sent (the UI warns; forcing drops the existing clips of this episode).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:episode-revise", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const instruction = String(body?.instruction ?? "").trim();
  if (instruction.length < 3) return NextResponse.json({ error: "Describe what to change" }, { status: 400 });

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: { scenes: { select: { videoUrl: true } }, season: { select: { projectId: true, episodes: { select: { id: true } } } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  // Stage 5: the season job (generation or season-level revise) writes episodes whose `script` is null —
  // such an episode cannot be revised until the job has finished it.
  if (!episode.script) {
    const running = await prisma.generationJob.findFirst({ where: { projectId: episode.season.projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, select: { id: true } });
    if (running) return NextResponse.json({ error: "This episode is being written — wait until its script is ready.", writing: true }, { status: 409 });
  }
  const withVideo = episode.scenes.filter((s) => s.videoUrl).length;
  if (withVideo > 0 && !body?.force) {
    return NextResponse.json({ error: `For ${withVideo} scenes already have finished videos. Rewriting the script will reassemble the scenes and remove these videos from the episode.`, needsForce: true, withVideo }, { status: 409 });
  }
  const projectId = episode.season.projectId;
  // Stage 2 (background mode): the rewrite runs as a season_script job with a revise queue — the reasoning
  // model works in OpenAI background mode and the client's job polling advances it (same as generation).
  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, select: { id: true } });
  if (active) return NextResponse.json({ error: "The season script is being generated — wait until it finishes.", writing: true }, { status: 409 });
  const state = initialSeasonState(episode.season.episodes.length, { episodeIds: [episode.id], instruction, force: !!body?.force });
  const job = await prisma.generationJob.create({ data: { type: SEASON_JOB_TYPE, status: "pending", progress: 0, message: "Starting…", projectId, resultData: JSON.stringify(state) } });
  runInBackground(() => runSeasonScriptJob(job.id, projectId, episode.season.episodes.length));
  return NextResponse.json({ jobId: job.id });
}
