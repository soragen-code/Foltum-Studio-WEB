import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";

import { characterImagePrompt, characterExtraAnglePrompt, VISUAL_STYLE_ID, isChildAppearance, type CharacterRefKind } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";
import { checkFullBodyImage, fullBodyPasses, fullBodyScore, fullBodyCorrectionSuffix, type FullBodyCheck } from "@/lib/full-body-check";
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
/** Max generations of the full-body shot per character (1 + up to 2 corrective retries). */
export const FULL_BODY_MAX_ATTEMPTS = 3;
/** @deprecated kept for older imports — the retry now uses fullBodyCorrectionSuffix (names the exact problem). */
export const FULL_BODY_RETRY_SUFFIX = " Wider framing — step the camera further back so the shoes and the floor are clearly visible.";

/**
 * Generate the full-body shot with the proportion guard: vision-check each attempt and, when it fails
 * (dwarf-like proportions / cropped body), regenerate with an escalated corrective prompt naming the exact
 * problem — up to FULL_BODY_MAX_ATTEMPTS generations. Returns the first passing attempt, or the BEST
 * failing one so the character never ends up without an image. A failing/skipped CHECK keeps the image.
 */
export async function generateFullBodyWithGuard(
  basePrompt: string,
  gen: (prompt: string) => Promise<string>,
  opts: { child?: boolean; label?: string; check?: (url: string) => Promise<FullBodyCheck | null>; canceled?: () => Promise<boolean>; maxAttempts?: number } = {}
): Promise<{ url: string; check: FullBodyCheck | null; attempts: number; passed: boolean }> {
  const check = opts.check ?? checkFullBodyImage;
  const max = opts.maxAttempts ?? FULL_BODY_MAX_ATTEMPTS;
  let best: { url: string; check: FullBodyCheck | null; score: number } | null = null;
  let last: FullBodyCheck | null = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    const prompt = attempt === 1 ? basePrompt : basePrompt + fullBodyCorrectionSuffix(last, attempt, { child: opts.child });
    const url = await gen(prompt);
    const c = await check(url);
    console.log(`[images-job] full-body check for ${opts.label ?? "character"} (attempt ${attempt}):`, c ? JSON.stringify(c) : "skipped");
    // Check unavailable (error / no key): keep the image — never burn credits blind.
    if (!c) return { url, check: null, attempts: attempt, passed: false };
    if (fullBodyPasses(c, { child: opts.child })) return { url, check: c, attempts: attempt, passed: true };
    const score = fullBodyScore(c);
    if (!best || score > best.score) best = { url, check: c, score };
    last = c;
    if (opts.canceled && (await opts.canceled())) break;
  }
  console.warn(`[images-job] full-body for ${opts.label ?? "character"} failed the proportion check after ${max} attempts — keeping the best one`);
  return { url: best!.url, check: best!.check, attempts: max, passed: false };
}

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
    // Stage 46A: `ref` may be the FULL-BODY anchor (refKind "full") or a face close-up (legacy resume path).
    const genBaseShot = async (char: (typeof characters)[number], shot: BaseShot, ref: string | null, refKind: CharacterRefKind = "face") => {
      if (await canceled()) return;
      const chained = !!ref;
      try {
        const basePrompt = characterImagePrompt(char.appearance ?? "", shot, char.name, char.tier, char.groupSize, chained, refKind);
        const gen = (prompt: string) => generateImage(
          { prompt, aspect_ratio: ASPECT_RATIOS[shot], ...(chained ? { image_input: [ref!] } : {}) },
          { jobId, characterId: char.id, imageModel }
        );
        let replicateUrl: string;
        // Proportion guard for the full-body shot (people only): the chained face close-up pulls the model
        // into a big-headed, short-legged "dwarf" figure (or a hip-cropped medium shot). Vision-check each
        // attempt and regenerate with a corrective prompt up to FULL_BODY_MAX_ATTEMPTS times; keep the
        // best attempt if all fail. A failing CHECK never fails the job.
        if (shot === "full" && char.tier !== "CROWD") {
          const r = await generateFullBodyWithGuard(basePrompt, gen, { child: isChildAppearance(char.appearance ?? ""), label: char.name, canceled });
          replicateUrl = r.url;
        } else {
          replicateUrl = await gen(basePrompt);
        }
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

    // ---- Pass 1a (Stage 46A): FULL-BODY shots first, as the identity anchor ----
    // Generated text-to-image (no close-up reference pulling the model into big-headed, short-legged
    // "dwarf" figures) with the proportion guard. Legacy resume: a character that already has a front
    // portrait but no full shot is chained on that front (old path, still guarded).
    const fullTasks = characters.filter((char) => !(char as any).imageFull).map((char) => ({ char }));
    await runWithConcurrency(fullTasks, REF_BATCH_CONCURRENCY, async ({ char }) =>
      genBaseShot(char, "full", ((char as any).imageFront as string | null) ?? null, "face")
    );

    // ---- Pass 1b: FRONT close-up chained on the full-body anchor (same person, camera moved closer) ----
    const frontTasks = characters.filter((char) => !(char as any).imageFront).map((char) => ({ char }));
    await runWithConcurrency(frontTasks, REF_BATCH_CONCURRENCY, async ({ char }) =>
      genBaseShot(char, "front", ((char as any).imageFull as string | null) ?? null, "full")
    );

    // ---- Pass 1c: PROFILE chained on the front close-up (face identity), falling back to the full anchor ----
    const profileTasks = characters.filter((char) => !(char as any).imageProfile).map((char) => ({ char }));
    await runWithConcurrency(profileTasks, REF_BATCH_CONCURRENCY, async ({ char }) => {
      const front = (char as any).imageFront as string | null;
      const full = (char as any).imageFull as string | null;
      return genBaseShot(char, "profile", front ?? full ?? null, front ? "face" : "full");
    });

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
        const full = (char as any).imageFull as string | null;
        // Even index = right profile (face reference); odd index = full-body BACK — chained on the
        // full-body anchor so the proportions are copied from a full-length figure, not a close-up.
        const isFullShot = index % 2 === 1;
        const ref = isFullShot ? (full ?? front) : (front ?? full);
        const refKind: CharacterRefKind = ref === full && full ? "full" : "face";
        if (!ref) { done += 1; await bump("Доп. ракурсы"); return; }
        try {
          const remote = await generateImage(
            { prompt: characterExtraAnglePrompt(char.appearance ?? "", char.name, index, refKind), aspect_ratio: isFullShot ? "9:16" : "3:4", image_input: [ref] },
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
