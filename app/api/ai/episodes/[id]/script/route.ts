export const dynamic = "force-dynamic";
export const maxDuration = 300; // only starts the background job (the script itself is written in OpenAI background mode)

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSeasonScriptJob, initialSeasonState, SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";

/**
 * Stage 107 — POST /api/ai/episodes/[id]/script → { jobId }
 * Writes (or fully regenerates) THIS episode's shooting script from the season structure / its 60-second footage.
 * Since Stage 107 the season job produces only the structure + season plot, so every episode script is
 * requested here from the episode page ("Generate script" / "Regenerate script"). Runs as a season_script job
 * with a one-episode queue and NO instruction (= the normal first-write prompt); persistEpisodeScript resets the
 * episode's scenes / keyframes / videos. No confirmation: the UI states the consequence next to the button.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:episode-script", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: { season: { select: { projectId: true, episodes: { select: { id: true } } } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const projectId = episode.season.projectId;

  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, select: { id: true } });
  if (active) return NextResponse.json({ error: "A script job is already running", jobId: active.id }, { status: 409 });

  const state = initialSeasonState(episode.season.episodes.length, { episodeIds: [episode.id], instruction: "", force: true });
  const job = await prisma.generationJob.create({ data: { type: SEASON_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify(state) } });
  runInBackground(() => runSeasonScriptJob(job.id, projectId, episode.season.episodes.length));
  return NextResponse.json({ jobId: job.id });
}
