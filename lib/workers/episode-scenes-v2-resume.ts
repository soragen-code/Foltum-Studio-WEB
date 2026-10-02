/**
 * v2 «Сцены»: серверный переподхват job без открытой вкладки (вызывается cron /api/cron/advance-chains).
 *
 * Воркеры кадров/видео/склейки запускаются в after() POST-инвокации (maxDuration 800с). Если инвокацию убили
 * или воркер сам уступил по бюджету времени, job остаётся processing и перестаёт обновляться. Здесь каждая
 * такая «замолчавшая» job (updatedAt старше RESUME_QUIET_MS; живой воркер heartbeat'ит каждые ≤30с)
 * перезапускается в фоне — воркеры идемпотентны и продолжают с pending/running сцен. После MAX_RESUMES
 * возобновлений или MAX_AGE_MS возраста job завершается ошибкой, а зависшие сцены помечаются error.
 */
import { prisma } from "@/lib/db";
import { failJob, heartbeatJob, isCancelRequested, markCanceled, runInBackground, updateJob } from "@/lib/jobs";
import { episodeOfJob, patchEpisodeSceneV2, setEpisodeFinalV2 } from "@/lib/episode-scenes-v2-store";
import { episodeScenesV2From, episodeFinalV2From } from "@/lib/idea-v2";
import { runEpisodeSceneFramesV2Job, EPISODE_SCENE_FRAMES_V2_JOB_TYPE } from "@/lib/workers/episode-scene-frames-v2-job";
import { runEpisodeSceneVideoV2Job, EPISODE_SCENE_VIDEO_V2_JOB_TYPE } from "@/lib/workers/episode-scene-video-v2-job";
import { runEpisodeAssembleV2Job, EPISODE_ASSEMBLE_V2_JOB_TYPE } from "@/lib/workers/episode-assemble-v2-job";
import { patchV2JobMeta } from "@/lib/workers/v2-job-budget";

export const RESUME_QUIET_MS = 90_000;
export const MAX_RESUMES = 12;
export const MAX_AGE_MS = 4 * 60 * 60 * 1000;

const TYPES = [EPISODE_SCENE_FRAMES_V2_JOB_TYPE, EPISODE_SCENE_VIDEO_V2_JOB_TYPE, EPISODE_ASSEMBLE_V2_JOB_TYPE];

/** Перевести «зависшие» (pending/running) сцены job в терминальный статус. */
async function settleScenes(projectId: string, episode: number, type: string, to: "error" | "idle", msg: string) {
  if (type === EPISODE_ASSEMBLE_V2_JOB_TYPE) {
    await setEpisodeFinalV2(projectId, episode, to === "error" ? { status: "error", error: msg } : { status: "idle", error: "" });
    return;
  }
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true } });
  for (const s of episodeScenesV2From(row?.episodeScenesV2, episode)) {
    if (type === EPISODE_SCENE_FRAMES_V2_JOB_TYPE && (s.firstFrameStatus === "pending" || s.firstFrameStatus === "running")) {
      await patchEpisodeSceneV2(projectId, episode, s.id, to === "error" ? { firstFrameStatus: "error", firstFrameError: msg } : { firstFrameStatus: "idle" });
    }
    if (type === EPISODE_SCENE_VIDEO_V2_JOB_TYPE && (s.videoStatus === "pending" || s.videoStatus === "running")) {
      await patchEpisodeSceneV2(projectId, episode, s.id, to === "error"
        ? { videoStatus: "error", videoError: msg, videoTaskId: "" }
        : { videoStatus: s.videoUrl ? "done" : "idle", videoTaskId: "" });
    }
  }
}

/** Есть ли ещё незавершённая работа у серии (pending/running). Для failed-job — признак, что её стоит переподхватить. */
async function hasIncompleteWork(projectId: string, episode: number, type: string): Promise<boolean> {
  if (type === EPISODE_ASSEMBLE_V2_JOB_TYPE) {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeFinalV2: true } });
    const f = episodeFinalV2From(row?.episodeFinalV2, episode);
    return f?.status === "pending" || f?.status === "running";
  }
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true } });
  const scenes = episodeScenesV2From(row?.episodeScenesV2, episode);
  if (type === EPISODE_SCENE_FRAMES_V2_JOB_TYPE) {
    return scenes.some((s) => s.firstFrameStatus === "pending" || s.firstFrameStatus === "running");
  }
  return scenes.some((s) => s.videoStatus === "pending" || s.videoStatus === "running");
}

export async function resumeEpisodeScenesV2Jobs(): Promise<{ resumed: number; gaveUp: number; canceled: number }> {
  const out = { resumed: 0, gaveUp: 0, canceled: 0 };
  // Берём и "failed" job: под старым кодом (или при временной ошибке воркера) scene-job мог попасть в failed,
  // оставив сцены pending/running осиротевшими — cron их переподхватывает, если работа ещё не завершена и
  // лимиты resumes/age не исчерпаны. Терминально сдавшиеся job помечают сцены error → hasIncompleteWork=false.
  const jobs = await prisma.generationJob.findMany({
    where: { type: { in: TYPES }, status: { in: ["pending", "processing", "failed"] }, updatedAt: { lt: new Date(Date.now() - RESUME_QUIET_MS) } },
    orderBy: { createdAt: "asc" },
    take: 30,
  });
  for (const job of jobs) {
    try {
      const projectId = job.projectId;
      const episode = episodeOfJob(job);
      if (!projectId || episode === null) { await failJob(job.id, "Invalid job payload"); continue; }
      // failed-job переподхватываем только если осталась незавершённая работа (иначе это терминальный провал/готово).
      if (job.status === "failed" && !(await hasIncompleteWork(projectId, episode, job.type))) continue;
      if (await isCancelRequested(job.id)) {
        await settleScenes(projectId, episode, job.type, "idle", "");
        await markCanceled(job.id);
        out.canceled++;
        continue;
      }
      let resumes = 0;
      try { resumes = Number(JSON.parse(job.resultData ?? "{}")?.resumes) || 0; } catch { resumes = 0; }
      if (resumes >= MAX_RESUMES || Date.now() - job.createdAt.getTime() > MAX_AGE_MS) {
        const msg = "Generation interrupted (worker stopped responding)";
        await settleScenes(projectId, episode, job.type, "error", msg);
        await failJob(job.id, msg);
        out.gaveUp++;
        continue;
      }
      // Аренда (lease): отметка + heartbeat до запуска, чтобы следующий тик cron не стартовал второй воркер.
      await patchV2JobMeta(job.id, { episode, resumes: resumes + 1 });
      // Реанимируем failed-job в processing (сбрасываем старую ошибку), чтобы её статус отражал активную работу.
      if (job.status === "failed") await updateJob(job.id, { status: "processing", error: null });
      await heartbeatJob(job.id);
      const run =
        job.type === EPISODE_SCENE_FRAMES_V2_JOB_TYPE ? () => runEpisodeSceneFramesV2Job(job.id, projectId, { episode })
        : job.type === EPISODE_SCENE_VIDEO_V2_JOB_TYPE ? () => runEpisodeSceneVideoV2Job(job.id, projectId, { episode })
        : () => runEpisodeAssembleV2Job(job.id, projectId, { episode });
      runInBackground(run);
      out.resumed++;
    } catch (err) {
      console.error("[episode-scenes-v2-resume] resume failed:", err);
    }
  }
  return out;
}
