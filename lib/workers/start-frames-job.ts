/**
 * Simplified pipeline — step 9. START FRAMES.
 *
 * One 9:16 start frame per beat scene (Scene.beatMeta), rendered with GPT Image 2.0 in parallel.
 * image_input order matches buildStartFramePrompt(): image 1 = the episode's location plate (when present),
 * image 2.. = the cast of the beat (Character.imageFull, appearance only). The stored frame becomes
 * Scene.startFrameUrl and feeds the beat's video clip as its first frame (lib/scene-prompt.ts beat branch).
 * Job type "start_frames"; resultData { episodeId, sceneIds }.
 */
import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { runWithConcurrency } from "@/lib/reference-counts";
import { parseBeatMeta, buildStartFramePrompt, START_FRAMES_JOB_TYPE, type BeatMeta } from "@/lib/simple-pipeline";

export { START_FRAMES_JOB_TYPE };

/** Parallel provider calls — 25 beats per episode, keep well under the provider's concurrency limits. */
const START_FRAME_CONCURRENCY = 6;

const validUrl = (u?: string | null): u is string => typeof u === "string" && u.startsWith("http") && u.length > 10;

export async function runStartFramesJob(jobId: string, projectId: string, episodeId: string, sceneIds?: string[] | null): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  try {
    if (await canceled()) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 3, message: "Собираем биты, референсы и плейт…" });

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: {
        location: { select: { imageUrl: true } },
        scenes: {
          orderBy: { number: "asc" },
          include: { characters: { include: { character: { select: { id: true, name: true, imageFull: true, imageFront: true } } } } },
        },
      },
    });
    if (!episode) { await failJob(jobId, "Episode not found"); return; }

    const plateUrl = validUrl(episode.location?.imageUrl) ? episode.location!.imageUrl! : null;
    const wanted = sceneIds && sceneIds.length ? new Set(sceneIds) : null;
    const targets = episode.scenes
      .map((s) => ({ scene: s, beat: parseBeatMeta(s.beatMeta) }))
      .filter((t): t is { scene: (typeof episode.scenes)[number]; beat: BeatMeta } => !!t.beat && (!wanted || wanted.has(t.scene.id)));
    if (targets.length === 0) { await failJob(jobId, "Нет битов шот-листа для генерации кадров"); return; }

    const total = targets.length;
    let done = 0;
    let failed = 0;
    const errors: string[] = [];

    await runWithConcurrency(targets, START_FRAME_CONCURRENCY, async ({ scene, beat }) => {
      if (await canceled()) return;
      const cast = scene.characters.map((sc) => sc.character);
      const withRef = cast.filter((c) => validUrl(c.imageFull) || validUrl(c.imageFront));
      const characterNames = withRef.map((c) => c.name);
      const prompt = buildStartFramePrompt({ beat, characterNames, hasPlate: !!plateUrl });
      const imageInput = [
        ...(plateUrl ? [plateUrl] : []),
        ...withRef.map((c) => (validUrl(c.imageFull) ? c.imageFull! : c.imageFront!)),
      ].slice(0, 10);
      try {
        const providerUrl = await generateImage(
          { prompt, aspect_ratio: "9:16", ...(imageInput.length ? { image_input: imageInput } : {}) },
          { jobId, shouldCancel: canceled },
        );
        if (await canceled()) return;
        const key = `media/public/start-frames/${projectId}/${episodeId}/${scene.id}-${Date.now()}.png`;
        const url = await uploadRemoteToS3(providerUrl, key, "image/png");
        await prisma.scene.update({
          where: { id: scene.id },
          data: {
            startFrameUrl: url,
            keyframePrompt: prompt,
            beatMeta: { ...beat, startFramePrompt: prompt },
          },
        });
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) return;
        failed += 1;
        errors.push(`${scene.title}: ${e?.message ?? "failed"}`);
        console.error(`[start-frames] scene ${scene.id} failed:`, e?.message ?? e);
      } finally {
        done += 1;
        await updateJob(jobId, {
          progress: 3 + Math.round((done / total) * 95),
          message: `Стартовые кадры: ${done}/${total}${failed ? ` (ошибок: ${failed})` : ""}`,
        }).catch(() => {});
      }
    });

    if (await canceled()) { await markCanceled(jobId); return; }
    if (failed === total) { await failJob(jobId, `Не удалось сгенерировать ни одного кадра: ${errors[0] ?? ""}`); return; }
    await completeJob(
      jobId,
      { episodeId, sceneIds: targets.map((t) => t.scene.id), generated: total - failed, failed, errors: errors.slice(0, 5) },
      failed ? `Готово ${total - failed}/${total} кадров (ошибок: ${failed})` : `Готово: ${total} стартовых кадров`,
    );
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[start-frames] job failed:", err);
    await failJob(jobId, err?.message ?? "Start frames failed");
  }
}
