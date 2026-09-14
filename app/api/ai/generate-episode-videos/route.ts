export const dynamic = "force-dynamic";
export const maxDuration = 800; // all scene jobs run in the background inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { resolvePowerTier } from "@/lib/power-tier";

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

    const tier = videoTierFor(project);

    const scenes = await prisma.scene.findMany({
      where: { episodeId },
      orderBy: { number: "asc" },
    });
    if (scenes.length === 0)
      return NextResponse.json({ error: "Episode has no scenes" }, { status: 400 });

    // Per-scene duration so the whole episode runs at least EPISODE_MIN_SECONDS.
    const sceneCount = Math.max(1, scenes.length);
    const duration = Math.min(
      SCENE_MAX_SECONDS,
      Math.max(tier.duration, Math.ceil(EPISODE_MIN_SECONDS / sceneCount))
    );
    const perSceneCost = Math.max(tier.cost, Math.ceil((tier.cost * duration) / tier.duration));

    // Stage 100 — parallel mode removed: scenes are generated STRICTLY SEQUENTIALLY (chain). This
    // endpoint charges and starts ONLY the first pending scene, then arms the chain run so the worker
    // (lib/workers/video-job.ts → continueChainRun) charges and starts each following scene once the
    // previous one is published. It never fans out.
    const jobs: Array<{ sceneId: string; sceneNumber: number; jobId: string; resumed?: boolean }> = [];
    const skipped = 0;
    const creditsLeft = user.credits ?? 0;

    // Clear dead jobs first; if a scene is already in flight, (re)arm the chain and resume from it.
    for (const scene of scenes) await failStaleJobs({ sceneId: scene.id, type: "video" });
    const running = await prisma.generationJob.findFirst({
      where: { sceneId: { in: scenes.map((s) => s.id) }, type: "video", status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (running) {
      await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: true, chainRunNote: null } }).catch(() => {});
      const scene = scenes.find((s) => s.id === running.sceneId);
      jobs.push({ sceneId: running.sceneId, sceneNumber: scene?.number ?? 0, jobId: running.id, resumed: true });
      return NextResponse.json({ jobs, skipped: 0, creditsRemaining: creditsLeft });
    }

    // The first pending scene: has a prompt, has no video yet, is not generating.
    const first = scenes.find((s) => (s.videoPrompt ?? "").trim() && !s.videoUrl && s.status !== "generating");
    if (!first) return NextResponse.json({ error: "All episode scenes have already been generated" }, { status: 400 });

    if (creditsLeft < perSceneCost)
      return NextResponse.json({ error: `Insufficient credits: for scene ${first.number} need ${perSceneCost}, balance ${creditsLeft}` }, { status: 402 });

    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: perSceneCost } } });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -perSceneCost,
        description: `Chain video generation — scene ${first.number} (${tier.power} power)`,
      },
    });

    try {
      await prisma.scene.update({ where: { id: first.id }, data: { language: spokenLang } });
    } catch (e) {
      console.warn("Could not persist scene.language:", (e as any)?.message);
    }
    await prisma.scene.update({ where: { id: first.id }, data: { status: "generating", endStateActual: null } });
    await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: true, chainRunNote: null } }).catch(() => {});

    const job = await prisma.generationJob.create({
      data: {
        type: "video",
        status: "processing",
        progress: 2,
        message: "Chain: starting first scene...",
        projectId,
        sceneId: first.id,
      },
    });

    runInBackground(() =>
      runVideoJob({
        jobId: job.id,
        sceneId: first.id,
        projectId,
        userId: user.id,
        cost: perSceneCost,
        duration,
        resolution: tier.resolution,
      })
    );

    jobs.push({ sceneId: first.id, sceneNumber: first.number, jobId: job.id });
    const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
    return NextResponse.json({ jobs, skipped, creditsRemaining: fresh?.credits ?? creditsLeft });
  } catch (err: any) {
    console.error("Batch video generation error:", err);
    return NextResponse.json(
      { error: "Batch video generation failed: " + (err?.message ?? "Unknown error") },
      { status: 500 }
    );
  }
}
