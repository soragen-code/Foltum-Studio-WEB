/**
 * Stage 64 — STORYBOARD job: one Seedream 9:16 still per scene (the "frame" the author approves before
 * the video is generated from it). Data loading + prompt assembly go through the pure
 * lib/storyboard-prompt.ts (shared with the read-only «Промпт кадра» preview), the image goes through
 * generateImage (Seedream, polled every 2s, user cancel honoured) and is stored on S3; the scene row
 * receives storyboardUrl / storyboardPrompt / storyboardJobId with storyboardApproved reset to false.
 *
 * Credits (CHARACTER_REFERENCE_COST per frame) are charged by the calling route BEFORE the job starts and
 * refunded here on failure / cancel. The text-mode video path never touches this module.
 */
import { prisma } from "@/lib/db";
import { completeJob, failJob, heartbeatJob, isCancelRequested, markCanceled, updateJob } from "@/lib/jobs";
import { generateImage, GenerationCanceledError } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { downscaleReferences } from "@/lib/reference-downscale";
import { buildPropRegistry, parsePropRegistry } from "@/lib/prop-registry";
import { buildStoryboardPrompt, type BuildStoryboardPromptResult } from "@/lib/storyboard-prompt";

export const STORYBOARD_JOB_TYPE = "storyboard";

export interface StoryboardJobParams {
  jobId: string;
  sceneId: string;
  projectId: string;
  userId: string;
  /** Credits reserved by the route for this frame (refunded on failure/cancel). */
  cost: number;
  /** Optional per-poll hook (every ~2s while the image is rendering) — the sequential runner uses it to heartbeat queued jobs. */
  onTick?: () => Promise<void>;
}

export interface StoryboardInput {
  scene: {
    id: string; number: number; episodeId: string; videoPrompt: string | null; startState: string | null;
    presence: string | null; action: string | null; continuesFrom: string | null; dialogue: string | null;
    dialogueEn: string | null; voiceover: string | null; storyboardUrl: string | null; storyboardApproved: boolean;
  };
  episodeId: string;
  sceneMode: string;
  built: BuildStoryboardPromptResult;
}

/**
 * Load everything the storyboard prompt needs for one scene (scene row, linked characters, the episode
 * location, the previous scene's approved/rendered storyboard, the cached episode prop registry) and
 * build the prompt. Used by the worker AND by the GET preview so both always show the same text.
 * `persistRegistry` — the worker stores a freshly extracted registry; the preview never writes.
 */
export async function loadStoryboardInput(sceneId: string, opts: { persistRegistry?: boolean } = {}): Promise<StoryboardInput> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) throw new Error("Сцена не найдена");
  if (!(scene.videoPrompt ?? "").trim()) throw new Error("У сцены ещё нет видео-промпта");

  const links = await prisma.sceneCharacter.findMany({ where: { sceneId }, include: { character: true } });
  const episode = await prisma.episode.findUnique({
    where: { id: scene.episodeId },
    select: {
      id: true, sceneMode: true, script: true, propRegistry: true,
      location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true } },
    },
  });
  if (!episode) throw new Error("Эпизод не найден");
  const previous = scene.number > 1
    ? await prisma.scene.findFirst({ where: { episodeId: scene.episodeId, number: scene.number - 1 }, select: { id: true, storyboardUrl: true } })
    : null;

  // Stage 54 registry: same source as the video path so the CLOTHING & PROPS text is identical.
  let props: { id: string; name: string; description: string }[] = [];
  try {
    const propBuild = await buildPropRegistry(episode.script ?? "", parsePropRegistry(episode.propRegistry));
    if (propBuild.warning) console.warn(`[storyboard-job] ${sceneId}: ${propBuild.warning}`);
    props = propBuild.registry.props;
    if (!propBuild.fromCache && opts.persistRegistry) {
      await prisma.episode.update({ where: { id: episode.id }, data: { propRegistry: JSON.stringify(propBuild.registry) } }).catch(() => {});
    }
  } catch (e) {
    console.warn(`[storyboard-job] ${sceneId}: prop registry unavailable:`, e instanceof Error ? e.message : e);
  }

  const built = buildStoryboardPrompt({
    scene: {
      id: scene.id, number: scene.number, videoPrompt: scene.videoPrompt, startState: scene.startState,
      presence: scene.presence, action: scene.action, continuesFrom: scene.continuesFrom,
      dialogue: scene.dialogue, dialogueEn: scene.dialogueEn, voiceover: scene.voiceover,
    },
    characters: links.map(l => ({
      characterId: l.characterId, name: l.character.name, tier: l.character.tier, imageFront: l.character.imageFront,
      imageProfile: l.character.imageProfile, imageFull: l.character.imageFull, imageExtra: l.character.imageExtra,
      appearance: l.character.appearance, age: l.character.age,
    })),
    location: episode.location ?? null,
    previous,
    props,
  });

  return {
    scene: {
      id: scene.id, number: scene.number, episodeId: scene.episodeId, videoPrompt: scene.videoPrompt, startState: scene.startState,
      presence: scene.presence, action: scene.action, continuesFrom: scene.continuesFrom, dialogue: scene.dialogue,
      dialogueEn: scene.dialogueEn, voiceover: scene.voiceover, storyboardUrl: scene.storyboardUrl, storyboardApproved: scene.storyboardApproved,
    },
    episodeId: episode.id,
    sceneMode: episode.sceneMode,
    built,
  };
}

