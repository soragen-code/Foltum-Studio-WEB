/**
 * Фоновый воркер потока v2 (вкладка «Референсы» → «Сгенерировать все референсы» / перегенерация одного):
 * картинки рефов серии N. Тот же image-пайплайн (generateImage → WaveSpeed, uploadRemoteToS3, 9:16, стиль VISUAL_STYLE),
 * но модель — GPT Image 2.5 flare (modelSlug = WAVESPEED_GPT_IMAGE_25_FLARE_T2I, quality medium) только здесь;
 * v1-воркеры остаются на дефолтном GPT Image 2.0. Отдельный v2-воркер: пишет только в Project.episodeRefsV2.
 * Каждый реф обновляется атомарно (patchEpisodeRefV2) — превью появляются по мере готовности.
 */
import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError, WAVESPEED_GPT_IMAGE_25_FLARE_T2I } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { VISUAL_STYLE, NEUTRAL_BACKGROUND_LINE, REFERENCE_ASPECT_RATIO, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { runWithPromptContext } from "@/lib/prompt-log";
import { episodeRefsV2From, type EpisodeRefV2 } from "@/lib/idea-v2";
import { patchEpisodeRefV2 } from "@/lib/episode-refs-v2-store";

export const EPISODE_REF_IMAGES_V2_JOB_TYPE = "episode_ref_images_v2";
export const EPISODE_REF_IMAGE_V2_EXPECTED_SEC = 40; // на один реф

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Инструкция удержания личности, когда к рефу персонажа прикреплено пользовательское фото (image_input). */
const FACE_REF_LINE =
  "IMPORTANT: a reference photo of a real person is provided. Preserve that person's facial identity and features (face shape, eyes, nose, mouth, skin tone, hair) so the character clearly looks like them; adapt only clothing, pose, and styling to match the description and visual style.";

/** Финальный промпт image-модели: стиль + кадрирование по типу рефа + (опц.) удержание лица + EN-промпт пользователя. */
export function episodeRefImagePromptV2(ref: Pick<EpisodeRefV2, "kind" | "prompt" | "setting" | "userRefUrl">): string {
  const framing =
    ref.kind === "character"
      ? `Character reference sheet image: ONE fictional adult (or child if stated) shown full-length head to toe, standing upright in a neutral pose, facing the camera. ${NEUTRAL_BACKGROUND_LINE}`
      : ref.kind === "location"
        ? `Location reference plate: wide establishing photograph of the place, ${ref.setting === "EXT" ? "exterior" : ref.setting === "INT" ? "interior" : "the setting"}, no people, no text.`
        : `Prop reference image: the single object isolated and fully in frame on a plain neutral-grey background, no hands, no people, no text.`;
  const faceLine = ref.kind === "character" && ref.userRefUrl?.trim() ? `\n${FACE_REF_LINE}` : "";
  return `[VISUAL STYLE]: ${VISUAL_STYLE}\n${framing}${faceLine}\n${ref.prompt.trim()}`;
}

export interface EpisodeRefImagesV2JobParams { episode: number; ids: string[] }

async function runImpl(jobId: string, projectId: string, { episode, ids }: EpisodeRefImagesV2JobParams): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  const CANCEL_MSG = "Generation canceled by the user";
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeRefsV2: true } });
    const refs = episodeRefsV2From(row?.episodeRefsV2, episode).filter((r) => ids.includes(r.id));
    const total = refs.length;
    if (!total) { await failJob(jobId, "No references to generate"); return; }
    for (const r of refs) await patchEpisodeRefV2(projectId, episode, r.id, { imageStatus: "generating", imageError: null });
    let done = 0;
    let failed = 0;
    const pct = () => 5 + Math.round((done / total) * 95);
    await updateJob(jobId, { status: "processing", progress: pct(), message: `Generating ${total} reference(s)…` });
    for (const r of refs) {
      if (await canceled()) {
        for (const x of refs.slice(done)) await patchEpisodeRefV2(projectId, episode, x.id, { imageStatus: x.imageUrl ? "done" : null });
        await markCanceled(jobId, `Canceled — done ${done} of ${total}`);
        return;
      }
      await updateJob(jobId, { progress: pct(), message: `${r.label} (${done + 1}/${total})…` });
      try {
        const faceRef = r.kind === "character" && r.userRefUrl?.trim() ? [r.userRefUrl.trim()] : undefined;
        const remote = await generateImage({ prompt: episodeRefImagePromptV2(r), aspect_ratio: REFERENCE_ASPECT_RATIO, modelSlug: WAVESPEED_GPT_IMAGE_25_FLARE_T2I, ...(faceRef ? { image_input: faceRef } : {}) }, { jobId, shouldCancel: canceled });
        if (await canceled()) throw new GenerationCanceledError();
        const url = await uploadRemoteToS3(remote, `media/public/v2-refs/${projectId}/${episode}/${VISUAL_STYLE_ID}/${r.id}-${Date.now()}.png`, "image/png");
        await patchEpisodeRefV2(projectId, episode, r.id, { imageUrl: url, imageStatus: "done", imageError: null, promptDirty: false });
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) {
          for (const x of refs.slice(done)) await patchEpisodeRefV2(projectId, episode, x.id, { imageStatus: x.imageUrl ? "done" : null });
          await markCanceled(jobId, CANCEL_MSG);
          return;
        }
        failed += 1;
        const msg = String(e?.message ?? e).slice(0, 300);
        console.error(`[episode-ref-images-v2] ${r.id} failed:`, msg);
        await patchEpisodeRefV2(projectId, episode, r.id, { imageStatus: "failed", imageError: msg });
      }
      done += 1;
      await updateJob(jobId, { progress: pct() });
      if (done < total) await sleep(1200);
    }
    await completeJob(jobId, { episode, total, failed }, failed ? `Done — ${failed} of ${total} failed` : "References are ready");
  } catch (err: any) {
    console.error("[episode-ref-images-v2] failed:", err);
    await failJob(jobId, err?.message ?? "Reference image generation failed");
  }
}

export function runEpisodeRefImagesV2Job(jobId: string, projectId: string, params: EpisodeRefImagesV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_ref_images_v2", projectId }, () => runImpl(jobId, projectId, params));
}
