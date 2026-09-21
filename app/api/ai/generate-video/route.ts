export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel Pro / Fluid compute max — background job runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, generateVideoSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { resolvePowerTier, isPowerTier } from "@/lib/power-tier";
import { normalizeVideoModel } from "@/lib/ai-models";
import { persistShotPlanForApprovedEpisode } from "@/lib/workers/shot-plan-persist";

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
    // Stage 4: speech is always English (client-side language selector removed); the story-language text is shown in the UI only.
    const spokenLang = "en";
    const project = await prisma.project.findFirst({ where: { id: projectId } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // Stage 89 — quality & speed picked on the episode-page top panel overrides the project's stored
    // tier for this generation (and per-frame Edit/Regenerate, which hits this same route) and is
    // persisted back so the choice sticks. Invalid / omitted → keep the project's current tier.
    const requestedTier = isPowerTier(parsed.data.powerTier) ? parsed.data.powerTier : null;
    if (requestedTier && requestedTier !== project.powerTier) {
      try {
        await prisma.project.update({ where: { id: project.id }, data: { powerTier: requestedTier } });
        project.powerTier = requestedTier;
      } catch (e) {
        console.warn("Could not persist project.powerTier (column missing?):", (e as any)?.message);
        project.powerTier = requestedTier; // still honor it for this request
      }
    }
    const tier = videoTierFor(project);

    const powerTierId = resolvePowerTier(project).id;
    const sceneData = await prisma.scene.findUnique({ where: { id: sceneId }, select: { id: true, number: true, episodeId: true, videoModel: true, durationSec: true, videoUrl: true } });
    if (!sceneData) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
    // Stage 33: Seedance 2.5 is the only video model. A legacy `provider` in the request body (or a
    // legacy value stored on the scene) is accepted and normalized to it — never an error.
    const provider = normalizeVideoModel(parsed.data.provider ?? sceneData.videoModel);

    // Two generation modes (persisted per episode). Default SCENE mode renders the whole scene as ONE
    // clip (1 scene = 1 prompt = 1 generation). Optional «Шоты» mode renders per shot. The mode gates
    // which unit this endpoint charges for and enqueues.
    const episodeMode = await prisma.episode.findUnique({ where: { id: sceneData.episodeId }, select: { generationMode: true } }).catch(() => null);
    const generationMode = episodeMode?.generationMode === "shots" ? "shots" : "scene";

    if (generationMode === "scene") {
      // ── Default SCENE path: one job renders the whole scene (no shotId) ──
      await failStaleJobs({ sceneId, type: "video" });
      const activeScene = await prisma.generationJob.findFirst({
        where: { sceneId, type: "video", status: { in: ["pending", "processing"] } },
        orderBy: { createdAt: "desc" },
      });
      if (activeScene) return NextResponse.json({ jobId: activeScene.id, resumed: true });

      const isRegen = Boolean(sceneData.videoUrl);
      const duration = sceneClipSeconds(powerTierId, Math.max(1, Math.round(Number(sceneData.durationSec ?? tier.duration))));
      const cost = sceneClipCost(powerTierId, duration);
      if ((user.credits ?? 0) < cost) {
        return NextResponse.json({ error: `Not enough credits. Need ${cost}, have ${user.credits ?? 0}` }, { status: 400 });
      }
      const chargedScene = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
      if (chargedScene.count !== 1) return NextResponse.json({ error: `Not enough credits. Need ${cost}, have ${user.credits ?? 0}` }, { status: 400 });
      await prisma.creditTransaction.create({ data: {
        userId: user.id, amount: -cost,
        description: `Video generation for scene ${sceneData.number} (${powerTierId} power)`,
      } });
      try { await prisma.scene.update({ where: { id: sceneId }, data: { language: spokenLang } }); }
      catch (e) { console.warn("Could not persist scene.language (column missing?):", (e as any)?.message); }
      try { await prisma.scene.update({ where: { id: sceneId }, data: { videoModel: provider } }); }
      catch (e) { console.warn("Could not persist scene.videoModel (column missing?):", (e as any)?.message); }
      // Regenerate clears the stored clip + last frame so the scene is rebuilt from scratch.
      if (isRegen) await prisma.scene.update({ where: { id: sceneId }, data: { videoUrl: null, lastFrameUrl: null } }).catch(() => {});
      await prisma.scene.update({ where: { id: sceneId }, data: { status: "generating" } });

      const sceneJob = await prisma.generationJob.create({ data: {
        type: "video", status: "processing", progress: 2, message: "Queued — starting video model...",
        projectId, sceneId,
      } });
      // No shotId → the worker renders the whole scene as one clip (runSceneVideoJob).
      runInBackground(() => runVideoJob({
        jobId: sceneJob.id, sceneId, projectId, userId: user.id, cost, duration,
        resolution: tier.resolution, provider,
      }));
      return NextResponse.json({ jobId: sceneJob.id, creditsRemaining: (user.credits ?? 0) - cost });
    }

    // ── «Шоты» mode: video is generated per SHOT. A runtime job without a shotId belongs to
    // the removed legacy scene path and would be rejected by the worker ("Legacy scene video generation
    // has been removed"). Resolve the shots of THIS scene and start a real SHOT job. Self-heal for LEGACY
    // episodes (Scene rows, zero Shot rows): transparently BUILD the shot plan (a pure LLM planning call,
    // not paid video generation) on the first click, then continue.
    let sceneShots = await prisma.shot.findMany({
      where: { sceneId },
      select: { id: true, index: true, videoUrl: true, status: true, duration: true },
      orderBy: { index: "asc" },
    });
    if (sceneShots.length === 0) {
      const ep = await prisma.episode.findUnique({ where: { id: sceneData.episodeId }, select: { status: true } });
      const episodeShotCount = await prisma.shot.count({ where: { scene: { episodeId: sceneData.episodeId } } });
      if (episodeShotCount === 0 && ep?.status !== "shot_plan_failed") {
        const planResult = await persistShotPlanForApprovedEpisode(sceneData.episodeId);
        if (planResult.ok) {
          sceneShots = await prisma.shot.findMany({
            where: { sceneId },
            select: { id: true, index: true, videoUrl: true, status: true, duration: true },
            orderBy: { index: "asc" },
          });
        }
      }
    }
    if (sceneShots.length === 0) {
      const fresh = await prisma.episode.findUnique({ where: { id: sceneData.episodeId }, select: { status: true, chainRunNote: true } });
      return NextResponse.json({ error: "Shot plan is not ready or failed. Regenerate the shot plan for this episode before generating video.", status: fresh?.status ?? null, chainRunNote: fresh?.chainRunNote ?? null }, { status: 409 });
    }

    // Dead jobs (killed function) must not block new generations
    await failStaleJobs({ sceneId, type: "video" });

    // Already running for this scene? Return the existing job instead of charging again.
    const active = await prisma.generationJob.findFirst({
      where: { sceneId, type: "video", status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    // Shot = generation unit. Pick the first ungenerated shot of this scene; if every shot already has a
    // clip this is a Regenerate — take the first shot and clear it so it is rebuilt from scratch.
    let targetShot = sceneShots.find((s) => !s.videoUrl && s.status !== "generating");
    const isRegen = !targetShot;
    if (!targetShot) targetShot = sceneShots[0];

    const duration = sceneClipSeconds(powerTierId, Math.max(1, Math.round(Number(targetShot.duration ?? 3))));
    const cost = sceneClipCost(powerTierId, duration);

    if ((user.credits ?? 0) < cost) {
      return NextResponse.json({ error: `Not enough credits. Need ${cost}, have ${user.credits ?? 0}` }, { status: 400 });
    }
    // Deduct credits atomically (refunded by the worker if generation fails).
    const charged = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
    if (charged.count !== 1) return NextResponse.json({ error: `Not enough credits. Need ${cost}, have ${user.credits ?? 0}` }, { status: 400 });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -cost,
        description: `Video generation for scene ${sceneData.number}, shot ${targetShot.index + 1} (${powerTierId} power)`,
      },
    });

    // Persist the chosen spoken language separately so an unmigrated DB (missing
    // "language" column) can never block video generation.
    try {
      await prisma.scene.update({ where: { id: sceneId }, data: { language: spokenLang } });
    } catch (e) {
      console.warn("Could not persist scene.language (column missing?):", (e as any)?.message);
    }
    // Remember the video model chosen for this scene so a later background resume
    // (or single-scene regen) reuses the same one.
    try {
      await prisma.scene.update({ where: { id: sceneId }, data: { videoModel: provider } });
    } catch (e) {
      console.warn("Could not persist scene.videoModel (column missing?):", (e as any)?.message);
    }
    if (isRegen) await prisma.shot.update({ where: { id: targetShot.id }, data: { videoUrl: null, lastFrameUrl: null } }).catch(() => {});
    await prisma.shot.update({ where: { id: targetShot.id }, data: { status: "generating", error: null } });
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

    // Runs after the response is flushed; Vercel keeps this invocation alive up to maxDuration.
    // shotId is REQUIRED — the worker renders exactly this shot (never the removed legacy scene path).
    runInBackground(() =>
      runVideoJob({
        jobId: job.id,
        sceneId,
        shotId: targetShot!.id,
        projectId,
        userId: user.id,
        cost,
        duration,
        resolution: tier.resolution,
        provider,
      })
    );

    return NextResponse.json({ jobId: job.id, creditsRemaining: (user.credits ?? 0) - cost });
  } catch (err: any) {
    console.error("Video generation error:", err);
    return NextResponse.json(
      { error: "Video generation failed: " + (err?.message ?? "Unknown error") },
      { status: 500 }
    );
  }
}
