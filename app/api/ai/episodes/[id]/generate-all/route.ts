export const dynamic = "force-dynamic";
export const maxDuration = 800; // scene jobs run in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs, heartbeatJob, updateJob } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { resolvePowerTier } from "@/lib/power-tier";
import { sceneClipPlan, sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { normalizeVideoModel } from "@/lib/ai-models";

/**
 * Scenes are generated STRICTLY ONE AT A TIME (no parallelism). Each scene starts only after the
 * previous scene has finished and committed its last frame, so the next scene can be chained from
 * the real photo of that last frame (image-to-video). Kept as a named export for the unit test.
 */
export const GENERATE_ALL_CONCURRENCY = 1;
const QUEUE_HEARTBEAT_MS = 45_000;

async function loadEpisode(episodeId: string, userId: string) {
  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId } } },
    include: { season: { include: { project: true } }, scenes: { orderBy: { number: "asc" } } },
  });
  return episode;
}

/**
 * GET /api/ai/episodes/[id]/generate-all → cost estimate for the confirmation modal:
 * { sceneCount, pendingCount, duration, costPerScene, total, credits }.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const episode = await loadEpisode(id, session.user.id);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { credits: true } });
  const tier = resolvePowerTier(episode.season.project);
  const pendingScenes = episode.scenes.filter((s) => !s.videoUrl && s.status !== "generating");
  const plan = sceneClipPlan(tier.id, pendingScenes.length ? pendingScenes : episode.scenes);
  const { clips: _clips, ...rest } = plan;
  return NextResponse.json({ sceneCount: episode.scenes.length, pendingCount: pendingScenes.length, ...rest, total: pendingScenes.length ? plan.total : 0, credits: user?.credits ?? 0, tier: tier.id, resolution: tier.resolution });
}

/**
 * POST /api/ai/episodes/[id]/generate-all { language?, force? }
 * Starts video generation for EVERY scene of the episode that has no video yet (or all when force=true),
 * strictly one scene at a time in ascending order (each scene chains from the previous scene's last
 * frame). Idempotent: scenes with an active job are reused
 * (not charged again). Credits are charged per scene actually started; insufficient balance is a clear
 * error BEFORE anything starts.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:generate-all", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  // Stage 4: speech is always English (client-side language selector removed); the story-language text is shown in the UI only.
  const spokenLang = "en";
  const force = Boolean(body?.force);
  // Producer-picked video model (see lib/ai-models.ts) → the worker `provider`. Default Seedance.
  const provider = normalizeVideoModel(body?.provider ?? body?.videoModel);

  const episode = await loadEpisode(id, session.user.id);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (episode.scenes.length === 0) return NextResponse.json({ error: "В эпизоде нет сцен" }, { status: 400 });
  const project = episode.season.project;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
  const tier = resolvePowerTier(project);
  // Idempotency: reuse active jobs.
  const jobs: Array<{ sceneId: string; sceneNumber: number; jobId: string; resumed?: boolean }> = [];
  const toStart: typeof episode.scenes = [];
  for (const scene of episode.scenes) {
    if (!scene.videoPrompt) continue;
    await failStaleJobs({ sceneId: scene.id, type: "video" });
    const active = await prisma.generationJob.findFirst({ where: { sceneId: scene.id, type: "video", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
    if (active) { jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: active.id, resumed: true }); continue; }
    if (scene.videoUrl && !force) continue;
    toStart.push(scene);
  }
  const { clips: _clips, ...plan } = sceneClipPlan(tier.id, toStart);
  const need = toStart.length ? plan.total : 0;
  if (toStart.length && (user.credits ?? 0) < need) {
    return NextResponse.json({ error: `Недостаточно кредитов: нужно ${need} (${toStart.length} сцен, до ${plan.duration}с каждая), на балансе ${user.credits ?? 0}` }, { status: 402 });
  }

  // Charge + create queued jobs up front (so the UI shows every scene as queued immediately).
  const queued: Array<{ jobId: string; sceneId: string; cost: number; duration: number }> = [];
  for (const scene of toStart) {
    const cost = sceneClipCost(tier.id, sceneClipSeconds(tier.id, scene.durationSec));
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Эпизод ${episode.number}, сцена ${scene.number} — генерация видео (${tier.id})` } });
    await prisma.scene.update({ where: { id: scene.id }, data: { status: "generating", language: spokenLang, videoModel: provider } });
    const job = await prisma.generationJob.create({ data: { type: "video", status: "pending", progress: 1, message: "В очереди…", projectId: project.id, sceneId: scene.id } });
    queued.push({ jobId: job.id, sceneId: scene.id, cost, duration: sceneClipSeconds(tier.id, scene.durationSec) });
    jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: job.id });
  }

  if (queued.length) {
    runInBackground(async () => {
      // STRICTLY SEQUENTIAL (concurrency = 1): `queued` is in ascending scene order, so scene N only
      // runs after scene N-1 has fully finished and committed its lastFrameUrl. runVideoJob reads the
      // previous scene's lastFrameUrl fresh from the DB at start, so this ordering is what lets it chain
      // the next scene from the REAL last frame of the previous scene (image-to-video via canChainFrame).
      const waiting = new Set(queued.map((q) => q.jobId));
      const hb = setInterval(() => { for (const j of waiting) void heartbeatJob(j); }, QUEUE_HEARTBEAT_MS);
      try {
        for (const item of queued) {
          waiting.delete(item.jobId);
          await updateJob(item.jobId, { status: "processing", progress: 2, message: "Старт видеомодели…" });
          try {
            await runVideoJob({ jobId: item.jobId, sceneId: item.sceneId, projectId: project.id, userId: user.id, cost: item.cost, duration: item.duration, resolution: tier.resolution, provider });
          } catch (err) {
            console.error("[generate-all] scene job failed:", err);
          }
          await new Promise((r) => setTimeout(r, 1500)); // pace Replicate submissions
        }
      } finally {
        clearInterval(hb);
      }
    });
  }

  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
  return NextResponse.json({ jobs, started: queued.length, plan, creditsRemaining: fresh?.credits ?? 0 });
}
