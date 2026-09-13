import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";

import { VISUAL_STYLE_ID, isChildAppearance, type CharacterRefKind } from "@/lib/visual-style";
// Stage 46D: prompt wrappers that append the full-body proportion rule to every full-length frame.
import { characterShotPrompt, clampPromptToLimit } from "@/lib/full-body-prompt";
import { detectC2paFromUrl } from "@/lib/c2pa";
import { checkFullBodyImage, fullBodyPasses, fullBodyScore, fullBodyCorrectionSuffix, evaluateProportions, type FullBodyCheck, type ProportionDefect } from "@/lib/full-body-check";
import { REF_BATCH_CONCURRENCY, runWithConcurrency } from "@/lib/reference-counts";
import { loadProjectImageProvider } from "@/lib/providers/project-provider";

// Stage 53: a character reference is a SINGLE photo — the full-body FRONT shot (imageFull). The front
// portrait, the profile and the extra angles are no longer auto-generated; they are only produced when
// the user asks for them from the character card (POST /api/ai/characters/[id]/shot). BASE_SHOTS still
// lists all three slots so genBaseShot/SHOT_FIELDS stay reusable by that manual route's shared code.
const BASE_SHOTS = ["front", "profile", "full"] as const;
type BaseShot = (typeof BASE_SHOTS)[number];
const ASPECT_RATIOS: Record<BaseShot, string> = { front: "3:4", profile: "3:4", full: "9:16" };
const SHOT_LABELS: Record<BaseShot, string> = { front: "front portrait", profile: "side profile", full: "full-body shot" };
const SHOT_FIELDS: Record<BaseShot, "imageFront" | "imageProfile" | "imageFull"> = {
  front: "imageFront",
  profile: "imageProfile",
  full: "imageFull",
};
/** Max generations of the full-body shot per character (1 + up to 2 corrective retries). */
export const FULL_BODY_MAX_ATTEMPTS = 3;
/** @deprecated kept for older imports — the retry now uses fullBodyCorrectionSuffix (names the exact problem). */
export const FULL_BODY_RETRY_SUFFIX = " Wider framing — step the camera further back so the shoes and the floor are clearly visible.";

/**
 * Generate the full-body shot with the framing + proportion guard: ONE vision check per attempt decides
 * both framing (cropped body / dwarf figure) and Stage 46D proportions (elongated torso, short legs, small
 * head, inconsistent volume); when it fails, regenerate with an escalated corrective prompt naming the exact
 * problem — up to FULL_BODY_MAX_ATTEMPTS generations in total (framing and proportion retries share the
 * budget). Returns the first passing attempt, or the BEST failing one (fewest / least severe defects,
 * framing OK preferred) so the character never ends up without an image — with `proportionsWarning`
 * listing the remaining defects (logged; no DB change). A failing/skipped CHECK keeps the image.
 */
