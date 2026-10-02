/**
 * Фоновый воркер потока v2 (вкладка «Сцены»): по аппруву сториборда «нарезает» первые кадры сцен.
 * Геометрический кроп листа ненадёжен, поэтому каждый кадр ГЕНЕРИРУЕТСЯ отдельно как standalone 9:16
 * (GPT Image 2.5 flare, image-to-image): image_input = [лист-сториборд, ...референсы серии], промпт —
 * buildSceneFrameV2Prompt (или promptOverride сцены). По сцене на кадр шот-листа; action переводится на EN.
 * Ошибка одной сцены не валит остальные.
 */
import { prisma } from "@/lib/db";
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

export const EPISODE_SCENE_FRAMES_V2_JOB_TYPE = "episode_scene_frames_v2";
export const EPISODE_SCENE_FRAMES_V2_EXPECTED_SEC = 120;
const CONCURRENCY = 4;

export interface EpisodeSceneFramesV2JobParams { episode: number }

/** Простой пул: не более limit задач одновременно. */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function runImpl(jobId: string, projectId: string, { episode }: EpisodeSceneFramesV2JobParams): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  const hb = setInterval(() => void heartbeatJob(jobId), 30_000);
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeShotsV2: true, episodeRefsV2: true, episodeStoryboardV2: true, episodeScenesV2: true } });
    const shots = episodeShotsV2From(row?.episodeShotsV2, episode);
    const sheet = episodeStoryboardV2From(row?.episodeStoryboardV2, episode)?.imageUrl;
    if (!shots.length) { await failJob(jobId, "No shots to cut scenes from"); return; }
    if (!sheet) { await failJob(jobId, "No storyboard sheet"); return; }

    await updateJob(jobId, { status: "processing", progress: 5, message: `Preparing ${shots.length} scene(s)...` });
    // Ручные промпты прежних сцен сохраняются, если сцена соответствует тому же шоту.
    const prev = new Map(episodeScenesV2From(row?.episodeScenesV2, episode).map((s) => [s.id, s]));
    const actionsEn = await Promise.all(shots.map((s) => translateToEnglish(s.action)));
    const scenes: EpisodeSceneV2[] = shots.map((s, i) => {
      const id = `scene-${s.index}`;
      const p = prev.get(id);
      return {
        id, index: s.index, shotId: s.id, action: actionsEn[i] || s.action, durationSec: s.durationSec,
        firstFrameStatus: "pending", videoStatus: "idle",
        promptOverride: p && p.shotId === s.id ? p.promptOverride ?? null : null,
      };
    });
    await setEpisodeScenesV2(projectId, episode, scenes);

    // Лист-сториборд + референсы ≤ лимита image_input провайдера. Метки референсов переводятся на English
    // (в промпт — только English), image_input берётся по тем же imageUrl.
    const refs = await translateRefLabelsToEnglish(selectStoryboardV2Refs(episodeRefsV2From(row?.episodeRefsV2, episode), WAVESPEED_IMAGE_MAX_REFS - 1));
    const imageInput = [sheet, ...refs.map((r) => r.imageUrl!)];

    const total = scenes.length;
    let done = 0;
    let failed = 0;
    await updateJob(jobId, { progress: 10, message: `Cutting ${total} first frame(s)...` });
    await runPool(scenes, CONCURRENCY, async (sc) => {
      if (await canceled()) { await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "idle" }); return; }
      await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "running" });
      try {
        const prompt = sc.promptOverride?.trim()
          ? (await translateToEnglish(sc.promptOverride)) || sc.promptOverride
          : buildSceneFrameV2Prompt(sc, refs, VISUAL_STYLE);
        const remote = await generateImage(
          { prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, modelSlug: WAVESPEED_GPT_IMAGE_25_FLARE_T2I, resolution: "4k", image_input: imageInput },
          { jobId, shouldCancel: canceled, timeoutMs: 600_000 },
        );
        const url = await uploadRemoteToS3(remote, `media/public/v2-scenes/${projectId}/${episode}/${sc.id}-${Date.now()}.png`, "image/png");
        await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameUrl: url, firstFrameStatus: "done", firstFrameError: "" });
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) { await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "idle" }); return; }
        failed += 1;
        const msg = String(e?.message ?? e).slice(0, 300);
        console.error(`[episode-scene-frames-v2] ${sc.id} failed:`, msg);
        await patchEpisodeSceneV2(projectId, episode, sc.id, { firstFrameStatus: "error", firstFrameError: msg });
      }
      done += 1;
      await updateJob(jobId, { progress: 10 + Math.round((done / total) * 90), message: `First frames ${done}/${total}...` });
    });

    if (await canceled()) { await markCanceled(jobId, `Canceled — done ${done} of ${total}`); return; }
    await completeJob(jobId, { episode, total, failed }, failed ? `Done — ${failed} of ${total} failed` : "First frames are ready");
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
