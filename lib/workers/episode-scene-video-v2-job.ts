/**
 * Фоновый воркер потока v2 (вкладка «Сцены», кнопка «Запустить все сцены»): fan-out видео по всем сценам
 * серии с готовым первым кадром. Каждая сцена — Seedance 2.5 text-to-video с референс-изображениями:
 * reference_images = [первый кадр сцены (лук-якорь композиции) + канонические референсы персонажей/локаций],
 * prompt = sceneVideoV2Prompt (action + финальный кадр + заметка о консистентности по референсам),
 * duration = durationSec шота в [4,30]; результат грузится в S3. Первый кадр подаётся как референс, а не
 * как жёстко зафиксированный начальный кадр. Ошибка одной сцены не валит остальные. Если все видео готовы — перезапуск.
 */
import { prisma } from "@/lib/db";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { completeJob, failJob, heartbeatJob, isCancelRequested, markCanceled, updateJob } from "@/lib/jobs";
import { runWithPromptContext } from "@/lib/prompt-log";
import {
  cancelVideoPrediction, getVideoPredictionState, startVideoPrediction, SEEDANCE_I2V_MAX_DURATION, SEEDANCE_I2V_MIN_DURATION,
} from "@/lib/wavespeed";
import { episodeRefsV2From, episodeScenesV2From, sceneVideoV2Prompt, selectStoryboardV2Refs } from "@/lib/idea-v2";
import { translateToEnglish } from "@/lib/translate-en";
import { patchEpisodeSceneV2 } from "@/lib/episode-scenes-v2-store";
import { runPool } from "@/lib/workers/episode-scene-frames-v2-job";

export const EPISODE_SCENE_VIDEO_V2_JOB_TYPE = "episode_scene_video_v2";
export const EPISODE_SCENE_VIDEO_V2_EXPECTED_SEC = 300;
const CONCURRENCY = 4;
/** Макс. референс-изображений на сцену в T2V: первый кадр сцены + канонические референсы. */
const MAX_SCENE_REF_IMAGES = 4;
const VIDEO_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_MS = 5000;

export interface EpisodeSceneVideoV2JobParams { episode: number }

class SceneCanceled extends Error {}

/** Опрос задачи Seedance до готовности (с heartbeat задачи, чтобы её не сочли зависшей). */
async function waitVideo(taskId: string, jobId: string, canceled: () => Promise<boolean>): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (await canceled()) { await cancelVideoPrediction(taskId).catch(() => {}); throw new SceneCanceled(); }
    const st = await getVideoPredictionState(taskId);
    if (st.status === "succeeded") { if (st.url) return st.url; throw new Error("Seedance returned no output"); }
    if (st.status === "failed" || st.status === "canceled") throw new Error(st.error || `Seedance ${st.status}`);
    if (Date.now() - started > VIDEO_TIMEOUT_MS) throw new Error("Seedance timed out");
    await heartbeatJob(jobId);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function runImpl(jobId: string, projectId: string, { episode }: EpisodeSceneVideoV2JobParams): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true, episodeRefsV2: true } });
    const withFrame = episodeScenesV2From(row?.episodeScenesV2, episode).filter((s) => s.firstFrameUrl);
    if (!withFrame.length) { await failJob(jobId, "No scenes with a first frame"); return; }
    // Канонические референсы персонажей/локаций серии — общие для всех сцен (первый кадр добавляется per-scene).
    const refUrls = selectStoryboardV2Refs(episodeRefsV2From(row?.episodeRefsV2, episode), MAX_SCENE_REF_IMAGES - 1)
      .map((r) => r.imageUrl)
      .filter((u): u is string => typeof u === "string" && !!u);
    const pending = withFrame.filter((s) => s.videoStatus !== "done");
    const scenes = pending.length ? pending : withFrame;
    for (const s of scenes) await patchEpisodeSceneV2(projectId, episode, s.id, { videoStatus: "pending", videoError: "" });

    const total = scenes.length;
    let done = 0;
    let failed = 0;
    await updateJob(jobId, { status: "processing", progress: 5, message: `Generating ${total} scene video(s)...` });
    await runPool(scenes, CONCURRENCY, async (sc) => {
      if (await canceled()) { await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: sc.videoUrl ? "done" : "idle" }); return; }
      await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: "running" });
      try {
        const duration = Math.max(SEEDANCE_I2V_MIN_DURATION, Math.min(SEEDANCE_I2V_MAX_DURATION, Math.round(sc.durationSec ?? 5)));
        // Промпт видео — только English (action уже переведён при нарезке; ручной override мог быть по-русски).
        const videoPrompt = (await translateToEnglish(sceneVideoV2Prompt(sc))) || sceneVideoV2Prompt(sc);
        // T2V с референсами: первый кадр сцены (лук-якорь) + канонические референсы персонажей/локаций, cap.
        const reference_images = [sc.firstFrameUrl!, ...refUrls].filter(Boolean).slice(0, MAX_SCENE_REF_IMAGES);
        const taskId = await startVideoPrediction({ prompt: videoPrompt, reference_images, aspect_ratio: "9:16", resolution: "720p", duration, generate_audio: true });
        const remote = await waitVideo(taskId, jobId, canceled);
        const url = await uploadRemoteToS3(remote, `media/public/v2-scenes/${projectId}/${episode}/${sc.id}-video-${Date.now()}.mp4`, "video/mp4");
        await patchEpisodeSceneV2(projectId, episode, sc.id, { videoUrl: url, videoStatus: "done", videoError: "" });
      } catch (e: any) {
        if (e instanceof SceneCanceled) { await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: sc.videoUrl ? "done" : "idle" }); return; }
        failed += 1;
        const msg = String(e?.message ?? e).slice(0, 300);
        console.error(`[episode-scene-video-v2] ${sc.id} failed:`, msg);
        await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: "error", videoError: msg });
      }
      done += 1;
      await updateJob(jobId, { progress: 5 + Math.round((done / total) * 95), message: `Scene videos ${done}/${total}...` });
    });

    if (await canceled()) { await markCanceled(jobId, `Canceled — done ${done} of ${total}`); return; }
    await completeJob(jobId, { episode, total, failed }, failed ? `Done — ${failed} of ${total} failed` : "Scene videos are ready");
  } catch (err: any) {
    console.error("[episode-scene-video-v2] failed:", err);
    await failJob(jobId, err?.message ?? "Scene video generation failed");
  }
}

export function runEpisodeSceneVideoV2Job(jobId: string, projectId: string, params: EpisodeSceneVideoV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_scene_video_v2", projectId }, () => runImpl(jobId, projectId, params));
}