export async function generateFullBodyWithGuard(
  basePrompt: string,
  gen: (prompt: string) => Promise<string>,
  opts: { child?: boolean; label?: string; check?: (url: string) => Promise<FullBodyCheck | null>; canceled?: () => Promise<boolean>; maxAttempts?: number } = {}
): Promise<{ url: string; check: FullBodyCheck | null; attempts: number; passed: boolean; proportionsWarning?: ProportionDefect[] }> {
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
  const defects = evaluateProportions(best!.check?.proportions).defects;
  console.warn(`[images-job] full-body for ${opts.label ?? "character"} failed the framing/proportion check after ${max} attempts — keeping the best one`, JSON.stringify({ proportionsWarning: defects, issues: best!.check?.issues ?? [] }));
  return { url: best!.url, check: best!.check, attempts: max, passed: false, proportionsWarning: defects };
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
 * Stage 53 — background job: generates ONE reference photo per character — the full-body FRONT shot
 * (imageFull), the single visual anchor the video pipeline sends to Seedance (see scene-prompt.ts). It
 * is produced text-to-image (no face-chain) and passes the framing + proportion guard. The old front
 * portrait, the profile and the extra angles are NOT auto-generated any more — they are only produced
 * on demand from the character card (POST /api/ai/characters/[id]/shot). Up to REF_BATCH_CONCURRENCY
 * (20) Replicate requests run in flight; every stored photo's C2PA metadata is verified. Idempotent:
 * a character that already has imageFull is skipped, so a resumed/retried job only fills the gaps.
 */
export async function runCharacterImagesJob({ jobId, projectId, characterIds, imageModel }: CharacterImagesJobParams): Promise<void> {
  try {
    const imageProvider = await loadProjectImageProvider(projectId); // Stage 73: transport provider only
    const characters = await prisma.character.findMany({
      where: { id: { in: characterIds }, projectId },
      orderBy: { createdAt: "asc" },
    });

    // Stage 53: exactly one auto-generated photo per character — the full-body front (imageFull).
    const total = characters.length;
    let done = 0;
    let failed = 0;
    let c2paMissing = 0;
    const c2paChecks: C2paCheck[] = [];
    // Stage 46D: full-body frames kept despite failing the proportion guard (logged in the job result, no schema change).
    const proportionsWarnings: { characterId: string; name: string; defects: ProportionDefect[] }[] = [];

    // Count the full-body photos that already exist (idempotent resume) toward "done".
    for (const c of characters) if ((c as any).imageFull) done += 1;

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
        const basePrompt = characterShotPrompt(char.appearance ?? "", shot, char.name, char.tier, char.groupSize, chained, refKind, char.promptOverride, char.age);
        // Stage 58: clamp the FINAL prompt (including any corrective retry suffix appended by the guard) so it
        // never exceeds the image provider's 4000-char hard limit (Seedream returns HTTP 422 otherwise, which
        // previously nulled the full-body photo). A prompt already within the limit is passed through unchanged.
        const gen = (prompt: string) => generateImage(
          { prompt: clampPromptToLimit(prompt), aspect_ratio: ASPECT_RATIOS[shot], ...(chained ? { image_input: [ref!] } : {}) },
          { jobId, characterId: char.id, imageModel, provider: imageProvider }
        );
        let replicateUrl: string;
        // Proportion guard for the full-body shot (people only): the chained face close-up pulls the model
        // into a big-headed, short-legged "dwarf" figure (or a hip-cropped medium shot). Vision-check each
        // attempt and regenerate with a corrective prompt up to FULL_BODY_MAX_ATTEMPTS times; keep the
        // best attempt if all fail. A failing CHECK never fails the job.
        if (shot === "full" && char.tier !== "CROWD") {
          const r = await generateFullBodyWithGuard(basePrompt, gen, { child: isChildAppearance(char.appearance ?? ""), label: char.name, canceled });
          replicateUrl = r.url;
          if (r.proportionsWarning?.length) proportionsWarnings.push({ characterId: char.id, name: char.name, defects: r.proportionsWarning });
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

    // ---- Stage 53: the ONLY auto-generated shot — the full-body FRONT photo (imageFull) ----
    // Produced text-to-image (ref=null → no face-chain) so the single stored photo IS the full-body
    // front the user sees in the scene, then run through the framing + proportion guard inside
    // genBaseShot (shot === "full" && tier !== "CROWD"). The front portrait, the profile and the extra
    // angles are NOT generated here any more — they are user-triggered on the character card.
    const fullTasks = characters.filter((char) => !(char as any).imageFull).map((char) => ({ char }));
    await runWithConcurrency(fullTasks, REF_BATCH_CONCURRENCY, async ({ char }) =>
      genBaseShot(char, "full", null, "face")
    );

    if (await canceled()) { await markCanceled(jobId, `Отменено — готово ${done} из ${total} фото`); return; }

    await completeJob(
      jobId,
      { total, failed, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks, ...(proportionsWarnings.length ? { proportionsWarnings } : {}) },
      failed > 0 ? `Готово — не удалось ${failed} из ${total} фото` : "Все фото персонажей готовы"
    );
  } catch (err: any) {
    console.error("[images-job] failed:", err);
    await failJob(jobId, err?.message ?? "Image generation failed");
  }
}