async function refund(userId: string, cost: number, description: string): Promise<void> {
  if (!userId || cost <= 0) return;
  try {
    await prisma.user.update({ where: { id: userId }, data: { credits: { increment: cost } } });
    await prisma.creditTransaction.create({ data: { userId, amount: cost, description } });
  } catch (e) {
    console.error("[storyboard-job] refund failed:", e);
  }
}

/** Human-readable (Russian) failure text; provider messages are kept short. */
function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/timed out/i.test(msg)) return "Модель не успела сгенерировать кадр (тайм-аут). Попробуйте ещё раз.";
  if (/sensitive|nsfw|flagged|moderation/i.test(msg)) return "Кадр отклонён модерацией модели. Смягчите описание сцены и повторите.";
  if (/Failed to fetch remote/i.test(msg)) return "Не удалось сохранить готовый кадр. Попробуйте ещё раз.";
  return msg ? `Не удалось сгенерировать кадр: ${msg.slice(0, 300)}` : "Не удалось сгенерировать кадр";
}

/** Run one storyboard job to completion (never throws — the job row ends completed / failed / canceled). */
export async function runStoryboardJob(params: StoryboardJobParams): Promise<"completed" | "failed" | "canceled"> {
  const { jobId, sceneId, projectId, userId } = params;
  const cost = Number(params.cost ?? 0);
  try {
    if (await isCancelRequested(jobId)) {
      await refund(userId, cost, `Refund: storyboard frame canceled (${jobId})`);
      await markCanceled(jobId);
      return "canceled";
    }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Подготовка референсов кадра…" });
    const input = await loadStoryboardInput(sceneId, { persistRegistry: true });
    const { built } = input;

    await updateJob(jobId, { progress: 20, message: "Сжатие референсов…" });
    const imageInput = built.referenceImages.length ? await downscaleReferences(built.referenceImages, projectId) : undefined;

    await updateJob(jobId, { progress: 30, message: "Генерация кадра сториборда…" });
    const shouldCancel = async () => {
      await heartbeatJob(jobId);
      if (params.onTick) await params.onTick().catch(() => {});
      return isCancelRequested(jobId);
    };
    const remote = await generateImage(
      { prompt: built.prompt, aspect_ratio: "9:16", ...(imageInput && imageInput.length ? { image_input: imageInput } : {}) },
      { jobId, shouldCancel },
    );

    await updateJob(jobId, { progress: 85, message: "Загрузка кадра…" });
    const storyboardUrl = await uploadRemoteToS3(remote, `public/storyboards/${projectId}/${sceneId}-${jobId}.jpg`, "image/jpeg");

    // A fresh frame is never pre-approved — the author must look at it first.
    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: { storyboardUrl, storyboardApproved: false, storyboardPrompt: built.prompt, storyboardJobId: jobId },
    });
    await completeJob(jobId, { scene, storyboardUrl, prompt: built.prompt, refs: built.refs.map(r => ({ kind: r.kind, id: r.id })) }, "Кадр готов");
    return "completed";
  } catch (e) {
    if (e instanceof GenerationCanceledError) {
      await refund(userId, cost, `Refund: storyboard frame canceled (${jobId})`);
      await markCanceled(jobId);
      return "canceled";
    }
    const message = readableError(e);
    console.error(`[storyboard-job] ${sceneId} failed:`, e instanceof Error ? e.message : e);
    await failJob(jobId, message);
    await refund(userId, cost, `Refund: storyboard frame failed (${jobId})`);
    return "failed";
  }
}
