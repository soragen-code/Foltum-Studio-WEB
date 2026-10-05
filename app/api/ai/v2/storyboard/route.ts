export const dynamic = "force-dynamic";
export const maxDuration = 800; // сборка листа-сториборда крутится в фоне этой инвокации

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { chargeV2Credits } from "@/lib/v2-credits";
import { V2_COSTS } from "@/lib/v2-costs";
import { runEpisodeStoryboardV2Job, EPISODE_STORYBOARD_V2_JOB_TYPE } from "@/lib/workers/episode-storyboard-v2-job";
import { episodeShotsV2From, episodeStoryboardV2From } from "@/lib/idea-v2";
import { peekStoryboardV2AutoPrompt, storyboardV2PromptInputs } from "@/lib/storyboard-v2-prompt";
import { activeEpisodeJob, latestEpisodeJob, setEpisodeStoryboardV2 } from "@/lib/episode-storyboard-v2-store";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * Поток v2 · вкладка «Сториборд» серии n.
 * POST  { projectId, episode } → собрать один сводный лист-сториборд по всему шот-листу серии (GenerationJob "episode_storyboard_v2"; идемпотентно по серии).
 * GET   ?projectId&episode     → { job, storyboard, autoPrompt (кэш или ""), refs }.
 * Сборка/выдача авто-промпта по кнопке «Промпт» — ./prompt/route.ts.
 */
const postSchema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(1).max(999), prompt: z.string().max(200000).optional() });

async function ownedProject(email: string, projectId: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;
  return prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, userId: true, episodeShotsV2: true, episodeRefsV2: true, episodeStoryboardV2: true } });
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
    const limited = rateLimitByUser(request, "ai:v2:storyboard", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    if (typeof parsed.data.prompt === "string") { const d = await denyFeature(session.user.email, "prompt_edit"); if (d) return d; } // правка/сброс промпта сториборда — Studio
    const { projectId, episode } = parsed.data;

    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const shots = episodeShotsV2From(project.episodeShotsV2, episode);
    if (!shots.length) return NextResponse.json({ error: "Сначала разбейте сценарий на кадры" }, { status: 400 });

    // Ручная правка промпта: пустая строка → сброс к авто (null); непустая → переопределение.
    if (typeof parsed.data.prompt === "string") {
      const ov = parsed.data.prompt.trim() ? parsed.data.prompt : null;
      await setEpisodeStoryboardV2(projectId, episode, { promptOverride: ov });
    }

    await failStaleJobs({ projectId, type: EPISODE_STORYBOARD_V2_JOB_TYPE });
    const active = await activeEpisodeJob(projectId, EPISODE_STORYBOARD_V2_JOB_TYPE, episode);
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: EPISODE_STORYBOARD_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify({ episode }) },
    });
    const charge = await chargeV2Credits(project.userId, V2_COSTS.storyboard, "storyboard", job.id);
    if (!charge.ok) {
      await prisma.generationJob.delete({ where: { id: job.id } }).catch(() => {});
      return NextResponse.json(charge.body, { status: charge.status });
    }
    runInBackground(() => runEpisodeStoryboardV2Job(job.id, projectId, { episode }));
    return NextResponse.json({ jobId: job.id, resumed: false, cost: charge.cost, creditsRemaining: charge.creditsRemaining });
  } catch (err: any) {
    console.error("Episode storyboard v2 build error:", err);
    return NextResponse.json({ error: "Storyboard build failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Без активной подписки (Basic+) генерация недоступна целиком.
  { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const episode = Number(url.searchParams.get("episode"));
  if (!projectId || !Number.isInteger(episode)) return NextResponse.json({ error: "projectId and episode required" }, { status: 400 });
  const project = await ownedProject(session.user.email, projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: EPISODE_STORYBOARD_V2_JOB_TYPE });
  const job = await latestEpisodeJob(projectId, EPISODE_STORYBOARD_V2_JOB_TYPE, episode);

  // Превью: ТОЛЬКО кэш авто-промпта (без LLM) — пустая строка, если он ещё не построен или устарел
  // (клиент тогда строит его по кнопке «Промпт» через POST /api/ai/v2/storyboard/prompt); плюс референсы для генерации.
  const inputs = storyboardV2PromptInputs(project, episode);
  const refs = inputs.refs;
  const autoPrompt = peekStoryboardV2AutoPrompt(project, episode, inputs);
  const refsPreview = refs.map((r) => ({ id: r.id, label: r.label, kind: r.kind, imageUrl: r.imageUrl }));

  return NextResponse.json({
    job,
    storyboard: episodeStoryboardV2From(project.episodeStoryboardV2, episode),
    autoPrompt,
    refs: refsPreview,
    shotsCount: episodeShotsV2From(project.episodeShotsV2, episode).length,
  }, { headers: { "Cache-Control": "no-store" } });
}
