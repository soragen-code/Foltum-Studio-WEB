export const dynamic = "force-dynamic";
export const maxDuration = 800; // scene jobs run in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs, heartbeatJob, updateJob } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { resolvePowerTier } from "@/lib/power-tier";
import { sceneClipPlan } from "@/lib/season";

/** How many scene submissions run at once; the rest wait in the queue (Replicate rate limit). */
export const GENERATE_ALL_CONCURRENCY = 3;
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
  const plan = sceneClipPlan(tier.id, episode.scenes.length);
  const pending = episode.scenes.filter((s) => !s.videoUrl && s.status !== "generating").length;
  return NextResponse.json({ sceneCount: episode.scenes.length, pendingCount: pending, ...plan, total: plan.costPerScene * pending, credits: user?.credits ?? 0, tier: tier.id, resolution: tier.resolution });
}

/**
 * POST /api/ai/episodes/[id]/generate-all { language?, force? }
 * Starts video generation for EVERY scene of the episode that has no video yet (or all when force=true),
 * with a queue (GENERATE_ALL_CONCURRENCY at a time). Idempotent: scenes with an active job are reused
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
  const spokenLang = body?.language === "ru" ? "ru" : "en";
  const force = Boolean(body?.force);

  const episode = await loadEpisode(id, session.user.id);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (episode.scenes.length === 0) return NextResponse.json({ error: "В эпизоде нет сцен" }, { status: 400 });
  const project = episode.season.project;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
  const tier = resolvePowerTier(project);
  const plan = sceneClipPlan(tier.id, episode.scenes.length);

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
  const need = toStart.length * plan.costPerScene;
  if (toStart.length && (user.credits ?? 0) < need) {
    return NextResponse.json({ error: `Недостаточно кредитов: нужно ${need} (${toStart.length} сцен × ${plan.costPerScene}), на балансе ${user.credits ?? 0}` }, { status: 402 });
  }

  // Charge + create queued jobs up front (so the UI shows every scene as queued immediately).
  const queued: Array<{ jobId: string; sceneId: string }> = [];
  for (const scene of toStart) {
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: plan.costPerScene } } });
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -plan.costPerScene, description: `Эпизод ${episode.number}, сцена ${scene.number} — генерация видео (${tier.id})` } });
    await prisma.scene.update({ where: { id: scene.id }, data: { status: "generating", language: spokenLang } });
    const job = await prisma.generationJob.create({ data: { type: "video", status: "pending", progress: 1, message: "В очереди…", projectId: project.id, sceneId: scene.id } });
    queued.push({ jobId: job.id, sceneId: scene.id });
    jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: job.id });
  }

  if (queued.length) {
    runInBackground(async () => {
      const waiting = new Set(queued.map((q) => q.jobId));
      const hb = setInterval(() => { for (const j of waiting) void heartbeatJob(j); }, QUEUE_HEARTBEAT_MS);
      let idx = 0;
      const worker = async () => {
        while (idx < queued.length) {
          const item = queued[idx++];
          waiting.delete(item.jobId);
          await updateJob(item.jobId, { status: "processing", progress: 2, message: "Старт видеомодели…" });
          try {
            await runVideoJob({ jobId: item.jobId, sceneId: item.sceneId, projectId: project.id, userId: user.id, cost: plan.costPerScene, duration: plan.duration, resolution: tier.resolution });
          } catch (err) {
            console.error("[generate-all] scene job failed:", err);
          }
          await new Promise((r) => setTimeout(r, 1500)); // pace Replicate submissions
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(GENERATE_ALL_CONCURRENCY, queued.length) }, worker));
      } finally {
        clearInterval(hb);
      }
    });
  }

  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
  return NextResponse.json({ jobs, started: queued.length, plan, creditsRemaining: fresh?.credits ?? 0 });
}
