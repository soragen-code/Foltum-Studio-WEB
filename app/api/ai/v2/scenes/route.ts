export const dynamic = "force-dynamic";
export const maxDuration = 800; // нарезка кадров / видео сцен крутятся в фоне этой инвокации

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runEpisodeSceneFramesV2Job, prepareScenePromptData, EPISODE_SCENE_FRAMES_V2_JOB_TYPE } from "@/lib/workers/episode-scene-frames-v2-job";
import { runEpisodeSceneVideoV2Job, EPISODE_SCENE_VIDEO_V2_JOB_TYPE } from "@/lib/workers/episode-scene-video-v2-job";
import { runEpisodeAssembleV2Job, EPISODE_ASSEMBLE_V2_JOB_TYPE } from "@/lib/workers/episode-assemble-v2-job";
import { allSceneVideosReady, episodeFinalV2From, episodeRefsV2From, episodeScenesV2From, episodeShotsV2From, episodeStoryboardV2From, MAX_SCENE_VIDEO_REF_IMAGES, sceneVideoV2Prompt, selectSceneVideoV2Refs, selectStoryboardV2Refs } from "@/lib/idea-v2";
import { activeEpisodeJob, latestEpisodeJob, patchEpisodeSceneV2, setEpisodeFinalV2, setEpisodeScenesV2 } from "@/lib/episode-scenes-v2-store";
import { setEpisodeStoryboardV2 } from "@/lib/episode-storyboard-v2-store";
import { WAVESPEED_IMAGE_MAX_REFS } from "@/lib/providers/image-provider";
import { translateToEnglish } from "@/lib/translate-en";

/**
 * Поток v2 · вкладка «Сцены» серии n.
 * POST  { projectId, episode, action: "approve" }    → сториборд approved=true + job "episode_scene_frames_v2" (нарезка первых кадров 9:16).
 * POST  { projectId, episode, action: "launch-all" } → job "episode_scene_video_v2" (Seedance i2v по всем сценам с первым кадром).
 * POST  { projectId, episode, action: "assemble" }   → job "episode_assemble_v2" (ffmpeg-склейка всех видео сцен по index → финальный mp4 в S3).
 * POST  { projectId, episode, action: "rebuild-prompts" } → синхронно пересобирает action/frame/endFrame/refIds существующих сцен
 *       по текущему шот-листу и референсам (кадры, видео, статусы и ручные промпты сохраняются; картинки не перегенерируются).
 * PATCH { projectId, episode, sceneId, prompt }      → promptOverride сцены (пустая строка → сброс к авто).
 * Исполнение — полностью на сервере: POST только создаёт GenerationJob и запускает воркер в after() этой инвокации
 * (ответ возвращается сразу, закрытие вкладки работу не прерывает). Воркеры возобновляемые: если инвокация упёрлась
 * в maxDuration или упала, cron /api/cron/advance-chains (resumeEpisodeScenesV2Jobs) перезапускает их раз в минуту.
 * GET лишь ЧИТАЕТ состояние (сцены + последние job) — поллинг вкладки ничего не двигает.
 * GET   ?projectId&episode → { scenes (+autoPrompt/videoPrompt), refs, approved, framesJob, videoJob }.
 */
const postSchema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(1).max(999), action: z.enum(["approve", "launch-all", "assemble", "rebuild-prompts"]) });
const patchSchema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(1).max(999), sceneId: z.string().min(1).max(64), prompt: z.string().max(100000) });

async function ownedProject(email: string, projectId: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;
  return prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, episodeShotsV2: true, episodeRefsV2: true, episodeStoryboardV2: true, episodeScenesV2: true, episodeFinalV2: true } });
}

