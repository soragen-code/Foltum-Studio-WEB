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
import { fanOutAll, splitByCredits } from "@/lib/generate-all-fanout";
import { nextChainScene, chainOrder } from "@/lib/chain-run";

/**
 * Stage 39: scenes are generated IN PARALLEL — every queued scene job is started at once (fan-out).
 * Since Stage 38 no scene depends on the previous scene's output, so there is no ordering to keep.
 * `GENERATE_ALL_CONCURRENCY` (= Infinity, no cap) is re-exported from lib for the unit tests.
 */
export { GENERATE_ALL_CONCURRENCY } from "@/lib/generate-all-fanout";
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
  return NextResponse.json({ sceneCount: episode.scenes.length, pendingCount: pendingScenes.length, ...rest, total: pendingScenes.length ? plan.total : 0, credits: user?.credits ?? 0, tier: tier.id, resolution: tier.resolution,
    // Stage 40: generation order of this episode and the (in-order) scenes a chain run would go through.
    chainMode: episode.chainMode, chainRunActive: episode.chainRunActive, chainRunNote: episode.chainRunNote,
    chainSceneNumbers: chainOrder(episode.scenes).map((s) => s.number) });
}

/**
 * POST /api/ai/episodes/[id]/generate-all { language?, force? }
 * Starts video generation for EVERY scene of the episode that has no video yet (or all when force=true),
 * ALL AT THE SAME TIME (Stage 39 fan-out — scenes are independent). Idempotent: scenes with an active
 * job are reused (not charged again). Credits are charged per scene up front; when the balance cannot
 * cover every scene, as many scenes as can be paid are started and the rest are reported in
 * `insufficient` (" Insufficient credits"). If NOTHING can be paid → 402.
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
  // Stage 33: Seedance 2.5 only — a legacy `provider`/`videoModel` in the body is accepted and ignored.
  const provider = normalizeVideoModel(body?.provider ?? body?.videoModel);

  const episode = await loadEpisode(id, session.user.id);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (episode.scenes.length === 0) return NextResponse.json({ error: "There are no scenes in the episode" }, { status: 400 });
  const project = episode.season.project;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
  const tier = resolvePowerTier(project);
  // Stage 40 — CHAIN MODE: strictly one scene at a time. Only the first pending scene is charged and
  // started here; the worker charges and starts each following scene when the previous one is
  // published (lib/workers/video-job.ts → continueChainRun). A failure stops the run with a note.
  if (episode.chainMode === "chain") {
    for (const scene of episode.scenes) await failStaleJobs({ sceneId: scene.id, type: "video" });
    const running = await prisma.generationJob.findFirst({ where: { sceneId: { in: episode.scenes.map((s) => s.id) }, type: "video", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
    if (running) {
      // A scene is already in flight: (re)arm the chain so the run continues from it, charge nothing.
      await prisma.episode.update({ where: { id: episode.id }, data: { chainRunActive: true, chainRunNote: null } });
      const scene = episode.scenes.find((s) => s.id === running.sceneId);
      return NextResponse.json({ chain: true, jobs: [{ sceneId: running.sceneId, sceneNumber: scene?.number ?? 0, jobId: running.id, resumed: true }], started: 0, insufficient: [], plan: null, creditsRemaining: user.credits ?? 0 });
    }
    const candidates = force ? episode.scenes.map((s) => ({ ...s, videoUrl: null })) : episode.scenes;
    const first = nextChainScene(candidates);
    if (!first) return NextResponse.json({ error: "All episode scenes have already been generated" }, { status: 400 });
    const duration = sceneClipSeconds(tier.id, first.durationSec);
    const cost = sceneClipCost(tier.id, duration);
    const charged = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
    if (charged.count !== 1) {
      return NextResponse.json({ error: `Insufficient credits: for scene ${first.number} need ${cost}, balance ${user.credits ?? 0}` }, { status: 402 });
    }
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Episode ${episode.number}, scene ${first.number} — video generation via chain (${tier.id})` } });
    if (force) {
      // Re-run of the whole episode: clear the videos of the later scenes so the chain walks through them again.
      await prisma.scene.updateMany({ where: { episodeId: episode.id, number: { gt: first.number }, status: { not: "generating" } }, data: { videoUrl: null, lastFrameUrl: null, endStateActual: null, status: "pending" } });
    }
    await prisma.scene.update({ where: { id: first.id }, data: { status: "generating", language: spokenLang, videoModel: provider, endStateActual: null } });
    await prisma.episode.update({ where: { id: episode.id }, data: { chainRunActive: true, chainRunNote: null } });
    const job = await prisma.generationJob.create({ data: { type: "video", status: "processing", progress: 2, message: "Chain: starting first scene...", projectId: project.id, sceneId: first.id } });
    runInBackground(() => runVideoJob({ jobId: job.id, sceneId: first.id, projectId: project.id, userId: user.id, cost, duration, resolution: tier.resolution, provider }));
    const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
    const queue = chainOrder(candidates).map((s) => s.number);
    return NextResponse.json({ chain: true, jobs: [{ sceneId: first.id, sceneNumber: first.number, jobId: job.id }], started: 1, queuedSceneNumbers: queue.slice(1), insufficient: [], plan: { duration, costPerScene: cost, total: cost }, creditsRemaining: fresh?.credits ?? 0 });
  }

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
  // Stage 39: partial start — pay for as many scenes (in order) as the balance covers; report the rest.
  const { payable, unpaid } = splitByCredits(toStart, (scene) => sceneClipCost(tier.id, sceneClipSeconds(tier.id, scene.durationSec)), user.credits ?? 0);
  if (toStart.length && payable.length === 0) {
    return NextResponse.json({ error: `Insufficient credits: need ${need} (${toStart.length} scenes, up to ${plan.duration}each), balance ${user.credits ?? 0}` }, { status: 402 });
  }
  const insufficient = unpaid.map((scene) => ({ sceneId: scene.id, sceneNumber: scene.number, error: "Not enough credits" }));

  // Charge + create queued jobs up front (so the UI shows every scene as queued immediately).
  const queued: Array<{ jobId: string; sceneId: string; cost: number; duration: number }> = [];
  for (const scene of payable) {
    const cost = sceneClipCost(tier.id, sceneClipSeconds(tier.id, scene.durationSec));
    // Atomic, race-safe charge: decrement only if the balance still covers it (a parallel request may have spent it).
    const charged = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
    if (charged.count !== 1) { insufficient.push({ sceneId: scene.id, sceneNumber: scene.number, error: "Not enough credits" }); continue; }
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Episode ${episode.number}, scene ${scene.number} — video generation (${tier.id})` } });
    await prisma.scene.update({ where: { id: scene.id }, data: { status: "generating", language: spokenLang, videoModel: provider } });
    const job = await prisma.generationJob.create({ data: { type: "video", status: "pending", progress: 1, message: "In queue…", projectId: project.id, sceneId: scene.id } });
    queued.push({ jobId: job.id, sceneId: scene.id, cost, duration: sceneClipSeconds(tier.id, scene.durationSec) });
    jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: job.id });
  }

  if (queued.length) {
    runInBackground(async () => {
      // Stage 39: FAN-OUT — every queued scene is started right away; each job runs independently
      // (its own progress, its own error / refund). The heartbeat keeps jobs alive while they are
      // still in flight inside this invocation.
      const alive = new Set(queued.map((q) => q.jobId));
      const hb = setInterval(() => { for (const j of alive) void heartbeatJob(j); }, QUEUE_HEARTBEAT_MS);
      try {
        await fanOutAll(
          queued,
          async (item) => {
            try {
              await updateJob(item.jobId, { status: "processing", progress: 2, message: "Starting video model…" });
              await runVideoJob({ jobId: item.jobId, sceneId: item.sceneId, projectId: project.id, userId: user.id, cost: item.cost, duration: item.duration, resolution: tier.resolution, provider });
            } finally {
              alive.delete(item.jobId);
            }
          },
          (item, err) => console.error(`[generate-all] scene job ${item.sceneId} failed:`, err),
        );
      } finally {
        clearInterval(hb);
      }
    });
  }

  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
  return NextResponse.json({ jobs, started: queued.length, insufficient, plan, creditsRemaining: fresh?.credits ?? 0 });
}
