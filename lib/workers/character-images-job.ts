import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";

import { characterImagePrompt, characterExtraAnglePrompt, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";
import { CHARACTER_PHOTO_COUNT, REF_BATCH_CONCURRENCY, runWithConcurrency, parseImageArray } from "@/lib/reference-counts";

// Stage 18: every character reference has 3 photos — the 3 canonical shots (front, profile,
// full). No extra angles are generated (EXTRA_COUNT resolves to 0).
const BASE_SHOTS = ["front", "profile", "full"] as const;
type BaseShot = (typeof BASE_SHOTS)[number];
const ASPECT_RATIOS: Record<BaseShot, string> = { front: "3:4", profile: "3:4", full: "9:16" };
const SHOT_LABELS: Record<BaseShot, string> = { front: "front portrait", profile: "side profile", full: "full-body shot" };
const SHOT_FIELDS: Record<BaseShot, "imageFront" | "imageProfile" | "imageFull"> = {
  front: "imageFront",
  profile: "imageProfile",
  full: "imageFull",
};
/** Extra angles on top of the 3 base shots — 0 in Stage 18 (character = 3 photos). */
const EXTRA_COUNT = Math.max(0, CHARACTER_PHOTO_COUNT - BASE_SHOTS.length);

export interface CharacterImagesJobParams {
  jobId: string;
  projectId: string;
  characterIds: string[];
  /** Producer-picked image model (currently only "seedream-5-lite"); passed to the image model. */
  imageModel?: string;
}

type C2paCheck = { characterId: string; shot: string; ok: boolean; signatures: string[]; bytes: number };

/**
 * Background job: generates the 5 reference photos per character — the 3 canonical shots
 * plus 2 extra angles chained on the front portrait. Up to REF_BATCH_CONCURRENCY (20)
 * Replicate requests run in flight at once; the rest queue and start as slots free up.
 * Every stored photo's C2PA / content-credentials metadata is verified. Idempotent: shots
 * that already exist are skipped, so a resumed/retried job only fills the gaps.
 */
export async function runCharacterImagesJob({ jobId, projectId, characterIds, imageModel }: CharacterImagesJobParams): Promise<void> {
  try {
    const characters = await prisma.character.findMany({
      where: { id: { in: characterIds }, projectId },
      orderBy: { createdAt: "asc" },
    });

    const total = characters.length * CHARACTER_PHOTO_COUNT;
    let done = 0;
    let failed = 0;
    let c2paMissing = 0;
    const c2paChecks: C2paCheck[] = [];
    // In-memory view of each character's already-persisted extra angles, so concurrent
    // extra-shot tasks append without clobbering each other.
    const extraByChar = new Map<string, string[]>();
    for (const c of characters) extraByChar.set(c.id, parseImageArray(c.imageExtra));

    // Count photos that already exist (idempotent resume) toward "done".
    for (const c of characters) {
      for (const shot of BASE_SHOTS) if ((c as any)[SHOT_FIELDS[shot]]) done += 1;
      done += Math.min(EXTRA_COUNT, extraByChar.get(c.id)?.length ?? 0);
    }

    const pct = () => 5 + Math.round((done / Math.max(total, 1)) * 95);
    const bump = async (label: string) => { await updateJob(jobId, { progress: pct(), message: `${label} (${done}/${total})` }); };
    await updateJob(jobId, { status: "processing", progress: pct(), message: `Генерирую фото персонажей (${done}/${total})…` });

    const canceled = () => isCancelRequested(jobId);

    // Generate one base shot, upload, persist, verify C2PA and bump progress.
    // Stage 21: `refFront` (when given) is passed as image_input so the shot locks onto the SAME
    // identity as the stored front portrait — profile/full must be the same person as the face shot.
    const genBaseShot = async (char: (typeof characters)[number], shot: BaseShot, refFront: string | null) => {
      if (await canceled()) return;
      const chained = shot !== "front" && !!refFront;
      try {
        const replicateUrl = await generateImage(
          {
            prompt: characterImagePrompt(char.appearance ?? "", shot, char.name, char.tier, char.groupSize, chained),
            aspect_ratio: ASPECT_RATIOS[shot],
            ...(chained ? { image_input: [refFront!] } : {}),
          },
          { jobId, characterId: char.id, imageModel }
        );
        const s3Key = `media/public/characters/${projectId}/${char.id}/${VISUAL_STYLE_ID}/${shot}-${Date.now()}.png`;
        const url = await uploadRemoteToS3(replicateUrl, s3Key, "image/png");
        await prisma.character.update({ where: { id: char.id }, data: { [SHOT_FIELDS[shot]]: url } });
        (char as any)[SHOT_FIELDS[shot]] = url;
        const c2pa = await detectC2paFromUrl(url);
        c2paChecks.push({ characterId: char.id, shot, ok: c2pa.ok, signatures: c2pa.signatures, bytes: c2pa.bytes });
        if (!c2pa.ok) { c2paMissing += 1; console.warn(`[images-job] C2PA MISSING on ${shot} for ${char.name} (${url})`); }
      } catch (e: any) {
        failed += 1;
        console.error(`[images-job] ${shot} failed for ${char.name}:`, e?.message ?? e);
      } finally {
        done += 1;
        await bump("Базовые ракурсы");
      }
    };

    // ---- Pass 1a: FRONT portraits first (concurrency across characters), stored as the identity anchor ----
    const frontTasks = characters.filter((char) => !(char as any).imageFront).map((char) => ({ char }));
    await runWithConcurrency(frontTasks, REF_BATCH_CONCURRENCY, async ({ char }) => genBaseShot(char, "front", null));

    // ---- Pass 1b: PROFILE + FULL, each chained on the character's own (now stored) front portrait ----
    // Chaining on the front image_input locks profile/full to the SAME face/identity so the 3 shots
    // are recognisably the same person. If a front is missing (its generation failed), fall back to
    // plain text-to-image for that character's profile/full so the job never crashes.
    const chainedTasks = characters.flatMap((char) =>
      (["profile", "full"] as const)
        .filter((shot) => !(char as any)[SHOT_FIELDS[shot]])
        .map((shot) => ({ char, shot }))
    );
    await runWithConcurrency(chainedTasks, REF_BATCH_CONCURRENCY, async ({ char, shot }) =>
      genBaseShot(char, shot, ((char as any).imageFront as string | null) ?? null)
    );

    // ---- Pass 2: 2 extra angles per character, each chained on the (now stored) front portrait ----
    if (!(await canceled()) && EXTRA_COUNT > 0) {
      const extraTasks = characters.flatMap((char) => {
        const have = extraByChar.get(char.id)?.length ?? 0;
        const need = Math.max(0, EXTRA_COUNT - have);
        return Array.from({ length: need }, (_, k) => ({ char, index: have + k }));
      });
      await runWithConcurrency(extraTasks, REF_BATCH_CONCURRENCY, async ({ char, index }) => {
        if (await canceled()) return;
        const front = (char as any).imageFront as string | null;
        if (!front) { done += 1; await bump("Доп. ракурсы"); return; }
        try {
          const remote = await generateImage(
            { prompt: characterExtraAnglePrompt(char.appearance ?? "", char.name, index), aspect_ratio: index % 2 === 0 ? "3:4" : "9:16", image_input: [front] },
            { jobId, characterId: char.id, imageModel }
          );
          const url = await uploadRemoteToS3(remote, `media/public/characters/${projectId}/${char.id}/${VISUAL_STYLE_ID}/extra-${Date.now()}-${index}.png`, "image/png");
          const arr = extraByChar.get(char.id) ?? [];
          arr.push(url);
          extraByChar.set(char.id, arr);
          await prisma.character.update({ where: { id: char.id }, data: { imageExtra: JSON.stringify(arr) } });
          const c2pa = await detectC2paFromUrl(url);
          c2paChecks.push({ characterId: char.id, shot: `extra-${index}`, ok: c2pa.ok, signatures: c2pa.signatures, bytes: c2pa.bytes });
          if (!c2pa.ok) { c2paMissing += 1; console.warn(`[images-job] C2PA MISSING on extra-${index} for ${char.name} (${url})`); }
        } catch (e: any) {
          failed += 1;
          console.error(`[images-job] extra-${index} failed for ${char.name}:`, e?.message ?? e);
        } finally {
          done += 1;
          await bump("Доп. ракурсы");
        }
      });
    }

    if (await canceled()) { await markCanceled(jobId, `Отменено — готово ${done} из ${total} фото`); return; }

    await completeJob(
      jobId,
      { total, failed, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks },
      failed > 0 ? `Готово — не удалось ${failed} из ${total} фото` : "Все фото персонажей готовы"
    );
  } catch (err: any) {
    console.error("[images-job] failed:", err);
    await failJob(jobId, err?.message ?? "Image generation failed");
  }
}