async function startJob(projectId: string, episode: number, type: string, run: (jobId: string) => Promise<void>) {
  await failStaleJobs({ projectId, type });
  const active = await activeEpisodeJob(projectId, type, episode);
  if (active) return { jobId: active.id, resumed: true };
  const job = await prisma.generationJob.create({
    data: { type, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify({ episode }) },
  });
  runInBackground(() => run(job.id));
  return { jobId: job.id, resumed: false };
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:v2:scenes", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, episode, action } = parsed.data;

    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    if (action === "approve") {
      if (!episodeShotsV2From(project.episodeShotsV2, episode).length) return NextResponse.json({ error: "Сначала разбейте сценарий на кадры" }, { status: 400 });
      if (!episodeStoryboardV2From(project.episodeStoryboardV2, episode)?.imageUrl) return NextResponse.json({ error: "Сначала соберите сториборд" }, { status: 400 });
      await setEpisodeStoryboardV2(projectId, episode, { approved: true });
      const r = await startJob(projectId, episode, EPISODE_SCENE_FRAMES_V2_JOB_TYPE, (jobId) => runEpisodeSceneFramesV2Job(jobId, projectId, { episode }));
      return NextResponse.json(r);
    }

    if (action === "rebuild-prompts") {
      const shots = episodeShotsV2From(project.episodeShotsV2, episode);
      const scenes = episodeScenesV2From(project.episodeScenesV2, episode);
      if (!shots.length) return NextResponse.json({ error: "Сначала разбейте сценарий на кадры" }, { status: 400 });
      if (!scenes.length) return NextResponse.json({ error: "Нет сцен для пересборки" }, { status: 400 });
      if (await activeEpisodeJob(projectId, EPISODE_SCENE_FRAMES_V2_JOB_TYPE, episode)) return NextResponse.json({ error: "Дождитесь окончания нарезки сцен" }, { status: 409 });
      // Сцена ↔ шот: по shotId, иначе по номеру (scene-N ↔ shot #N). Сцены без шота остаются как есть.
      const byId = new Map(shots.map((s) => [s.id, s]));
      const byIndex = new Map(shots.map((s) => [s.index, s]));
      const pairs = scenes.map((sc) => ({ sc, shot: byId.get(sc.shotId) ?? byIndex.get(sc.index) ?? null }));
      const matched = pairs.filter((p): p is { sc: typeof p.sc; shot: NonNullable<typeof p.shot> } => !!p.shot);
      if (!matched.length) return NextResponse.json({ error: "Сцены не соответствуют текущему шот-листу — подтвердите сториборд заново" }, { status: 400 });
      const prepared = await prepareScenePromptData(matched.map((p) => p.shot), episodeRefsV2From(project.episodeRefsV2, episode));
      const byScene = new Map(matched.map((p, i) => [p.sc.id, { shot: p.shot, data: prepared[i] }]));
      const next = scenes.map((sc) => {
        const m = byScene.get(sc.id);
        return m ? { ...sc, shotId: m.shot.id, durationSec: m.shot.durationSec, ...m.data } : sc;
      });
      await setEpisodeScenesV2(projectId, episode, next);
      return NextResponse.json({ ok: true, rebuilt: matched.length, total: scenes.length });
    }

    if (action === "assemble") {
      if (!allSceneVideosReady(episodeScenesV2From(project.episodeScenesV2, episode))) {
        return NextResponse.json({ error: "Дождитесь готовности всех видео сцен", allVideosReady: false }, { status: 400 });
      }
      const active = await activeEpisodeJob(projectId, EPISODE_ASSEMBLE_V2_JOB_TYPE, episode);
      if (!active) await setEpisodeFinalV2(projectId, episode, { status: "pending", error: "" });
      const r = await startJob(projectId, episode, EPISODE_ASSEMBLE_V2_JOB_TYPE, (jobId) => runEpisodeAssembleV2Job(jobId, projectId, { episode }));
      return NextResponse.json(r);
    }

    if (!episodeScenesV2From(project.episodeScenesV2, episode).some((s) => s.firstFrameUrl)) {
      return NextResponse.json({ error: "Нет сцен с готовым первым кадром" }, { status: 400 });
    }
    const r = await startJob(projectId, episode, EPISODE_SCENE_VIDEO_V2_JOB_TYPE, (jobId) => runEpisodeSceneVideoV2Job(jobId, projectId, { episode }));
    return NextResponse.json(r);
  } catch (err: any) {
    console.error("Episode scenes v2 error:", err);
    return NextResponse.json({ error: "Scenes request failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, episode, sceneId, prompt } = parsed.data;
    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const n = await patchEpisodeSceneV2(projectId, episode, sceneId, { promptOverride: prompt.trim() ? prompt : null });
    if (!n) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Episode scenes v2 patch error:", err);
    return NextResponse.json({ error: "Save failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
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

  await failStaleJobs({ projectId, type: EPISODE_SCENE_FRAMES_V2_JOB_TYPE });
  await failStaleJobs({ projectId, type: EPISODE_SCENE_VIDEO_V2_JOB_TYPE });
  await failStaleJobs({ projectId, type: EPISODE_ASSEMBLE_V2_JOB_TYPE });
  const [framesJob, videoJob, assembleJob] = await Promise.all([
    latestEpisodeJob(projectId, EPISODE_SCENE_FRAMES_V2_JOB_TYPE, episode),
    latestEpisodeJob(projectId, EPISODE_SCENE_VIDEO_V2_JOB_TYPE, episode),
    latestEpisodeJob(projectId, EPISODE_ASSEMBLE_V2_JOB_TYPE, episode),
  ]);

  // Те же референсы, что уходят в нарезку (лист-сториборд занимает один слот image_input).
  // Метки референсов переводятся на English один раз (превью промпта = только English, как в воркере).
  const refs = selectStoryboardV2Refs(episodeRefsV2From(project.episodeRefsV2, episode), WAVESPEED_IMAGE_MAX_REFS - 1);
  const storyboard = episodeStoryboardV2From(project.episodeStoryboardV2, episode);
  // Авто-промпты — только English: action хранится уже переведённым, но страхуемся (translateToEnglish —
  // локальная детекция языка, no-op для English, так что поллинг не гоняет LLM).
  // Промпт сцены = только T2V-промпт видео (промпт первого кадра сюда НЕ подмешивается). autoPrompt —
  // авто-версия без ручного override (базовая для сравнения в модалке); videoPrompt — итоговый (с override).
  const rawScenes = episodeScenesV2From(project.episodeScenesV2, episode);
  // Референсы блока REFERENCES — персонажи и реквизит ЭТОЙ сцены, тот же набор и порядок, что воркер прикладывает после первого кадра.
  const allRefs = episodeRefsV2From(project.episodeRefsV2, episode);
  const scenes = await Promise.all(rawScenes.map(async (s) => {
    const videoRefs = selectSceneVideoV2Refs(allRefs, MAX_SCENE_VIDEO_REF_IMAGES - 1, s);
    const [actionEn, endEn] = await Promise.all([translateToEnglish(s.action), translateToEnglish(s.endFrame)]);
    const en = { ...s, action: actionEn || s.action, endFrame: endEn || s.endFrame };
    return { ...s, autoPrompt: sceneVideoV2Prompt({ action: en.action, endFrame: en.endFrame, promptOverride: null }, videoRefs), videoPrompt: sceneVideoV2Prompt(en, videoRefs) };
  }));
  // Если job склейки упала/устарела, а в episodeFinalV2 застрял pending/running — показываем ошибку.
  let final = episodeFinalV2From(project.episodeFinalV2, episode);
  if (final && (final.status === "pending" || final.status === "running") && assembleJob && assembleJob.status === "failed") {
    final = { ...final, status: "error", error: assembleJob.message ?? final.error };
  }

  return NextResponse.json({
    scenes,
    refs: refs.map((r) => ({ id: r.id, label: r.label, kind: r.kind, imageUrl: r.imageUrl })),
    storyboardUrl: storyboard?.imageUrl ?? null,
    approved: !!storyboard?.approved,
    framesJob,
    videoJob,
    assembleJob,
    final,
    allVideosReady: allSceneVideosReady(rawScenes),
  }, { headers: { "Cache-Control": "no-store" } });
}
