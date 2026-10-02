/**
 * Фоновый воркер потока v2 (вкладка «Сцены»): по аппруву сториборда «нарезает» первые кадры сцен.
 * Геометрический кроп листа ненадёжен, поэтому каждый кадр ГЕНЕРИРУЕТСЯ отдельно как standalone 9:16
 * (GPT Image 2.5 flare, image-to-image): image_input = [лист-сториборд, ...референсы серии], промпт —
 * buildSceneFrameV2Prompt (или promptOverride сцены). По сцене на кадр шот-листа; action переводится на EN.
 * Ошибка одной сцены не валит остальные. Возобновляемый: при нехватке бюджета инвокации уступает, оставляя
 * сцены в pending, — cron (resumeEpisodeScenesV2Jobs) перезапускает воркер, и он продолжает без повторной подготовки.
 */
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { generateImage, GenerationCanceledError, WAVESPEED_GPT_IMAGE_25_FLARE_T2I, WAVESPEED_IMAGE_MAX_REFS } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { completeJob, failJob, heartbeatJob, isCancelRequested, markCanceled, updateJob } from "@/lib/jobs";
import { REFERENCE_ASPECT_RATIO, VISUAL_STYLE } from "@/lib/visual-style";
import { runWithPromptContext } from "@/lib/prompt-log";
import { translateRefLabelsToEnglish, translateToEnglish } from "@/lib/translate-en";
import {
  buildSceneFrameV2Prompt, episodeRefsV2From, episodeScenesV2From, episodeShotsV2From, episodeStoryboardV2From, selectStoryboardV2Refs,
  type EpisodeSceneV2,
} from "@/lib/idea-v2";
import { patchEpisodeSceneV2, setEpisodeScenesV2 } from "@/lib/episode-scenes-v2-store";
import { patchV2JobMeta, readV2JobMeta, v2Budget } from "@/lib/workers/v2-job-budget";

export const EPISODE_SCENE_FRAMES_V2_JOB_TYPE = "episode_scene_frames_v2";
export const EPISODE_SCENE_FRAMES_V2_EXPECTED_SEC = 120;
const CONCURRENCY = 4;

export interface EpisodeSceneFramesV2JobParams { episode: number }

/**
 * Для каждого action-описания кадра генерирует ОДНО English-предложение финального кадра сцены —
 * к чему приходит движение в последний момент (поза/позиция/выражение/композиция). Порядок сохраняется.
 * При ошибке LLM возвращает массив пустых строк (endFrame опционален).
 */
async function describeEndFrames(actions: string[]): Promise<string[]> {
  if (!actions.length) return [];
  try {
    const system =
      "You are a cinematographer. For each shot action, write ONE concise English sentence describing the FINAL FRAME — " +
      "the exact visual state the shot resolves to at its last moment (final pose, position, expression, composition). " +
      "Present tense, visual only, no camera jargon. Return strict JSON.";
    const user =
      `Shot actions (${actions.length}), in order:\n` +
      actions.map((a, i) => `${i + 1}. ${a}`).join("\n") +
      `\n\nReturn JSON: {"endFrames": [...]} with EXACTLY ${actions.length} strings, one per action, in the same order.`;
    const res = await chatJSON<{ endFrames?: string[] }>(system, user, { maxTokens: 1500, temperature: 0.7 });
    const arr = Array.isArray(res?.endFrames) ? res.endFrames : [];
    return actions.map((_, i) => (typeof arr[i] === "string" ? arr[i].trim() : ""));
  } catch (e: any) {
    console.error("[episode-scene-frames-v2] describeEndFrames failed:", String(e?.message ?? e).slice(0, 200));
    return actions.map(() => "");
  }
}

