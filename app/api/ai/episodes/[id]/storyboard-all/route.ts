export const dynamic = "force-dynamic";
export const maxDuration = 800; // the frames are rendered one after another inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs, heartbeatJob } from "@/lib/jobs";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";
import { runStoryboardJob, STORYBOARD_JOB_TYPE } from "@/lib/workers/storyboard-job";

/**
 * POST /api/ai/episodes/[id]/storyboard-all
 * Stage 64: render the storyboard frame of EVERY scene of the episode that has no APPROVED frame yet,
 * strictly ONE AFTER ANOTHER in scene order (each continuation scene attaches the previous scene's
 * freshly rendered frame, so the order matters). Scenes with an active storyboard job are reused (not
 * charged again). Credits: CHARACTER_REFERENCE_COST per frame, charged up front for as many scenes as the
 * balance covers — the rest are reported in `insufficient`; if nothing can be paid → 402.
 * Response: { jobs: [{sceneId, sceneNumber, jobId, resumed?}], started, insufficient, creditsRemaining }.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:storyboard-all", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: { season: { select: { projectId: true } }, scenes: { orderBy: { number: "asc" } } },
  });
  if (!episode) return NextResponse.json({ error: "Эпизод не найден" }, { status: 404 });
  if (episode.scenes.length === 0) return NextResponse.json({ error: "В эпизоде нет сцен" }, { status: 400 });
  const projectId = episode.season.projectId;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { id: true, credits: true } });

  const jobs: Array<{ sceneId: string; sceneNumber: number; jobId: string; resumed?: boolean }> = [];
  const toStart: typeof episode.scenes = [];
  for (const scene of episode.scenes) {
    if (!(scene.videoPrompt ?? "").trim()) continue;
    await failStaleJobs({ sceneId: scene.id, type: STORYBOARD_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { sceneId: scene.id, type: STORYBOARD_JOB_TYPE, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" },
    });
    if (active) { jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: active.id, resumed: true }); continue; }
    if (scene.storyboardApproved && (scene.storyboardUrl ?? "").trim()) continue;
    toStart.push(scene);
  }
  if (!toStart.length && !jobs.length) return NextResponse.json({ error: "Все кадры эпизода уже утверждены" }, { status: 400 });

  const cost = CHARACTER_REFERENCE_COST;
  const affordable = Math.max(0, Math.floor((user.credits ?? 0) / cost));
  if (toStart.length && affordable === 0) {
    return NextResponse.json({ error: `Недостаточно кредитов: нужно ${toStart.length * cost} (${toStart.length} кадров), на балансе ${user.credits ?? 0}` }, { status: 402 });
  }
  const payable = toStart.slice(0, affordable);
  const insufficient = toStart.slice(affordable).map(s => ({ sceneId: s.id, sceneNumber: s.number, error: "Недостаточно кредитов" }));

  // Charge + create queued jobs up front so the UI shows every scene as queued immediately.
  const queued: Array<{ jobId: string; sceneId: string; sceneNumber: number }> = [];
  for (const scene of payable) {
    const charged = await prisma.user.updateMany({ where: { id: user.id, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
    if (charged.count !== 1) { insufficient.push({ sceneId: scene.id, sceneNumber: scene.number, error: "Недостаточно кредитов" }); continue; }
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Эпизод ${episode.number}, сцена ${scene.number} — кадр сториборда` } });
    const job = await prisma.generationJob.create({
      data: { type: STORYBOARD_JOB_TYPE, status: "pending", progress: 1, message: "В очереди…", projectId, sceneId: scene.id },
    });
    queued.push({ jobId: job.id, sceneId: scene.id, sceneNumber: scene.number });
    jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: job.id });
  }

  if (queued.length) {
    runInBackground(async () => {
      // SEQUENTIAL: scene N+1 starts only after scene N finished, so its previous_storyboard reference exists.
      const waiting = new Set(queued.map(q => q.jobId));
      const tick = async () => { for (const j of waiting) await heartbeatJob(j); };
      for (const item of queued) {
        waiting.delete(item.jobId);
        try {
          await runStoryboardJob({ jobId: item.jobId, sceneId: item.sceneId, projectId, userId: user.id, cost, onTick: tick });
        } catch (err) {
          console.error(`[storyboard-all] scene ${item.sceneNumber} failed:`, err);
        }
        await tick();
      }
    });
  }

  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
  return NextResponse.json({ jobs, started: queued.length, insufficient, creditsRemaining: fresh?.credits ?? 0 });
}
