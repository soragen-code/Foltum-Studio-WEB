/**
 * Simplified pipeline — step 9, START FRAME REDRAW.
 *
 * Re-renders the start frame of one or many beat scenes at full resolution with GPT Image 2.0 (9:16, 2K),
 * using the CURRENT start frame (the sliced grid panel) as the composition reference. References:
 *   image 1 = the location master plate (allowed on this step only — never in the video refs),
 *   image 2 = the scene's current start frame (grid panel as sliced),
 *   image 3..N = the scene cast (Character.imageFull || imageFront, appearance only).
 * When the episode has no plate the numbering shifts (panel = image 1). The result is normalised to a
 * 1080×1920 PNG and OVERWRITES Scene.startFrameUrl. The grid sheet / slicing logic is never touched.
 * Job type "start_frame_redraw"; resultData { episodeId, sceneIds, single? }.
 */
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled, heartbeatJob } from "@/lib/jobs";
import { runWithConcurrency } from "@/lib/reference-counts";
import { softenPromptForModeration, isModerationError } from "@/lib/moderation-soften";
import { parseBeatMeta, shotSizeLabel } from "@/lib/simple-pipeline";
import { resolveBeatCastLinks } from "@/lib/beat-cast";

export const REDRAW_START_FRAME_JOB_TYPE = "start_frame_redraw";

/** 2K GPT Image renders with up to 10 refs take minutes; 3 in flight keeps 25 scenes inside the route budget. */
const REDRAW_CONCURRENCY = 3;
const REDRAW_IMAGE_TIMEOUT_MS = 480_000;
const OUT_W = 1080;
const OUT_H = 1920;

const validUrl = (u?: string | null): u is string => typeof u === "string" && u.startsWith("http") && u.length > 10;

export function buildRedrawStartFramePrompt(input: {
  shot: string | null | undefined;
  action: string;
  hasPlate: boolean;
  characterNames: string[];
}): string {
  const panelIdx = input.hasPlate ? 2 : 1;
  const firstChar = panelIdx + 1;
  const lines: string[] = [];
  lines.push(
    "Full-frame photorealistic live-action film still, PORTRAIT 9:16, single frame, NO text, NO borders, NO split panels.",
  );
  lines.push(
    `Recreate the storyboard panel (image ${panelIdx}) at full resolution and detail: same composition, shot size, character positions, poses, hands, gaze.`,
  );
  if (input.hasPlate) {
    lines.push("LOCATION = image 1 (only source of the space; do not invent walls/doors/objects).");
  } else {
    lines.push(`LOCATION = the space visible in image ${panelIdx} (only source of the space; do not invent walls/doors/objects).`);
  }
  if (input.characterNames.length) {
    lines.push(
      `CHARACTERS (identical face, hair, wardrobe): ${input.characterNames.map((n, i) => `${n} = image ${firstChar + i}`).join(", ")}.`,
    );
  }
  lines.push(`SHOT: ${shotSizeLabel(input.shot)}.`);
  lines.push(`ACTION: ${input.action.trim()}`);
  return lines.join("\n");
}

