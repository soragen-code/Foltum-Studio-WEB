export const dynamic = "force-dynamic";
export const maxDuration = 800; // all scene jobs run in the background inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { resolvePowerTier } from "@/lib/power-tier";
import { sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { nextSequentialShot, nextSequentialChainScene } from "@/lib/chain-run";
import { normalizeVideoModel } from "@/lib/ai-models";
import { normalizeVideoModelId } from "@/lib/video-models";
import { persistShotPlanForApprovedEpisode } from "@/lib/workers/shot-plan-persist";

/** Tier (power) determines credit cost AND video quality — single config in lib/power-tier.ts. */
function videoTierFor(project: { powerTier?: string | null; tier?: string | null }) {
  const cfg = resolvePowerTier(project);
  return { cost: cfg.costPerScene, duration: cfg.baseDuration, resolution: cfg.resolution, power: cfg.id };
}

const EPISODE_MIN_SECONDS = Number(process.env.EPISODE_MIN_SECONDS ?? 60);
const SCENE_MAX_SECONDS = Number(process.env.SCENE_MAX_SECONDS ?? 15);

/**
 * POST /api/ai/generate-episode-videos  { projectId, episodeId, language? }
 *
 * Stage 100 — parallel mode removed: scenes are generated STRICTLY SEQUENTIALLY (chain). This
 * endpoint charges and starts ONLY the first pending scene and arms the chain run; the worker
 * charges and starts each following scene once the previous one is published. If a scene is already
 * in flight the chain is (re)armed and resumed from it.
 *
 * Returns { jobs: [{ sceneId, sceneNumber, jobId }], skipped, creditsRemaining }.
 * The frontend polls GET /api/jobs/[jobId] for each returned job.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:generate-episode-videos", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const projectId = String(body?.projectId ?? "");
    const episodeId = String(body?.episodeId ?? "");
    // Stage 4: speech is always English (client-side language selector removed); the story-language text is shown in the UI only.
    const spokenLang = "en";
    if (!projectId || !episodeId)
      return NextResponse.json({ error: "projectId and episodeId are required" }, { status: 400 });

    const project = await prisma.project.findFirst({ where: { id: projectId } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const tier = resolvePowerTier(project);
    const provider = normalizeVideoModel(null);
    // Video-model selection (family + version). Falls back to the default (Seedance 2.5) when the
    // client sends nothing, preserving legacy behavior. See lib/video-models.ts.
    const videoModelId = normalizeVideoModelId((body as any)?.videoModelId ?? null);

    const scenes = await prisma.scene.findMany({
      where: { episodeId },
      orderBy: { number: "asc" },
      select: { id: true, number: true, durationSec: true, videoUrl: true, videoPrompt: true, status: true },
    });
    if (scenes.length === 0)
      return NextResponse.json({ error: "Episode has no scenes" }, { status: 400 });

    // Two generation modes (persisted per episode). Default SCENE mode runs a strict one-SCENE-at-a-time
    // chain (1 scene = 1 clip). Optional «Шоты» mode runs a one-SHOT-at-a-time chain.
    const episodeMode = await prisma.episode.findUnique({ where: { id: episodeId }, select: { generationMode: true } }).catch(() => null);
    const generationMode = episodeMode?.generationMode === "shots" ? "shots" : "scene";

    if (generationMode === "scene") {
      // ── Default SCENE chain: charge + start the first pending scene, arm the chain run; the worker
      // (continueChainRun) charges and starts each following scene and finally assembles the episode. ──
      const creditsLeftScene = user.credits ?? 0;
      for (const scene of scenes) await failStaleJobs({ sceneId: scene.id, type: "video" });
      const runningScene = await prisma.generationJob.findFirst({
        where: { sceneId: { in: scenes.map((s) => s.id) }, type: "video", status: { in: ["pending", "processing"] } },
        orderBy: { createdAt: "desc" },
      });
      if (runningScene) {
        await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: true, chainRunNote: null } }).catch(() => {});
        const rid = runningScene.sceneId ?? "";
        return NextResponse.json({ jobs: [{ sceneId: rid, sceneNumber: scenes.find((s) => s.id === rid)?.number ?? 0, jobId: runningScene.id, resumed: true }], skipped: 0, creditsRemaining: creditsLeftScene });
      }
      const firstScene = nextSequentialChainScene(scenes);
      if (!firstScene) return NextResponse.json({ error: "All episode scenes have already been generated" }, { status: 400 });
      const sceneDuration = sceneClipSeconds(tier.id, Math.max(1, Math.round(Number(firstScene.durationSec ?? tier.baseDuration))));
      const sceneCost = sceneClipCost(tier.id, sceneDuration);
      if (creditsLeftScene < sceneCost)
        return NextResponse.json({ error: `Insufficient credits: for the next scene need ${sceneCost}, balance ${creditsLeftScene}` }, { status: 402 });
      const chargedScene = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: sceneCost } }, data: { credits: { decrement: sceneCost } } });
      if (chargedScene.count !== 1) return NextResponse.json({ error: `Insufficient credits: for the next scene need ${sceneCost}, balance ${creditsLeftScene}` }, { status: 402 });
      await prisma.creditTransaction.create({ data: {
        userId: user.id, amount: -sceneCost,
        description: `Chain video generation — scene ${firstScene.number} (${tier.id} power)`,
      } });
      try { await prisma.scene.update({ where: { id: firstScene.id }, data: { language: spokenLang } }); }
      catch (e) { console.warn("Could not persist scene.language:", (e as any)?.message); }
      await prisma.scene.update({ where: { id: firstScene.id }, data: { status: "generating", videoModel: videoModelId } }).catch(() => {});
      await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: true, chainRunNote: null } }).catch(() => {});
      const sceneJob = await prisma.generationJob.create({ data: {
        type: "video", status: "processing", progress: 2, message: "Chain: starting first scene...",
        projectId, sceneId: firstScene.id,
      } });
      // No shotId → the worker renders the whole scene as one clip (runSceneVideoJob).
      runInBackground(() => runVideoJob({
        jobId: sceneJob.id, sceneId: firstScene.id, projectId, userId: user.id,
        cost: sceneCost, duration: sceneDuration, resolution: tier.resolution, provider, videoModelId,
      }));
      const freshScene = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
      return NextResponse.json({ jobs: [{ sceneId: firstScene.id, sceneNumber: firstScene.number, jobId: sceneJob.id }], skipped: 0, creditsRemaining: freshScene?.credits ?? creditsLeftScene });
    }

    // ── «Шоты» mode — generation runs as a strict one-SHOT-at-a-time chain (the shot is the atomic unit).
    // Self-heal LEGACY episodes (Scene rows, zero Shot rows) by transparently BUILDING the shot plan
    // (a pure LLM planning call, not paid video generation) on the first click, then continue.
    const ep0 = await prisma.episode.findUnique({ where: { id: episodeId }, select: { status: true } });
    let episodeShots = await prisma.shot.findMany({ where: { scene: { episodeId } }, select: { id: true, index: true, sceneId: true, videoUrl: true, status: true, duration: true } });
    if (episodeShots.length === 0 && ep0?.status !== "shot_plan_failed") {
      const planResult = await persistShotPlanForApprovedEpisode(episodeId);
      if (planResult.ok) {
        episodeShots = await prisma.shot.findMany({ where: { scene: { episodeId } }, select: { id: true, index: true, sceneId: true, videoUrl: true, status: true, duration: true } });
      }
    }
    if (episodeShots.length === 0) {
      const fresh = await prisma.episode.findUnique({ where: { id: episodeId }, select: { status: true, chainRunNote: true } });
      return NextResponse.json({ error: "Shot plan is not ready or failed. Regenerate the shot plan for this episode before generating video.", status: fresh?.status ?? null, chainRunNote: fresh?.chainRunNote ?? null }, { status: 409 });
    }

    // Stage 167 — charge and start ONLY the first ungenerated shot, then arm the chain run so the worker
    // (lib/workers/video-job.ts → continueShotChain) charges and starts each following shot once the
    // previous one is published. It never fans out.
    const jobs: Array<{ sceneId: string; sceneNumber: number; jobId: string; resumed?: boolean }> = [];
    const creditsLeft = user.credits ?? 0;
    const sceneNumberById = new Map(scenes.map((s) => [s.id, s.number]));
    const orderKey = (s: (typeof episodeShots)[number]) => ({ id: s.id, sceneNumber: sceneNumberById.get(s.sceneId) ?? 0, index: s.index, videoUrl: s.videoUrl, status: s.status });

    // Clear dead jobs first; if a shot is already in flight, (re)arm the chain and resume from it.
    for (const scene of scenes) await failStaleJobs({ sceneId: scene.id, type: "video" });
    const running = await prisma.generationJob.findFirst({
      where: { sceneId: { in: scenes.map((s) => s.id) }, type: "video", status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (running) {
      await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: true, chainRunNote: null } }).catch(() => {});
      const runningSceneId = running.sceneId ?? "";
      jobs.push({ sceneId: runningSceneId, sceneNumber: sceneNumberById.get(runningSceneId) ?? 0, jobId: running.id, resumed: true });
      return NextResponse.json({ jobs, skipped: 0, creditsRemaining: creditsLeft });
    }

    const firstShot = nextSequentialShot(episodeShots.map(orderKey));
    if (!firstShot) return NextResponse.json({ error: "All episode shots have already been generated" }, { status: 400 });
    const shotRow = episodeShots.find((s) => s.id === firstShot.id)!;
    const duration = sceneClipSeconds(tier.id, Math.max(1, Math.round(Number(shotRow.duration ?? 3))));
    const perSceneCost = sceneClipCost(tier.id, duration);

    if (creditsLeft < perSceneCost)
      return NextResponse.json({ error: `Insufficient credits: for the next shot need ${perSceneCost}, balance ${creditsLeft}` }, { status: 402 });

    const charged = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: perSceneCost } }, data: { credits: { decrement: perSceneCost } } });
    if (charged.count !== 1) return NextResponse.json({ error: `Insufficient credits: for the next shot need ${perSceneCost}, balance ${creditsLeft}` }, { status: 402 });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -perSceneCost,
        description: `Chain video generation — scene ${firstShot.sceneNumber}, shot ${firstShot.index + 1} (${tier.id} power)`,
      },
    });

    try {
      await prisma.scene.update({ where: { id: shotRow.sceneId }, data: { language: spokenLang } });
    } catch (e) {
      console.warn("Could not persist scene.language:", (e as any)?.message);
    }
    await prisma.shot.update({ where: { id: firstShot.id }, data: { status: "generating", error: null } });
    await prisma.scene.update({ where: { id: shotRow.sceneId }, data: { videoModel: videoModelId } }).catch(() => {});
    await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: true, chainRunNote: null } }).catch(() => {});

    const job = await prisma.generationJob.create({
      data: {
        type: "video",
        status: "processing",
        progress: 2,
        message: "Chain: starting first shot...",
        projectId,
        sceneId: shotRow.sceneId,
      },
    });

    runInBackground(() =>
      runVideoJob({
        jobId: job.id,
        sceneId: shotRow.sceneId,
        shotId: firstShot.id,
        projectId,
        userId: user.id,
        cost: perSceneCost,
        duration,
        resolution: tier.resolution,
        provider,
        videoModelId,
      })
    );

    jobs.push({ sceneId: shotRow.sceneId, sceneNumber: firstShot.sceneNumber, jobId: job.id });
    const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
    return NextResponse.json({ jobs, skipped: 0, creditsRemaining: fresh?.credits ?? creditsLeft });
  } catch (err: any) {
    console.error("Batch video generation error:", err);
    return NextResponse.json(
      { error: "Batch video generation failed: " + (err?.message ?? "Unknown error") },
      { status: 500 }
    );
  }
}
