/**
 * Фоновый воркер потока v2 (вкладка «Сцены», кнопка «Запустить все сцены»): fan-out видео по всем сценам
 * серии с готовым первым кадром. Каждая сцена — Seedance 2.5 text-to-video с референс-изображениями:
 * reference_images = [первый кадр сцены (лук-якорь композиции) + канонические референсы персонажей/локаций],
 * prompt = sceneVideoV2Prompt (REFERENCES: image 1 = первый кадр, image 2..N = персонажи и реквизит ЭТОЙ сцены; ACTIONS = action шота;
 * END = ending шота отдельным абзацем — без негативов),
 * duration = durationSec шота в [4,30]; результат грузится в S3. Первый кадр подаётся как референс, а не
 * как жёстко зафиксированный начальный кадр. Ошибка одной сцены не валит остальные. Если все видео готовы — перезапуск.
 * Возобновляемый: taskId Seedance хранится в сцене; при нехватке бюджета инвокации воркер уступает, а cron
 * (resumeEpisodeScenesV2Jobs) перезапускает его — уже запущенные задачи опрашиваются, а не стартуют заново.
 */
import { prisma } from "@/lib/db";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { completeJob, failJob, heartbeatJob, isCancelRequested, markCanceled, updateJob } from "@/lib/jobs";
import { runWithPromptContext } from "@/lib/prompt-log";
import {
  cancelVideoPrediction, getVideoPredictionState, startVideoPrediction, SEEDANCE_I2V_MAX_DURATION, SEEDANCE_I2V_MIN_DURATION,
} from "@/lib/wavespeed";
import { episodeRefsV2From, episodeScenesV2From, MAX_SCENE_VIDEO_REF_IMAGES, sceneVideoV2Prompt, selectSceneVideoV2Refs, type EpisodeSceneV2 } from "@/lib/idea-v2";
import { translateToEnglish } from "@/lib/translate-en";
import { patchEpisodeSceneV2 } from "@/lib/episode-scenes-v2-store";
import { runPool } from "@/lib/workers/episode-scene-frames-v2-job";
import { patchV2JobMeta, readV2JobMeta, v2Budget, V2BudgetYield } from "@/lib/workers/v2-job-budget";

export const EPISODE_SCENE_VIDEO_V2_JOB_TYPE = "episode_scene_video_v2";
export const EPISODE_SCENE_VIDEO_V2_EXPECTED_SEC = 300;
/** Все сцены серии генерируются ПАРАЛЛЕЛЬНО (одновременно), без пачек/очереди. */
const CONCURRENCY = Number.MAX_SAFE_INTEGER;
/** Макс. референс-изображений на сцену в T2V: первый кадр сцены + канонические референсы. */
const MAX_SCENE_REF_IMAGES = MAX_SCENE_VIDEO_REF_IMAGES;
const VIDEO_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_MS = 5000;

export interface EpisodeSceneVideoV2JobParams { episode: number }

class SceneCanceled extends Error {}

