export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel Pro / Fluid compute max — background job runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, generateVideoSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { sceneClipSeconds } from "@/lib/season";
import { resolvePowerTier } from "@/lib/power-tier";

/** Tier (power) determines credit cost AND video quality — single config in lib/power-tier.ts. */
function videoTierFor(project: { powerTier?: string | null; tier?: string | null }) {
  const cfg = resolvePowerTier(project);
  return { cost: cfg.costPerScene, duration: cfg.baseDuration, resolution: cfg.resolution, power: cfg.id };
}

/** Minimum total episode length (sum of its scenes), seconds. */
const EPISODE_MIN_SECONDS = Number(process.env.EPISODE_MIN_SECONDS ?? 60);
/** Seedance 2.5 accepts up to 30 s per clip; keep a safe upper bound. */
const SCENE_MAX_SECONDS = Number(process.env.SCENE_MAX_SECONDS ?? 30);
/** Each scene clip runs at least this long (Seedance 2.5 supports it natively). */
const SCENE_MIN_SECONDS = Number(process.env.SCENE_MIN_SECONDS ?? 15);

/**
 * POST /api/ai/generate-video  { projectId, sceneId }
 *
 * 1. Validates credits, deducts them
 * 2. Creates a GenerationJob (type "video") and starts the job in the background (after())
 * 3. Returns { jobId } immediately — the frontend polls GET /api/jobs/[jobId]
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:generate-video", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const parsed = await parseBody(request, generateVideoSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, sceneId } = parsed.data;
    // Stage 4: speech is always English (client-side language selector removed); subtitles carry the story language.
    const spokenLang = "en";
    // Video provider: default Seedance (native audio, up to 15s). Kling is a
    // silent image-to-video alternative capped at 10s by its real schema.
    const provider = parsed.data.provider === "kling" ? "kling" : "seedance";

    const project = await prisma.project.findFirst({ where: { id: projectId } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const tier = videoTierFor(project);

    const sceneData = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!sceneData) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
    if (!sceneData.videoPrompt)
      return NextResponse.json({ error: "Scene has no video prompt" }, { status: 400 });

    // Episode must run at least EPISODE_MIN_SECONDS in total → each scene gets its share,
    // never shorter than the tier's base duration. Credits scale with the extra seconds.
    const sceneCount = Math.max(1, await prisma.scene.count({ where: { episodeId: sceneData.episodeId } }));
    // New-flow scenes carry a scripted durationSec (dialogue-driven, up to the model max) — same
    // rule as generate-all so a single-scene regen costs exactly what the batch would.
    const duration = sceneData.durationSec
      ? sceneClipSeconds(tier.power, sceneData.durationSec)
      : Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, tier.duration, Math.ceil(EPISODE_MIN_SECONDS / sceneCount)));
    // Kling's real schema supports ONLY 5 or 10 s (no 15s). Cap honestly so the
    // clip length AND the credit cost reflect what Kling actually produces.
    const effectiveDuration = provider === "kling" ? Math.min(10, duration) : duration;
    const config = {
      resolution: tier.resolution,
      duration: effectiveDuration,
      cost: Math.max(tier.cost, Math.ceil((tier.cost * effectiveDuration) / tier.duration)),
    };

    // Dead jobs (killed function) must not block new generations
    await failStaleJobs({ sceneId, type: "video" });

    // Already running for this scene? Return the existing job instead of charging again.
    const active = await prisma.generationJob.findFirst({
      where: { sceneId, type: "video", status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    if ((user.credits ?? 0) < config.cost) {
      return NextResponse.json(
        { error: `Not enough credits. Need ${config.cost}, have ${user.credits ?? 0}` },
        { status: 400 }
      );
    }

    // Deduct credits (refunded by the worker if generation fails)
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: config.cost } } });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -config.cost,
        description: `Video generation for scene ${sceneData.number} (${tier.power} power)`,
      },
    });

    // Persist the chosen spoken language separately so an unmigrated DB (missing
    // "language" column) can never block video generation.
    try {
      await prisma.scene.update({ where: { id: sceneId }, data: { language: spokenLang } });
    } catch (e) {
      console.warn("Could not persist scene.language (column missing?):", (e as any)?.message);
    }
    await prisma.scene.update({ where: { id: sceneId }, data: { status: "generating" } });

    const job = await prisma.generationJob.create({
      data: {
        type: "video",
        status: "processing",
        progress: 2,
        message: "Queued — starting video model...",
        projectId,
        sceneId,
      },
    });

    // Runs after the response is flushed; Vercel keeps this invocation alive up to maxDuration
    runInBackground(() =>
      runVideoJob({
        jobId: job.id,
        sceneId,
        projectId,
        userId: user.id,
        cost: config.cost,
        duration: config.duration,
        resolution: config.resolution,
        provider,
      })
    );

    return NextResponse.json({ jobId: job.id, creditsRemaining: (user.credits ?? 0) - config.cost });
  } catch (err: any) {
    console.error("Video generation error:", err);
    return NextResponse.json(
      { error: "Video generation failed: " + (err?.message ?? "Unknown error") },
      { status: 500 }
    );
  }
}
