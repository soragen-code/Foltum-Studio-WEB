export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800; // download + per-scene audio mux + concatenation can take a while

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, assembleEpisodeSchema } from "@/lib/validations";
import { assembleEpisodeVideo } from "@/lib/assemble";
import { completeJob, failJob, heartbeatJob, runInBackground, updateJob } from "@/lib/jobs";
import { DEFAULT_ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY } from "@/lib/assemble-options";
import { canUse } from "@/lib/entitlements";

/** GenerationJob.type of the plain "Assemble" stitch (Stage 46B: background job with real progress). */
const STITCH_JOB_TYPE = "episode_stitch";
const HEARTBEAT_MS = 45_000;

/**
 * Assemble a full episode from all accepted scene videos (in scene order).
 *
 * Stage 46B: the request returns a `jobId` immediately; the stitch runs in the background and
 * reports real stages ("Downloading clips k/N" → "Selecting music" → "Assembly" → "Uploading")
 * through GET /api/jobs/[id]. Body may carry the production `quality` (480p/720p/1080p) and
 * `fps` (30/60) of the final file — defaults 480p/30. Scenes themselves are always 480p.
 *
 * New scenes carry Seedance native speech and ambience. Older scenes may retain
 * a separate audio asset in `scene.audioUrl`; assembly preserves that compatibility:
 *   1. muxes each scene's voiceover into its clip (clips without a voiceover keep their
 *      own audio if they have one, otherwise get a silent track),
 *   2. joins the clips with local ffmpeg, renders the final quality/fps with thematic
 *      background music (music failure → assembled without music),
 *   3. uploads the file to S3 and stores the URL + quality/fps on the episode.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:assemble-episode", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, assembleEpisodeSchema);
    if (!parsed.ok) return parsed.response;
    const { episodeId } = parsed.data;
    const requestedQuality = parsed.data.quality ?? DEFAULT_ASSEMBLE_QUALITY;
    const fps = parsed.data.fps ?? DEFAULT_ASSEMBLE_FPS;
    if (!episodeId)
      return NextResponse.json({ error: "Episode ID required" }, { status: 400 });

    // Premium quality (720p / 1080p) is a Pro+ feature. Quality is only a request PARAMETER of the
    // final render (scenes are always 480p), so instead of failing the assemble we SILENTLY DOWNGRADE
    // to the base quality when the user has no premium_quality access. This keeps the flow unbroken:
    // anyone can still assemble in base 480p; the premium option is enforced server-side.
    const gateUser = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { subscriptionTier: true, subscriptionExpiresAt: true },
    });
    const quality =
      requestedQuality !== DEFAULT_ASSEMBLE_QUALITY && !canUse(gateUser, "premium_quality")
        ? DEFAULT_ASSEMBLE_QUALITY
        : requestedQuality;

    // Scope to the owner before stitching.
    const owned = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { user: { email: session.user.email } } } },
      select: { id: true, season: { select: { projectId: true } } },
    });
    if (!owned) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    const projectId = owned.season.projectId;

    // One active stitch per episode — return the running job instead of starting a second one.
    const active = await prisma.generationJob.findMany({
      where: { projectId, type: STITCH_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, resultData: true },
    });
    for (const j of active) {
      try { if (JSON.parse(j.resultData ?? "{}")?.episodeId === episodeId) return NextResponse.json({ jobId: j.id }); } catch {}
    }

    const job = await prisma.generationJob.create({
      data: {
        type: STITCH_JOB_TYPE,
        status: "processing",
        progress: 0,
        message: "Preparing",
        projectId,
        resultData: JSON.stringify({ episodeId, quality, fps }),
      },
    });
    const jobId = job.id;

    runInBackground(async () => {
      const hb = setInterval(() => void heartbeatJob(jobId), HEARTBEAT_MS);
      try {
        const result = await assembleEpisodeVideo(episodeId, {
          quality,
          fps,
          onProgress: (progress, message) => updateJob(jobId, { progress, message }),
        });
        await completeJob(
          jobId,
          { episodeId, quality, fps, videoUrl: result.videoUrl, sceneCount: result.sceneCount, mood: result.mood, musicApplied: result.musicApplied, musicPlan: result.musicPlan, musicSummary: result.musicSummary, musicError: result.musicError, note: result.note },
          result.note ?? "Episode assembled"
        );
      } catch (err: any) {
        console.error("Episode assembly error:", err);
        await failJob(jobId, err?.message ?? "Episode assembly failed");
      } finally {
        clearInterval(hb);
      }
    });

    return NextResponse.json({ jobId });
  } catch (err: any) {
    console.error("Episode assembly error:", err);
    return NextResponse.json({ error: err?.message ?? "Assembly failed" }, { status: 500 });
  }
}
