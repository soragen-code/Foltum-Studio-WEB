/**
 * Stage 153 — server-side chain re-arm (used by the /api/cron/advance-chains sweeper).
 *
 * This MIRRORS `continueChainRun` in lib/workers/video-job.ts (which is private and, being part of the
 * pinned SCENES pipeline, is kept byte-identical). It starts the next pending scene of an ACTIVE chain
 * whose earliest ungenerated scene is idle — the case where no video job exists at all (e.g. the initial
 * `after()` invocation died before the next job was created), which `resumeVideoJob` cannot recover
 * because there is no prediction to poll.
 *
 * Idempotency: it re-checks for an in-flight video job on the target scene immediately before charging
 * and creates the job atomically, exactly like `continueChainRun`, so it never double-starts a scene and
 * never starts N+1 while N is unfinished (the caller only invokes it for the lowest idle scene).
 */
import { prisma } from "@/lib/db";
import { runInBackground } from "@/lib/jobs";
import { nextSequentialChainScene, chainStopMessage, CHAIN_INSUFFICIENT_CREDITS } from "@/lib/chain-run";
import { resolvePowerTier } from "@/lib/power-tier";
import { sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { normalizeVideoModel } from "@/lib/ai-models";
import { runVideoJob } from "@/lib/workers/video-job";

export async function advanceChainScene(episodeId: string, finishedSceneNumber: number): Promise<boolean> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { season: { include: { project: true } }, scenes: { orderBy: { number: "asc" } } },
  });
  if (!episode || !episode.chainRunActive) return false;
  const project = episode.season.project;
  // Stage 163 — strict sequential: re-arm the LOWEST ungenerated scene, never skip ahead past a gap.
  const next = nextSequentialChainScene(episode.scenes);
  if (!next) {
    await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: false } });
    return false;
  }
  // Idempotency: a job may have been started meanwhile (manually or by finalizeVideoJob) — its own
  // finalize continues the chain, so do nothing here.
  const active = await prisma.generationJob.findFirst({
    where: { sceneId: next.id, type: "video", status: { in: ["pending", "processing"] } },
  });
  if (active) return false;
  const tier = resolvePowerTier(project);
  const duration = sceneClipSeconds(tier.id, next.durationSec);
  const cost = sceneClipCost(tier.id, duration);
  const charged = await prisma.user.updateMany({
    where: { id: project.userId, credits: { gte: cost } },
    data: { credits: { decrement: cost } },
  });
  if (charged.count !== 1) {
    await prisma.episode.update({
      where: { id: episodeId },
      data: { chainRunActive: false, chainRunNote: chainStopMessage(next.number, CHAIN_INSUFFICIENT_CREDITS) },
    });
    return false;
  }
  await prisma.creditTransaction.create({
    data: {
      userId: project.userId,
      amount: -cost,
      description: `Episode ${episode.number}, scene ${next.number} — video generation via chain (${tier.id})`,
    },
  });
  await prisma.scene.update({
    where: { id: next.id },
    data: { status: "generating", language: "en", videoModel: normalizeVideoModel(null) },
  });
  const job = await prisma.generationJob.create({
    data: { type: "video", status: "processing", progress: 2, message: "Chain: starting next scene...", projectId: project.id, sceneId: next.id },
  });
  runInBackground(() => runVideoJob({ jobId: job.id, sceneId: next.id, projectId: project.id, userId: project.userId, cost, duration, resolution: tier.resolution }));
  return true;
}
