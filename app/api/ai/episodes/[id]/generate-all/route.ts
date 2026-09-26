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
import { normalizeVideoModelId } from "@/lib/video-models";
import { chainOrder } from "@/lib/chain-run";
import { splitByCredits } from "@/lib/generate-all-fanout";
import { persistShotPlanForApprovedEpisode } from "@/lib/workers/shot-plan-persist";

/**
 * Stage 250 — «Generate all scenes» starts a PARALLEL run: every pending scene (SCENE mode) or every
 * pending shot (SHOTS mode) is charged and started AT ONCE (Stage 39 fan-out). Scenes/shots are
 * independent (no scene uses another's last frame as input), so nothing forces sequential order.
 * The episode is left with `chainRunActive=false` (no worker-driven chain); assembly stays a manual
 * step (the «Assemble» button, enabled once every clip is ready).
 * `GENERATE_ALL_CONCURRENCY` is re-exported from lib for the unit tests.
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
  // Video model selector (family + version): the catalog id chosen in the episode top panel drives the
  // whole chain (persisted to Scene.videoModel; the worker inherits it scene-to-scene / shot-to-shot).
  const videoModelId = normalizeVideoModelId(body?.videoModelId ?? body?.provider ?? body?.videoModel);

  const episode = await loadEpisode(id, session.user.id);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (episode.scenes.length === 0) return NextResponse.json({ error: "There are no scenes in the episode" }, { status: 400 });
  // Stage 167 — generation is SHOT-only. If shot planning failed for this episode, refuse to start any
  // video generation (there is no legacy scene fallback); the producer must regenerate the shot plan.
  if (episode.status === "shot_plan_failed") {
    return NextResponse.json({ error: "Shot plan is not ready or failed. Regenerate the shot plan for this episode before generating video.", status: episode.status, chainRunNote: episode.chainRunNote ?? null }, { status: 409 });
  }
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

  // Two generation modes (persisted per episode). Default SCENE mode runs a strict one-SCENE-at-a-time
  // chain (1 scene = 1 clip); the worker charges/starts each following scene and assembles the episode
  // after the last one. Optional «Шоты» mode runs the one-SHOT-at-a-time chain below.
  const generationMode = (episode as { generationMode?: string | null }).generationMode === "shots" ? "shots" : "scene";
  if (generationMode === "scene") {
    for (const scene of episode.scenes) await failStaleJobs({ sceneId: scene.id, type: "video" });
    if (force) {
      await prisma.scene.updateMany({ where: { episodeId: episode.id, status: { not: "generating" } }, data: { videoUrl: null, lastFrameUrl: null, status: "pending" } });
      for (const s of episode.scenes) (s as { videoUrl: string | null }).videoUrl = null;
    }
    // Scenes already in flight are reused (idempotent) and reported as `resumed` — never charged again.
    const runningJobs = await prisma.generationJob.findMany({ where: { sceneId: { in: episode.scenes.map((s) => s.id) }, type: "video", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
    const runningBySceneId = new Map<string, string>();
    for (const j of runningJobs) if (j.sceneId && !runningBySceneId.has(j.sceneId)) runningBySceneId.set(j.sceneId, j.id);
    const resumedJobs = [...runningBySceneId.entries()].map(([sceneId, jobId]) => ({ sceneId, jobId, resumed: true as const }));
    // Candidate scenes to START (parallel fan-out): prompted, no video yet, not generating, no active job.
    const candidates = episode.scenes.filter((s) => !s.videoUrl && s.status !== "generating" && (s.videoPrompt ?? "").trim().length > 0 && !runningBySceneId.has(s.id));
    if (candidates.length === 0) {
      if (resumedJobs.length > 0) {
        await prisma.episode.update({ where: { id: episode.id }, data: { chainRunActive: false, chainRunNote: null } });
        return NextResponse.json({ chain: false, shot: false, jobs: resumedJobs, started: 0, insufficient: [], plan: null, creditsRemaining: user.credits ?? 0 });
      }
      return NextResponse.json({ error: "All episode scenes have already been generated" }, { status: 400 });
    }
    const costOf = (s: (typeof episode.scenes)[number]) => sceneClipCost(tier.id, sceneClipSeconds(tier.id, Math.max(1, Math.round(Number(s.durationSec ?? tier.baseDuration)))));
    // Charge as many scenes as the balance covers, front-to-back; the rest are reported as insufficient.
    const { payable, unpaid } = splitByCredits(candidates, costOf, user.credits ?? 0);
    if (payable.length === 0 && resumedJobs.length === 0) {
      return NextResponse.json({ error: `Insufficient credits: for the next scene need ${costOf(candidates[0])}, balance ${user.credits ?? 0}` }, { status: 402 });
    }
    // Parallel run (Stage 39): NO chain — every payable scene starts at once; assembly is manual.
    await prisma.episode.update({ where: { id: episode.id }, data: { chainRunActive: false, chainRunNote: null } });
    const started: Array<{ sceneId: string; jobId: string }> = [];
    const insufficient = unpaid.map((s) => ({ sceneId: s.id, error: "Insufficient credits" }));
    for (const scene of payable) {
      const duration = sceneClipSeconds(tier.id, Math.max(1, Math.round(Number(scene.durationSec ?? tier.baseDuration))));
      const cost = sceneClipCost(tier.id, duration);
      const charged = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
      if (charged.count !== 1) { insufficient.push({ sceneId: scene.id, error: "Insufficient credits" }); continue; }
      await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Episode ${episode.number}, scene ${scene.number} — video generation (parallel) (${tier.id})` } });
      try { await prisma.scene.update({ where: { id: scene.id }, data: { language: spokenLang } }); } catch (e) { console.warn("Could not persist scene.language:", (e as any)?.message); }
      await prisma.scene.update({ where: { id: scene.id }, data: { status: "generating", videoModel: videoModelId } }).catch(() => {});
      const job = await prisma.generationJob.create({ data: { type: "video", status: "processing", progress: 2, message: "Parallel: starting scene...", projectId: project.id, sceneId: scene.id } });
      // No shotId → the worker renders the whole scene as one clip (runSceneVideoJob).
      runInBackground(() => runVideoJob({ jobId: job.id, sceneId: scene.id, projectId: project.id, userId: user.id, cost, duration, resolution: tier.resolution, provider, videoModelId }));
      started.push({ sceneId: scene.id, jobId: job.id });
    }
    const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
    return NextResponse.json({ chain: false, shot: false, jobs: [...resumedJobs, ...started], started: started.length, insufficient, plan: null, creditsRemaining: fresh?.credits ?? 0 });
  }

  // Stage 250 — SHOTS mode fan-out: EVERY ungenerated shot (the atomic unit) is charged and started at
  // once below (parallel, no chain). The legacy scene generation path has been removed: an episode with
  // no Shot rows cannot be generated and must have its shot plan (re)built first.
  let episodeShots = await prisma.shot.findMany({
    where: { scene: { episodeId: episode.id } },
    select: { id: true, index: true, sceneId: true, videoUrl: true, status: true, duration: true },
  });
  // Self-heal for LEGACY episodes: older projects have Scene rows but were created before the shot plan
  // became mandatory, so they carry ZERO Shot rows and would fail with a 409 forever. On the first
  // "generate video" click we transparently BUILD the shot plan (a pure LLM planning call, not paid
  // video generation) and continue. If the plan cannot be produced, `persistShotPlanForApprovedEpisode`
  // marks the episode `shot_plan_failed`, and we surface the same 409 as before.
  if (episodeShots.length === 0 && episode.status !== "shot_plan_failed") {
    const planResult = await persistShotPlanForApprovedEpisode(episode.id);
    if (planResult.ok) {
      episodeShots = await prisma.shot.findMany({
        where: { scene: { episodeId: episode.id } },
        select: { id: true, index: true, sceneId: true, videoUrl: true, status: true, duration: true },
      });
    }
  }
  if (episodeShots.length === 0) {
    const fresh = await prisma.episode.findUnique({ where: { id: episode.id }, select: { status: true, chainRunNote: true } });
    return NextResponse.json({ error: "Shot plan is not ready or failed. Regenerate the shot plan for this episode before generating video.", status: fresh?.status ?? episode.status, chainRunNote: fresh?.chainRunNote ?? episode.chainRunNote ?? null }, { status: 409 });
  }
  {
    const sceneNumberById = new Map(episode.scenes.map((s) => [s.id, s.number]));
    for (const scene of episode.scenes) await failStaleJobs({ sceneId: scene.id, type: "video" });
    if (force) {
      // Re-run of the whole episode: clear the clips of the shots so the fan-out re-generates them all.
      await prisma.shot.updateMany({ where: { scene: { episodeId: episode.id }, status: { not: "generating" } }, data: { videoUrl: null, lastFrameUrl: null, status: "pending" } });
      for (const s of episodeShots) s.videoUrl = null;
    }
    // Shots whose scene already has a video job in flight are reused (idempotent) and reported as `resumed`.
    const runningJobs = await prisma.generationJob.findMany({ where: { sceneId: { in: episode.scenes.map((s) => s.id) }, type: "video", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
    const runningSceneIds = new Set(runningJobs.map((j) => j.sceneId));
    const resumedJobs: Array<{ sceneId: string; jobId: string; resumed: true }> = [];
    const seenScene = new Set<string>();
    for (const j of runningJobs) if (j.sceneId && !seenScene.has(j.sceneId)) { seenScene.add(j.sceneId); resumedJobs.push({ sceneId: j.sceneId, jobId: j.id, resumed: true }); }
    // Candidate shots to START (parallel fan-out): no clip yet, not generating, scene has no active video job.
    const candidateShots = episodeShots.filter((s) => !s.videoUrl && s.status !== "generating" && !runningSceneIds.has(s.sceneId));
    if (candidateShots.length === 0) {
      if (resumedJobs.length > 0) {
        await prisma.episode.update({ where: { id: episode.id }, data: { chainRunActive: false, chainRunNote: null } });
        return NextResponse.json({ chain: false, shot: true, jobs: resumedJobs, started: 0, insufficient: [], plan: null, creditsRemaining: user.credits ?? 0 });
      }
      return NextResponse.json({ error: "All episode shots have already been generated" }, { status: 400 });
    }
    // Order candidate shots globally (sceneNumber, index) so credits are spent front-to-back.
    const orderedCandidates = [...candidateShots].sort((a, b) => (sceneNumberById.get(a.sceneId) ?? 0) - (sceneNumberById.get(b.sceneId) ?? 0) || a.index - b.index);
    const costOf = (s: (typeof episodeShots)[number]) => sceneClipCost(tier.id, sceneClipSeconds(tier.id, Math.max(1, Math.round(Number(s.duration ?? 3)))));
    const { payable, unpaid } = splitByCredits(orderedCandidates, costOf, user.credits ?? 0);
    if (payable.length === 0 && resumedJobs.length === 0) {
      return NextResponse.json({ error: `Insufficient credits: for the next shot need ${costOf(orderedCandidates[0])}, balance ${user.credits ?? 0}` }, { status: 402 });
    }
    // Parallel run (Stage 39): NO chain — every payable shot starts at once; assembly is manual.
    await prisma.episode.update({ where: { id: episode.id }, data: { chainRunActive: false, chainRunNote: null } });
    const started: Array<{ sceneId: string; shotId: string; jobId: string }> = [];
    const insufficient = unpaid.map((s) => ({ sceneId: s.sceneId, error: "Insufficient credits" }));
    for (const shotRow of payable) {
      const duration = sceneClipSeconds(tier.id, Math.max(1, Math.round(Number(shotRow.duration ?? 3))));
      const cost = sceneClipCost(tier.id, duration);
      const charged = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
      if (charged.count !== 1) { insufficient.push({ sceneId: shotRow.sceneId, error: "Insufficient credits" }); continue; }
      const sceneNumber = sceneNumberById.get(shotRow.sceneId) ?? 0;
      await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Episode ${episode.number}, scene ${sceneNumber}, shot ${shotRow.index + 1} — video generation (parallel) (${tier.id})` } });
      await prisma.shot.update({ where: { id: shotRow.id }, data: { status: "generating", error: null } });
      // Persist the selected model on the shot's parent scene so every shot renders on one model.
      await prisma.scene.update({ where: { id: shotRow.sceneId }, data: { videoModel: videoModelId } }).catch(() => {});
      const job = await prisma.generationJob.create({ data: { type: "video", status: "processing", progress: 2, message: "Parallel: starting shot...", projectId: project.id, sceneId: shotRow.sceneId } });
      runInBackground(() => runVideoJob({ jobId: job.id, sceneId: shotRow.sceneId, shotId: shotRow.id, projectId: project.id, userId: user.id, cost, duration, resolution: tier.resolution, provider, videoModelId }));
      started.push({ sceneId: shotRow.sceneId, shotId: shotRow.id, jobId: job.id });
    }
    const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
    return NextResponse.json({ chain: false, shot: true, jobs: [...resumedJobs, ...started], started: started.length, insufficient, plan: null, creditsRemaining: fresh?.credits ?? 0 });
  }
}