/** Опрос задачи Seedance до готовности. Таймаут считается от startedAt сцены (через возобновления). */
async function waitVideo(taskId: string, startedAt: number, canceled: () => Promise<boolean>, hard: () => boolean): Promise<string> {
  for (;;) {
    if (await canceled()) { await cancelVideoPrediction(taskId).catch(() => {}); throw new SceneCanceled(); }
    const st = await getVideoPredictionState(taskId);
    if (st.status === "succeeded") { if (st.url) return st.url; throw new Error("Seedance returned no output"); }
    if (st.status === "failed" || st.status === "canceled") throw new Error(st.error || `Seedance ${st.status}`);
    if (Date.now() - startedAt > VIDEO_TIMEOUT_MS) throw new Error("Seedance timed out");
    // Бюджет инвокации на исходе — задача на провайдере продолжает рендериться; её taskId уже в сцене.
    if (hard()) throw new V2BudgetYield();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function runImpl(jobId: string, projectId: string, { episode }: EpisodeSceneVideoV2JobParams): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  const budget = v2Budget();
  const hb = setInterval(() => void heartbeatJob(jobId), 20_000);
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true, episodeRefsV2: true } });
    const all = episodeScenesV2From(row?.episodeScenesV2, episode);
    // В видео сцены подаём ТОЛЬКО первый кадр + референсы персонажей и реквизита ЭТОЙ сцены (scene.refIds; без сториборда
    // и локаций). Один и тот же упорядоченный список даёт и картинки (image 2..N), и строки блока REFERENCES промпта.
    const allRefs = episodeRefsV2From(row?.episodeRefsV2, episode);
    const videoRefsFor = (sc: EpisodeSceneV2) => selectSceneVideoV2Refs(allRefs, MAX_SCENE_REF_IMAGES - 1, sc);

    // Выбор сцен — только при первом запуске job; возобновлённый cron'ом воркер берёт сохранённый список.
    let meta = await readV2JobMeta(jobId);
    if (!meta?.prepared) {
      const withFrame = all.filter((s) => s.firstFrameUrl);
      if (!withFrame.length) { await failJob(jobId, "No scenes with a first frame"); return; }
      const pending = withFrame.filter((s) => s.videoStatus !== "done");
      const chosen = pending.length ? pending : withFrame;
      for (const s of chosen) await patchEpisodeSceneV2(projectId, episode, s.id, { videoStatus: "pending", videoError: "", videoTaskId: "", videoStartedAt: "" });
      meta = await patchV2JobMeta(jobId, { episode, prepared: true, sceneIds: chosen.map((s) => s.id) });
      await updateJob(jobId, { status: "processing", progress: 5, message: `Generating ${chosen.length} scene video(s)...` });
    } else {
      await updateJob(jobId, { status: "processing", message: "Resuming scene videos..." });
    }
    const ids = new Set(meta.sceneIds ?? []);
    const fresh = episodeScenesV2From((await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true } }))?.episodeScenesV2, episode);
    const mine = fresh.filter((s) => ids.has(s.id));
    const todo = mine.filter((s) => s.videoStatus === "pending" || s.videoStatus === "running");

    const total = mine.length;
    let done = total - todo.length;
    let yielded = 0;
    await runPool(todo, CONCURRENCY, async (sc) => {
      if (await canceled()) {
        if (sc.videoTaskId) await cancelVideoPrediction(sc.videoTaskId).catch(() => {});
        await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: sc.videoUrl ? "done" : "idle" });
        return;
      }
      // Новую задачу не стартуем на исходе бюджета; уже запущенную (есть taskId) — продолжаем опрашивать.
      if (!sc.videoTaskId && budget.soft()) { yielded += 1; return; }
      try {
        let taskId = sc.videoTaskId;
        let startedAt = sc.videoStartedAt ? Date.parse(sc.videoStartedAt) : NaN;
        if (!taskId) {
          await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: "running" });
          const duration = Math.max(SEEDANCE_I2V_MIN_DURATION, Math.min(SEEDANCE_I2V_MAX_DURATION, Math.round(sc.durationSec ?? 5)));
          // Промпт видео — только English (action уже переведён при нарезке; ручной override мог быть по-русски).
          const videoRefs = videoRefsFor(sc);
          const videoPrompt = (await translateToEnglish(sceneVideoV2Prompt(sc, videoRefs))) || sceneVideoV2Prompt(sc, videoRefs);
          // T2V с референсами: первый кадр сцены (лук-якорь) + референсы персонажей/реквизита этой сцены, cap.
          const refUrls = videoRefs.map((r) => r.imageUrl).filter((u): u is string => typeof u === "string" && !!u);
          const reference_images = [sc.firstFrameUrl!, ...refUrls].filter(Boolean).slice(0, MAX_SCENE_REF_IMAGES);
          taskId = await startVideoPrediction({ prompt: videoPrompt, reference_images, aspect_ratio: "9:16", resolution: "720p", duration, generate_audio: true });
          startedAt = Date.now();
          // taskId сохраняется сразу: если инвокацию убьют, возобновлённый воркер опросит эту же задачу (без повторного рендера).
          await patchEpisodeSceneV2(projectId, episode, sc.id, { videoTaskId: taskId, videoStartedAt: new Date(startedAt).toISOString() });
        }
        const remote = await waitVideo(taskId, Number.isFinite(startedAt) ? startedAt : Date.now(), canceled, budget.hard);
        const url = await uploadRemoteToS3(remote, `media/public/v2-scenes/${projectId}/${episode}/${sc.id}-video-${Date.now()}.mp4`, "video/mp4");
        await patchEpisodeSceneV2(projectId, episode, sc.id, { videoUrl: url, videoStatus: "done", videoError: "", videoTaskId: "" });
      } catch (e: any) {
        if (e instanceof V2BudgetYield) { yielded += 1; return; }
        if (e instanceof SceneCanceled) { await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: sc.videoUrl ? "done" : "idle", videoTaskId: "" }); return; }
        const msg = String(e?.message ?? e).slice(0, 300);
        console.error(`[episode-scene-video-v2] ${sc.id} failed:`, msg);
        await patchEpisodeSceneV2(projectId, episode, sc.id, { videoStatus: "error", videoError: msg, videoTaskId: "" });
      }
      done += 1;
      await updateJob(jobId, { progress: 5 + Math.round((done / total) * 95), message: `Scene videos ${done}/${total}...` });
    });

    if (await canceled()) { await markCanceled(jobId, `Canceled — done ${done} of ${total}`); return; }
    if (yielded) {
      // job остаётся processing; cron /api/cron/advance-chains подхватит её, когда она замолчит.
      await updateJob(jobId, { message: `Scene videos ${done}/${total} — continuing in background...` });
      return;
    }
    const after = episodeScenesV2From((await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true } }))?.episodeScenesV2, episode);
    const failed = after.filter((s) => ids.has(s.id) && s.videoStatus === "error").length;
    await completeJob(jobId, { episode, prepared: true, sceneIds: [...ids], total, failed }, failed ? `Done — ${failed} of ${total} failed` : "Scene videos are ready");
  } catch (err: any) {
    console.error("[episode-scene-video-v2] failed:", err);
    await failJob(jobId, err?.message ?? "Scene video generation failed");
  } finally {
    clearInterval(hb);
  }
}

export function runEpisodeSceneVideoV2Job(jobId: string, projectId: string, params: EpisodeSceneVideoV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_scene_video_v2", projectId }, () => runImpl(jobId, projectId, params));
}