/** Простой пул: не более limit задач одновременно. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function runImpl(jobId: string, projectId: string, { episode }: EpisodeSceneFramesV2JobParams): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  const budget = v2Budget();
  const hb = setInterval(() => void heartbeatJob(jobId), 30_000);
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeShotsV2: true, episodeRefsV2: true, episodeStoryboardV2: true, episodeScenesV2: true } });
    const shots = episodeShotsV2From(row?.episodeShotsV2, episode);
    const sheet = episodeStoryboardV2From(row?.episodeStoryboardV2, episode)?.imageUrl;
    if (!shots.length) { await failJob(jobId, "No shots to cut scenes from"); return; }
    if (!sheet) { await failJob(jobId, "No storyboard sheet"); return; }

    // Подготовка (список сцен + EN-перевод + финальные кадры) — только при первом запуске job.
    // Возобновлённый cron'ом воркер её пропускает и продолжает со сцен в pending/running.
    const meta = await readV2JobMeta(jobId);
    let scenes: EpisodeSceneV2[];
    if (!meta?.prepared) {
      await updateJob(jobId, { status: "processing", progress: 5, message: `Preparing ${shots.length} scene(s)...` });
      // Обновление/переаппрув сториборда НЕ сбрасывает уже готовые сцены: для сцены того же шота сохраняем
      // первый кадр, видео, финальный кадр, ручной промпт и их статусы. Перенарезаем только недостающие кадры.
      const prev = new Map(episodeScenesV2From(row?.episodeScenesV2, episode).map((s) => [s.id, s]));
      const actionsEn = await Promise.all(shots.map((s) => translateToEnglish(s.action)));
      // Финальный кадр генерим LLM только когда у соответствующей сцены его ещё нет (экономим вызовы + сохраняем прежние).
      const needEnd = shots.some((s) => { const p = prev.get(`scene-${s.index}`); return !(p && p.shotId === s.id && p.endFrame); });
      const endFramesEn = needEnd ? await describeEndFrames(actionsEn) : shots.map(() => "");
      scenes = shots.map((s, i) => {
        const id = `scene-${s.index}`;
        const p = prev.get(id);
        if (p && p.shotId === s.id) {
          // Сцена того же шота уже есть — переносим её целиком (первый кадр, видео, статусы, taskId).
          return {
            ...p,
            index: s.index, shotId: s.id, action: actionsEn[i] || s.action, durationSec: s.durationSec,
            endFrame: p.endFrame ?? (endFramesEn[i] || undefined),
            promptOverride: p.promptOverride ?? null,
            // Готовый кадр сохраняем; незавершённый (idle/running/error/нет) — ставим в очередь на нарезку.
            firstFrameStatus: p.firstFrameStatus === "done" ? "done" : "pending",
          };
        }
        return {
          id, index: s.index, shotId: s.id, action: actionsEn[i] || s.action, endFrame: endFramesEn[i] || undefined, durationSec: s.durationSec,
          firstFrameStatus: "pending", videoStatus: "idle",
          promptOverride: null,
        };
      });
      await setEpisodeScenesV2(projectId, episode, scenes);
      await patchV2JobMeta(jobId, { episode, prepared: true });
    } else {
      scenes = episodeScenesV2From(row?.episodeScenesV2, episode);
      await updateJob(jobId, { status: "processing", message: "Resuming first frames..." });
    }
    const todo = scenes.filter((s) => s.firstFrameStatus === "pending" || s.firstFrameStatus === "running");

    // Лист-сториборд + референсы ≤ лимита image_input провайдера. Метки референсов переводятся на English
    // (в промпт — только English), image_input берётся по тем же imageUrl.
    const refs = await translateRefLabelsToEnglish(selectStoryboardV2Refs(episodeRefsV2From(row?.episodeRefsV2, episode), WAVESPEED_IMAGE_MAX_REFS - 1));
    const imageInput = [sheet, ...refs.map((r) => r.imageUrl!)];

    const total = scenes.length;
    let done = total - todo.length;
    let yielded = 0;
    await updateJob(jobId, { progress: 10 + Math.round((done / Math.max(1, total)) * 90), message: `Cutting ${todo.length} first frame(s)...` });
    await runPool(todo, CONCURRENCY, async (sc) => {
      if (await canceled()) { await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "idle" }); return; }
      // Бюджет инвокации на исходе — сцену оставляем pending, её доделает возобновлённый воркер.
      if (budget.soft()) { yielded += 1; await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "pending" }); return; }
      await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "running" });
      try {
        const prompt = sc.promptOverride?.trim()
          ? (await translateToEnglish(sc.promptOverride)) || sc.promptOverride
          : buildSceneFrameV2Prompt(sc, refs, VISUAL_STYLE);
        const remote = await generateImage(
          { prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, modelSlug: WAVESPEED_GPT_IMAGE_25_FLARE_T2I, resolution: "4k", image_input: imageInput },
          // shouldCancel срабатывает и по жёсткому бюджету — тогда это «уступить», а не отмена пользователем.
          { jobId, shouldCancel: async () => budget.hard() || (await canceled()), timeoutMs: 600_000 },
        );
        const url = await uploadRemoteToS3(remote, `media/public/v2-scenes/${projectId}/${episode}/${sc.id}-${Date.now()}.png`, "image/png");
        await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameUrl: url, firstFrameStatus: "done", firstFrameError: "" });
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) {
          if (await canceled()) { await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "idle" }); return; }
          yielded += 1;
          await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "pending" });
          return;
        }
        const msg = String(e?.message ?? e).slice(0, 300);
        console.error(`[episode-scene-frames-v2] ${sc.id} failed:`, msg);
        await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "error", firstFrameError: msg });
      }
      done += 1;
      await updateJob(jobId, { progress: 10 + Math.round((done / total) * 90), message: `First frames ${done}/${total}...` });
    });

    if (await canceled()) { await markCanceled(jobId, `Canceled — done ${done} of ${total}`); return; }
    if (yielded) {
      // job остаётся processing; cron /api/cron/advance-chains подхватит её, когда она замолчит.
      await updateJob(jobId, { message: `First frames ${done}/${total} — continuing in background...` });
      return;
    }
    const final = episodeScenesV2From((await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true } }))?.episodeScenesV2, episode);
    const failed = final.filter((s) => s.firstFrameStatus === "error").length;
    await completeJob(jobId, { episode, prepared: true, total, failed }, failed ? `Done — ${failed} of ${total} failed` : "First frames are ready");
  } catch (err: any) {
    console.error("[episode-scene-frames-v2] failed:", err);
    await failJob(jobId, err?.message ?? "First frame cutting failed");
  } finally {
    clearInterval(hb);
  }
}

export function runEpisodeSceneFramesV2Job(jobId: string, projectId: string, params: EpisodeSceneFramesV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_scene_frames_v2", projectId }, () => runImpl(jobId, projectId, params));
}
