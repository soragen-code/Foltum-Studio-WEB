export const dynamic = "force-dynamic";
export const maxDuration = 800; // resubmitted scene jobs run in the background via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, updateJob } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { normalizeVideoModel } from "@/lib/ai-models";
import { resolvePowerTier } from "@/lib/power-tier";
import { sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { planContinuation, type SceneJobSnapshot } from "@/lib/batch-continue";
import { GENERATE_ALL_CONCURRENCY } from "@/lib/generate-all-fanout";

/** Stage 39: mirrors GENERATE_ALL_CONCURRENCY (no cap) — every kickable scene is (re)started per invocation. */
const CONTINUE_CONCURRENCY = GENERATE_ALL_CONCURRENCY;
/** A pending/processing job with no predictionId untouched for this long is orphaned → resubmit. */
const KICK_STALE_MS = 75_000;
/** Auto-continue never creates more than this many jobs per scene (broken scene can't loop forever). */
const AUTO_MAX_ATTEMPTS = 2;
/** Manual "retry unfinished" raises the ceiling and retries moderation failures once more too. */
const MANUAL_MAX_ATTEMPTS = 4;

const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;
const hasPredictionId = (resultData: string | null) => !!resultData && resultData.includes('"predictionId":');

async function loadEpisode(episodeId: string, userId: string) {
  return prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId } } },
    include: { season: { include: { project: true } }, scenes: { orderBy: { number: "asc" } } },
  });
}

