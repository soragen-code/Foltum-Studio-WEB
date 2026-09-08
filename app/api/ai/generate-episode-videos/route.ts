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
 * Generate video for EVERY scene of the episode at once — the scenes run in PARALLEL
 * (each gets its own background job). Scenes that already have a running/pending job are
 * skipped (their existing job id is returned). Credits are deducted per scene actually
 * started; if the balance can't cover all pending scenes we start as many as we can and
 * report how many were skipped for lack of credits.
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
    const spokenLang = body?.language === "ru" ? "ru" : "en";
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

    const jobs: Array<{ sceneId: string; sceneNumber: number; jobId: string; resumed?: boolean }> = [];
    let skipped = 0;
    let creditsLeft = user.credits ?? 0;

    for (const scene of scenes) {
      if (!scene.videoPrompt) {
        skipped++;
        continue;
      }

      // Clear any dead job, then reuse a still-active one instead of double-charging.
      await failStaleJobs({ sceneId: scene.id, type: "video" });
      const active = await prisma.generationJob.findFirst({
        where: { sceneId: scene.id, type: "video", status: { in: ["pending", "processing"] } },
        orderBy: { createdAt: "desc" },
      });
      if (active) {
        jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: active.id, resumed: true });
        continue;
      }

      if (creditsLeft < perSceneCost) {
        skipped++;
        continue;
      }
      creditsLeft -= perSceneCost;

      await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: perSceneCost } } });
      await prisma.creditTransaction.create({
        data: {
          userId: user.id,
          amount: -perSceneCost,
          description: `Batch video generation — scene ${scene.number} (${tier.power} power)`,
        },
      });

      try {
        await prisma.scene.update({ where: { id: scene.id }, data: { language: spokenLang } });
      } catch (e) {
        console.warn("Could not persist scene.language:", (e as any)?.message);
      }
      await prisma.scene.update({ where: { id: scene.id }, data: { status: "generating" } });

      const job = await prisma.generationJob.create({
        data: {
          type: "video",
          status: "processing",
          progress: 2,
          message: "Queued — starting video model...",
          projectId,
          sceneId: scene.id,
        },
      });

      // Fire the job in the background — all scenes generate in parallel.
      runInBackground(() =>
        runVideoJob({
          jobId: job.id,
          sceneId: scene.id,
          projectId,
          userId: user.id,
          cost: perSceneCost,
          duration,
          resolution: tier.resolution,
        })
      );

      jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: job.id });
    }

    return NextResponse.json({ jobs, skipped, creditsRemaining: creditsLeft });
  } catch (err: any) {
    console.error("Batch video generation error:", err);
    return NextResponse.json(
      { error: "Batch video generation failed: " + (err?.message ?? "Unknown error") },
      { status: 500 }
    );
  }
}
