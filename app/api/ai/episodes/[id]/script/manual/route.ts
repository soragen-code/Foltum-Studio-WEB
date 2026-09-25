export const dynamic = "force-dynamic";
export const maxDuration = 800; // hosts the season_script worker via after(): the Opus 5 script call is blocking and can exceed 5 min

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSeasonScriptJob, initialSeasonState, SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";
import { manualScriptDirective } from "@/lib/reset-to-auto";

/** Minimum length for a pasted episode script (a few lines) and a defensive upper cap. */
const MANUAL_SCRIPT_MIN_CHARS = 40;
const MANUAL_SCRIPT_MAX_CHARS = 60000;

/**
 * Stage 158 — POST /api/ai/episodes/[id]/script/manual → { jobId }
 * "Insert your own full episode script": the author pastes a COMPLETE episode shooting script and it becomes
 * the AUTHORITATIVE source for THIS episode. Mirrors the auto POST /script route exactly (session auth,
 * rate limit, failStaleJobs, 409-if-active, initialSeasonState + season_script job with a one-episode queue,
 * runInBackground) but the queued directive carries the pasted text (manualScriptDirective). The season job
 * feeds it to episodeScriptUserPrompt so the model only STRUCTURES the author's script into the required JSON,
 * and persistEpisodeScript resets/rebuilds the episode's scenes/keyframes/videos from it (same as auto).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:episode-script-manual", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;

  const body = await request.json().catch(() => ({}));
  const script = typeof body?.script === "string" ? body.script.trim() : "";
  if (script.length < MANUAL_SCRIPT_MIN_CHARS) {
    return NextResponse.json({ error: "Paste your full episode script (at least a few lines)." }, { status: 400 });
  }
  if (script.length > MANUAL_SCRIPT_MAX_CHARS) {
    return NextResponse.json({ error: "This script is too long — please shorten it." }, { status: 400 });
  }

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: { season: { select: { projectId: true, episodes: { select: { id: true } } } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const projectId = episode.season.projectId;

  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, select: { id: true } });
  if (active) return NextResponse.json({ error: "A script job is already running", jobId: active.id }, { status: 409 });

  // Stage 158 — queue a one-episode manual-script directive carrying the author's pasted text (empty
  // instruction + force so it overwrites the existing script; persistEpisodeScript drops the old
  // scenes/keyframes/videos and rebuilds from the author's script under the current rules).
  const state = initialSeasonState(episode.season.episodes.length, manualScriptDirective(episode.id, script));
  const job = await prisma.generationJob.create({ data: { type: SEASON_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify(state) } });
  runInBackground(() => runSeasonScriptJob(job.id, projectId, episode.season.episodes.length));
  return NextResponse.json({ jobId: job.id });
}
