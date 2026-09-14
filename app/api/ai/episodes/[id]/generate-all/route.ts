export const dynamic = "force-dynamic";
export const maxDuration = 800; // scene jobs run in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { resolvePowerTier, isPowerTier } from "@/lib/power-tier";
import { sceneClipPlan, sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { normalizeVideoModel } from "@/lib/ai-models";
import { nextChainScene, chainOrder } from "@/lib/chain-run";

/**
 * Stage 100: scenes are generated STRICTLY SEQUENTIALLY (chain) — parallel mode was removed entirely.
 * Only the first pending scene is started here; the worker starts each following scene when the
 * previous one is published. `GENERATE_ALL_CONCURRENCY` is re-exported from lib for the unit tests.
 */
export { GENERATE_ALL_CONCURRENCY } from "@/lib/generate-all-fanout";

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
  // Stage 89 — quality & speed picked on the episode-page top panel overrides the project's stored
  // tier for this batch and is persisted back so the choice sticks. Invalid / omitted → keep current.
  const requestedTier = isPowerTier(body?.powerTier) ? body.powerTier : null;
  if (requestedTier && requestedTier !== project.powerTier) {
    try {
      await prisma.project.update({ where: { id: project.id }, data: { powerTier: requestedTier } });
      project.powerTier = requestedTier;
    } catch (e) {
      console.warn("Could not persist project.powerTier (column missing?):", (e as any)?.message);
      project.powerTier = requestedTier;
    }
  }
  const tier = resolvePowerTier(project);
  // Stage 100 — parallel mode removed: generation is ALWAYS a strict one-scene-at-a-time chain. Only
  // the first pending scene is charged and started here; the worker charges and starts each following
  // scene when the previous one is published (lib/workers/video-job.ts → continueChainRun). A failure
  // stops the run with a note.
  {
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
}