export async function runRedrawStartFramesJob(jobId: string, projectId: string, episodeId: string, sceneIds: string[]): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  try {
    if (await canceled()) { await markCanceled(jobId); return; }
    const single = sceneIds.length === 1;
    await updateJob(jobId, { status: "processing", progress: 3, message: single ? "Рисуем..." : "Собираем панели, плейт и референсы..." });

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: {
        location: { select: { imageUrl: true } },
        scenes: {
          where: { id: { in: sceneIds } },
          orderBy: { number: "asc" },
          include: {
            location: { select: { imageUrl: true } },
            characters: { include: { character: true }, orderBy: { characterId: "asc" } },
          },
        },
      },
    });
    if (!episode) { await failJob(jobId, "Episode not found"); return; }

    const episodePlate = validUrl(episode.location?.imageUrl) ? episode.location!.imageUrl! : null;
    const targets = episode.scenes.filter((s) => validUrl(s.startFrameUrl));
    if (targets.length === 0) { await failJob(jobId, "У сцены нет старт-кадра (панели грида) — сначала нарежьте лист"); return; }

    const total = targets.length;
    let done = 0;
    let failed = 0;
    const errors: string[] = [];
    const updated: string[] = [];

    await runWithConcurrency(targets, REDRAW_CONCURRENCY, async (scene) => {
      if (await canceled()) return;
      try {
        const beat = parseBeatMeta(scene.beatMeta);
        const plateUrl = validUrl(scene.location?.imageUrl) ? scene.location!.imageUrl! : episodePlate;
        const links = await resolveBeatCastLinks(scene, scene.characters);
        const withRef = links.map((l) => l.character).filter((c) => validUrl(c.imageFull) || validUrl(c.imageFront));
        const ordered = [...withRef.filter((c) => c.tier !== "CROWD"), ...withRef.filter((c) => c.tier === "CROWD")];
        const maxChars = 10 - (plateUrl ? 2 : 1);
        const cast = ordered.slice(0, Math.max(0, maxChars));
        const castUrls = cast.map((c) => (validUrl(c.imageFull) ? c.imageFull! : c.imageFront!));
        const action = (beat?.action || scene.action || "").trim() || "The characters hold the positions shown in the panel.";
        const prompt = buildRedrawStartFramePrompt({ shot: beat?.shot ?? scene.shotType, action, hasPlate: !!plateUrl, characterNames: cast.map((c) => c.name) });
        const baseRefs = [...(plateUrl ? [plateUrl] : []), scene.startFrameUrl!];

        // Moderation ladder (as in the grid job): as-is → softened wording → softened without character portraits.
        const attempts: Array<{ prompt: string; image_input: string[] }> = [
          { prompt, image_input: [...baseRefs, ...castUrls] },
          { prompt: softenPromptForModeration(prompt), image_input: [...baseRefs, ...castUrls] },
          { prompt: softenPromptForModeration(prompt), image_input: baseRefs },
        ];
        let providerUrl = "";
        let promptUsed = prompt;
        for (let i = 0; i < attempts.length; i++) {
          const a = attempts[i];
          try {
            providerUrl = await generateImage(
              { prompt: a.prompt, aspect_ratio: "9:16", resolution: "2k", image_input: a.image_input },
              { jobId, shouldCancel: canceled, timeoutMs: REDRAW_IMAGE_TIMEOUT_MS },
            );
            promptUsed = a.prompt;
            break;
          } catch (err: any) {
            if (err instanceof GenerationCanceledError) throw err;
            if (!isModerationError(err) || i === attempts.length - 1) throw err;
            console.warn(`[start-frame-redraw] moderation rejection on attempt ${i + 1} for scene ${scene.id}, retrying softened`);
          }
        }
        if (await canceled()) return;

        const res = await fetch(providerUrl);
        if (!res.ok) throw new Error(`Не удалось скачать результат: ${res.status}`);
        const buf = await sharp(Buffer.from(await res.arrayBuffer()))
          .resize(OUT_W, OUT_H, { fit: "cover", position: "centre" })
          .png()
          .toBuffer();
        const key = `media/public/start-frames/${projectId}/${episodeId}/${scene.id}-redraw-${Date.now()}.png`;
        const url = await uploadBufferToS3(buf, key, "image/png");
        await prisma.scene.update({
          where: { id: scene.id },
          data: { startFrameUrl: url, keyframePrompt: promptUsed, ...(beat ? { beatMeta: { ...beat, startFramePrompt: promptUsed } } : {}) },
        });
        updated.push(scene.id);
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) return;
        failed += 1;
        errors.push(`${scene.title ?? scene.number}: ${e?.message ?? "failed"}`);
        console.error(`[start-frame-redraw] scene ${scene.id} failed:`, e?.message ?? e);
      } finally {
        done += 1;
        await heartbeatJob(jobId).catch(() => {});
        await updateJob(jobId, {
          progress: 3 + Math.round((done / total) * 95),
          message: single ? (failed ? "Ошибка" : "Готово") : `Полноразмерные старт-кадры: ${done}/${total}${failed ? ` (ошибок: ${failed})` : ""}`,
        }).catch(() => {});
      }
    });

    if (await canceled()) { await markCanceled(jobId); return; }
    if (failed === total) { await failJob(jobId, `Не удалось перерисовать ни одного кадра: ${errors[0] ?? ""}`); return; }
    await completeJob(
      jobId,
      { episodeId, sceneIds: targets.map((s) => s.id), updated, generated: total - failed, failed, errors: errors.slice(0, 5), single },
      single ? "Старт-кадр перерисован" : failed ? `Готово ${total - failed}/${total} кадров (ошибок: ${failed})` : `Готово: ${total} полноразмерных старт-кадров`,
    );
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[start-frame-redraw] job failed:", err);
    await failJob(jobId, err?.message ?? "Start frame redraw failed");
  }
}
