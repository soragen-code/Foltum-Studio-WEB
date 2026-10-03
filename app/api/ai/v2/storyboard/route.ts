export const dynamic = "force-dynamic";
export const maxDuration = 800; // сборка листа-сториборда крутится в фоне этой инвокации

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runEpisodeStoryboardV2Job, EPISODE_STORYBOARD_V2_JOB_TYPE } from "@/lib/workers/episode-storyboard-v2-job";
import { buildStoryboardV2Prompt, episodeRefsV2From, episodeShotsV2From, episodeStoryboardV2From, selectStoryboardV2Refs, shotVisualText } from "@/lib/idea-v2";
import { activeEpisodeJob, latestEpisodeJob, setEpisodeStoryboardV2 } from "@/lib/episode-storyboard-v2-store";
import { WAVESPEED_IMAGE_MAX_REFS } from "@/lib/providers/image-provider";
import { VISUAL_STYLE } from "@/lib/visual-style";
import { translateRefLabelsToEnglish, translateToEnglish } from "@/lib/translate-en";

/**
 * Поток v2 · вкладка «Сториборд» серии n.
 * POST  { projectId, episode } → собрать один сводный лист-сториборд по всему шот-листу серии (GenerationJob "episode_storyboard_v2"; идемпотентно по серии).
 * GET   ?projectId&episode     → { job, storyboard }.
 */
const postSchema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(1).max(999), prompt: z.string().max(200000).optional() });

async function ownedProject(email: string, projectId: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;
  return prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, episodeShotsV2: true, episodeRefsV2: true, episodeStoryboardV2: true } });
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:v2:storyboard", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
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
    runInBackground(() => runEpisodeStoryboardV2Job(job.id, projectId, { episode }));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Episode storyboard v2 build error:", err);
    return NextResponse.json({ error: "Storyboard build failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const episode = Number(url.searchParams.get("episode"));
  if (!projectId || !Number.isInteger(episode)) return NextResponse.json({ error: "projectId and episode required" }, { status: 400 });
  const project = await ownedProject(session.user.email, projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: EPISODE_STORYBOARD_V2_JOB_TYPE });
  const job = await latestEpisodeJob(projectId, EPISODE_STORYBOARD_V2_JOB_TYPE, episode);

  // Превью: собранный авто-промпт (с описанием референсов) + сами референсы, которые уйдут в генерацию.
  const shots = episodeShotsV2From(project.episodeShotsV2, episode);
  const refs = selectStoryboardV2Refs(episodeRefsV2From(project.episodeRefsV2, episode), WAVESPEED_IMAGE_MAX_REFS);
  // Как в воркере: action шотов переводятся на English (no-op для уже английских), чтобы превью совпадало с отправкой.
  const shotsEn = await Promise.all(shots.map(async (sh) => ({ ...sh, action: (await translateToEnglish(shotVisualText(sh))) || shotVisualText(sh) })));
  const refsEn = await translateRefLabelsToEnglish(refs);
  const autoPrompt = shots.length ? `[VISUAL STYLE]: ${VISUAL_STYLE}\n${buildStoryboardV2Prompt(shotsEn, refsEn)}` : "";
  const refsPreview = refs.map((r) => ({ id: r.id, label: r.label, kind: r.kind, imageUrl: r.imageUrl }));

  return NextResponse.json({
    job,
    storyboard: episodeStoryboardV2From(project.episodeStoryboardV2, episode),
    autoPrompt,
    refs: refsPreview,
  }, { headers: { "Cache-Control": "no-store" } });
}