/**
 * POST /api/ai/episodes/[id]/generate-all/continue { retryFailed? }
 *
 * Idempotent "kick": (re)starts scenes whose video is still missing and moves the batch forward.
 *  - orphaned pending jobs (never submitted) are resubmitted on the SAME job → no new charge;
 *  - failed-retryable scenes are re-charged and get a fresh job (capped attempts);
 *  - scenes with a video, or a job with a live prediction, are NEVER touched.
 * The client calls this every few seconds until { remaining } reaches 0.
 * Returns per-scene status so the UI shows a stable "N из M" indicator and the failed list.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:generate-all-continue", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const retryFailed = Boolean(body?.retryFailed);

  const episode = await loadEpisode(id, session.user.id);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const project = episode.season.project;
  const tier = resolvePowerTier(project);
  const now = Date.now();

  // Only scenes that can actually be generated (have a prompt) participate in the batch.
  const scenes = episode.scenes.filter((s) => s.videoPrompt);
  const sceneIds = scenes.map((s) => s.id);
  const jobs = sceneIds.length
    ? await prisma.generationJob.findMany({ where: { sceneId: { in: sceneIds }, type: "video" }, orderBy: { createdAt: "desc" } })
    : [];
  const jobsByScene = new Map<string, typeof jobs>();
  for (const j of jobs) {
    if (!j.sceneId) continue;
    const arr = jobsByScene.get(j.sceneId) ?? [];
    arr.push(j);
    jobsByScene.set(j.sceneId, arr);
  }
  const latestJobId = new Map<string, string>(); // sceneId -> latest job id (for resubmit / client polling)

  const snaps: SceneJobSnapshot[] = scenes.map((s) => {
    const sceneJobs = jobsByScene.get(s.id) ?? [];
    const latest = sceneJobs[0] ?? null;
    if (latest) latestJobId.set(s.id, latest.id);
    return {
      sceneId: s.id,
      number: s.number,
      hasVideo: validUrl(s.videoUrl),
      attempts: sceneJobs.length,
      latestJob: latest
        ? {
            status: latest.status,
            hasPrediction: hasPredictionId(latest.resultData),
            isModeration: (latest.error ?? "").toLowerCase().includes("moderation"),
            updatedAtMs: latest.updatedAt.getTime(),
          }
        : null,
    };
  });

  const plan = planContinuation(snaps, {
    nowMs: now,
    kickStaleMs: KICK_STALE_MS,
    concurrency: CONTINUE_CONCURRENCY,
    maxAttempts: AUTO_MAX_ATTEMPTS,
    retryFailed,
    manualMaxAttempts: MANUAL_MAX_ATTEMPTS,
  });

  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const started: Array<{ sceneId: string; jobId: string; sceneNumber: number }> = [];

  // 1) Resubmit orphaned, already-charged jobs on the SAME job id (no new charge).
  for (const sceneId of plan.resubmit) {
    const scene = sceneById.get(sceneId);
    const jobId = latestJobId.get(sceneId);
    if (!scene || !jobId) continue;
    // Atomic claim: only if still a stale, never-submitted pending/processing job.
    const claim = await prisma.generationJob.updateMany({
      where: { id: jobId, status: { in: ["pending", "processing"] }, updatedAt: { lt: new Date(now - KICK_STALE_MS) } },
      data: { status: "processing", progress: 2, message: "Возобновляю генерацию…" },
    });
    if (claim.count !== 1) continue; // another continue call grabbed it
    const duration = sceneClipSeconds(tier.id, scene.durationSec);
    const cost = sceneClipCost(tier.id, duration);
    await prisma.scene.update({ where: { id: scene.id }, data: { status: "generating" } }).catch(() => {});
    runInBackground(() => runVideoJob({ jobId, sceneId: scene.id, projectId: project.id, userId: session.user.id, cost, duration, resolution: tier.resolution, provider: normalizeVideoModel(scene.videoModel) }));
    started.push({ sceneId: scene.id, jobId, sceneNumber: scene.number });
  }

  // 2) Retry failed / never-started scenes with a fresh charge (capped by the planner).
  let creditsShort = false;
  for (const sceneId of plan.retry) {
    const scene = sceneById.get(sceneId);
    if (!scene) continue;
    const duration = sceneClipSeconds(tier.id, scene.durationSec);
    const cost = sceneClipCost(tier.id, duration);
    // Atomic, race-safe charge: decrement only if the balance covers it.
    const charged = await prisma.user.updateMany({ where: { id: session.user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
    if (charged.count !== 1) { creditsShort = true; continue; }
    await prisma.creditTransaction.create({ data: { userId: session.user.id, amount: -cost, description: `Эпизод ${episode.number}, сцена ${scene.number} — повтор генерации (${tier.id})` } });
    await prisma.scene.update({ where: { id: scene.id }, data: { status: "generating", language: "en" } }).catch(() => {});
    const job = await prisma.generationJob.create({ data: { type: "video", status: "processing", progress: 2, message: "Старт видеомодели…", projectId: project.id, sceneId: scene.id } });
    runInBackground(() => runVideoJob({ jobId: job.id, sceneId: scene.id, projectId: project.id, userId: session.user.id, cost, duration, resolution: tier.resolution, provider: normalizeVideoModel(scene.videoModel) }));
    started.push({ sceneId: scene.id, jobId: job.id, sceneNumber: scene.number });
  }

  // Reflect just-started scenes as "generating" in the returned snapshot + attach job ids for polling.
  const startedIds = new Set(started.map((s) => s.sceneId));
  const sceneStatuses = plan.scenes.map((s) => {
    const jobId = started.find((x) => x.sceneId === s.sceneId)?.jobId ?? latestJobId.get(s.sceneId);
    const status = startedIds.has(s.sceneId) ? "generating" : s.status;
    return { ...s, status, jobId: jobId ?? null };
  });
  const generating = sceneStatuses.filter((s) => s.status === "generating").length;
  const done = sceneStatuses.filter((s) => s.status === "done").length;
  const failed = sceneStatuses.filter((s) => s.status === "failed").length;
  const pending = sceneStatuses.filter((s) => s.status === "pending").length;
  const fresh = await prisma.user.findUnique({ where: { id: session.user.id }, select: { credits: true } });

  return NextResponse.json({
    total: plan.total,
    done,
    generating,
    failed,
    pending,
    remaining: pending + generating,
    started: started.length,
    creditsShort,
    creditsRemaining: fresh?.credits ?? 0,
    scenes: sceneStatuses,
  });
}
