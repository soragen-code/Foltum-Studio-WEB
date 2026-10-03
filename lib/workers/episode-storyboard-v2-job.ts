/**
 * Фоновый воркер потока v2 (вкладка «Сториборд»): собирает ОДИН сводный лист-сториборд по всему шот-листу серии.
 * Берёт весь шот-лист серии (Project.episodeShotsV2["<n>"]), строит единый промпт (buildStoryboardV2Prompt),
 * добавляет строку [VISUAL STYLE] и шлёт в GPT Image 2.5 flare (WAVESPEED_GPT_IMAGE_25_FLARE_T2I, 4k, 9:16).
 * Результат — одно изображение: грузится в S3 и сохраняется в Project.episodeStoryboardV2["<n>"].imageUrl.
 */
import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError, WAVESPEED_GPT_IMAGE_25_FLARE_T2I } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { completeJob, failJob, isCancelRequested, markCanceled, updateJob } from "@/lib/jobs";
import { REFERENCE_ASPECT_RATIO } from "@/lib/visual-style";
import { runWithPromptContext } from "@/lib/prompt-log";
import { episodeShotsV2From, episodeStoryboardV2From } from "@/lib/idea-v2";
import { ensureStoryboardV2AutoPrompt } from "@/lib/storyboard-v2-prompt";
import { setEpisodeStoryboardV2 } from "@/lib/episode-storyboard-v2-store";
import { translateToEnglish } from "@/lib/translate-en";

export const EPISODE_STORYBOARD_V2_JOB_TYPE = "episode_storyboard_v2";
export const EPISODE_STORYBOARD_V2_EXPECTED_SEC = 90;

export interface EpisodeStoryboardV2JobParams { episode: number }

async function runImpl(jobId: string, projectId: string, { episode }: EpisodeStoryboardV2JobParams): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  const CANCEL_MSG = "Generation canceled by the user";
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeShotsV2: true, episodeRefsV2: true, episodeStoryboardV2: true } });
    const shots = episodeShotsV2From(row?.episodeShotsV2, episode);
    if (!shots.length) { await failJob(jobId, "No shots to build a storyboard from"); return; }

    // Авто-промпт с кэшем (общий хелпер с кнопкой «Промпт»): уже построен и актуален → без повторного перевода.
    // Референсы серии (персонажи → локации → реквизит) с картинками подаются как image_input в том же порядке,
    // что и блок «References: Image N - …» промпта; промпт явно требует СКОМПОНОВАТЬ новый лист, а не править реф.
    const built = await ensureStoryboardV2AutoPrompt(projectId, episode, row!);
    const refs = built.inputs.refs;
    const imageInput = refs.map((r) => r.imageUrl!).filter(Boolean);
    const autoPrompt = built.autoPrompt;
    const override = episodeStoryboardV2From(row?.episodeStoryboardV2, episode)?.promptOverride;
    const overrideEn = typeof override === "string" && override.trim() ? (await translateToEnglish(override)) || override : "";
    const prompt = overrideEn || autoPrompt;
    await setEpisodeStoryboardV2(projectId, episode, { status: "generating", error: null, prompt, approved: false });
    await updateJob(jobId, { status: "processing", progress: 10, message: `Building a storyboard sheet from ${shots.length} shot(s)${imageInput.length ? ` with ${imageInput.length} reference(s)` : ""}...` });

    if (await canceled()) { await markCanceled(jobId, CANCEL_MSG); await setEpisodeStoryboardV2(projectId, episode, { status: null }); return; }

    const remote = await generateImage(
      { prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, modelSlug: WAVESPEED_GPT_IMAGE_25_FLARE_T2I, resolution: "4k", ...(imageInput.length ? { image_input: imageInput } : {}) },
      { jobId, shouldCancel: canceled, timeoutMs: 600_000 },
    );
    if (await canceled()) { await markCanceled(jobId, CANCEL_MSG); await setEpisodeStoryboardV2(projectId, episode, { status: null }); return; }

    await updateJob(jobId, { progress: 85, message: "Uploading storyboard..." });
    const url = await uploadRemoteToS3(remote, `media/public/v2-storyboard/${projectId}/${episode}/${Date.now()}.png`, "image/png");
    await setEpisodeStoryboardV2(projectId, episode, { imageUrl: url, status: "done", error: null });
    await completeJob(jobId, { episode }, "Storyboard ready");
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) {
      await markCanceled(jobId, CANCEL_MSG);
      await setEpisodeStoryboardV2(projectId, episode, { status: null });
      return;
    }
    console.error("[episode-storyboard-v2] failed:", err);
    const msg = String(err?.message ?? err).slice(0, 300);
    await setEpisodeStoryboardV2(projectId, episode, { status: "failed", error: msg });
    await failJob(jobId, err?.message ?? "Storyboard generation failed");
  }
}

export function runEpisodeStoryboardV2Job(jobId: string, projectId: string, params: EpisodeStoryboardV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_storyboard_v2", projectId }, () => runImpl(jobId, projectId, params));
}
