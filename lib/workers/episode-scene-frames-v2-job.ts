/**
 * Фоновый воркер потока v2 (вкладка «Сцены»): по аппруву сториборда «нарезает» первые кадры сцен.
 * Геометрический кроп листа ненадёжен, поэтому каждый кадр ГЕНЕРИРУЕТСЯ отдельно как standalone 9:16
 * (GPT Image 2.5 flare, image-to-image): image_input = [лист-сториборд, ...референсы серии], промпт —
 * buildSceneFrameV2Prompt (или promptOverride сцены). По сцене на кадр шот-листа; frame/action/ending шота переводятся на EN
 * по отдельности (в промпт видео уходят только action + ending), референсы персонажей/реквизита назначаются per-scene.
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
  buildSceneFrameV2Prompt, episodeRefsV2From, episodeScenesV2From, episodeShotsV2From, episodeStoryboardV2From, matchSceneRefsByText, selectStoryboardV2Refs, shotFrameText,
  type EpisodeRefV2, type EpisodeSceneV2, type EpisodeShotV2,
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

/**
 * Какие референсы (персонажи/реквизит серии) присутствуют в каждом шоте: одна LLM-выборка по тексту шотов.
 * Возвращает массив id-списков в порядке шотов. При ошибке LLM — детерминированный разбор по тексту (matchSceneRefsByText).
 */
async function assignSceneRefs(shots: EpisodeShotV2[], refs: EpisodeRefV2[]): Promise<string[][]> {
  const pool = refs.filter((r) => r && (r.kind === "character" || r.kind === "prop"));
  const fallback = () => shots.map((s) => matchSceneRefsByText(s, pool));
  if (!shots.length || !pool.length) return shots.map(() => []);
  try {
    const system =
      "You map shots of a shot list to the reference assets (characters and props) that are VISIBLE in each shot. " +
      "Return strict JSON only. Use ONLY ids from the provided list. A character counts as present if they are visible in the frame, the action or the ending of that shot " +
      "(including a body part, a reflection or a silhouette). A prop counts as present only if it is visibly in the shot. Do not include locations.";
    const user =
      `References:\n` + pool.map((r) => `${r.id} | ${r.kind} | ${r.label.replace(/\s+/g, " ").trim()}`).join("\n") +
      `\n\nShots (${shots.length}):\n` +
      shots.map((s) => `#${s.index}\nFrame: ${shotFrameText(s)}\nAction: ${String(s.action ?? "").replace(/\s+/g, " ").trim()}\nEnding: ${String(s.ending ?? "").replace(/\s+/g, " ").trim()}`).join("\n\n") +
      `\n\nReturn JSON: {"shots":[{"index":<shot number>,"refIds":["<id>",...]}]} with EXACTLY ${shots.length} entries, one per shot, same order.`;
    const res = await chatJSON<{ shots?: Array<{ index?: number; refIds?: unknown }> }>(system, user, { maxTokens: 4000, temperature: 0.1 });
    const arr = Array.isArray(res?.shots) ? res.shots : [];
    if (arr.length !== shots.length) return fallback();
    const valid = new Set(pool.map((r) => r.id));
    const fb = fallback();
    return shots.map((s, i) => {
      const byIndex = arr.find((x) => Number(x?.index) === s.index) ?? arr[i];
      const ids = Array.isArray(byIndex?.refIds) ? (byIndex!.refIds as unknown[]).filter((x): x is string => typeof x === "string" && valid.has(x)) : [];
      // Детерминированные совпадения по имени добавляем всегда — модель иногда пропускает названного персонажа.
      return Array.from(new Set([...ids, ...fb[i]]));
    });
  } catch (e: any) {
    console.error("[episode-scene-frames-v2] assignSceneRefs failed:", String(e?.message ?? e).slice(0, 200));
    return fallback();
  }
}

/** Поля сцены, зависящие от шота и референсов: action/frame/endFrame (EN) + refIds. Порядок = порядок shots. */
export interface ScenePromptData { action: string; frame?: string; endFrame?: string; refIds: string[] }

/**
 * Готовит промпт-данные сцен по шот-листу: три блока шота переводятся раздельно (frame → только первый кадр;
 * action → ACTIONS; ending → END отдельным абзацем), персонажи/реквизит назначаются per-shot.
 * Используется при нарезке и при «Пересобрать промпты» (без перегенерации кадров/видео).
 */
export async function prepareScenePromptData(shots: EpisodeShotV2[], allRefs: EpisodeRefV2[]): Promise<ScenePromptData[]> {
  const [framesEn, actionsEn, endingsEn, refIdsPerShot] = await Promise.all([
    Promise.all(shots.map((s) => translateToEnglish(shotFrameText(s)))),
    Promise.all(shots.map((s) => translateToEnglish(s.action))),
    Promise.all(shots.map((s) => translateToEnglish(s.ending ?? ""))),
    assignSceneRefs(shots, allRefs),
  ]);
  // Шоты без ending (старый шот-лист) — финальный кадр описывает LLM по action.
  const described = endingsEn.some((e) => !e.trim()) ? await describeEndFrames(actionsEn.map((a, i) => a || shots[i].action)) : [];
  return shots.map((s, i) => ({
    action: actionsEn[i] || s.action,
    frame: framesEn[i] || undefined,
    endFrame: endingsEn[i]?.trim() || described[i]?.trim() || undefined,
    refIds: refIdsPerShot[i],
  }));
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
      // Переаппрув/обновление сториборда ПОЛНОСТЬЮ пересоздаёт сцены (первые кадры, видео, финальные кадры
      // нарезаются заново). Ручные промпты прежних сцен сохраняются, если сцена соответствует тому же шоту.
      const prev = new Map(episodeScenesV2From(row?.episodeScenesV2, episode).map((s) => [s.id, s]));
      // Три блока шота переводятся раздельно: frame → только первый кадр; action → ACTIONS; ending → END (отдельный абзац).
      const prepared = await prepareScenePromptData(shots, episodeRefsV2From(row?.episodeRefsV2, episode));
      scenes = shots.map((s, i) => {
        const id = `scene-${s.index}`;
        const p = prev.get(id);
        return {
          id, index: s.index, shotId: s.id, ...prepared[i], durationSec: s.durationSec,
          firstFrameStatus: "pending", videoStatus: "idle",
          promptOverride: p && p.shotId === s.id ? p.promptOverride ?? null : null,
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
        // Первый кадр генерится ТОЛЬКО по авто-промпту кадра. Ручной промпт сцены (promptOverride) —
        // это T2V-промпт видео и в генерацию кадра НЕ подмешивается.
        const prompt = buildSceneFrameV2Prompt(sc, refs, VISUAL_STYLE);
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
