import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { locationExtraAnglePrompt, parseLocationExtra, VISUAL_STYLE_ID, REFERENCE_ASPECT_RATIO } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stage 44 — max photographs attached to one extra-plate request (master + base angles + extras). */
export const EXTRA_JOB_IMAGE_INPUT_CAP = 6;

/**
 * Stage 44 — pure helper: the image_input list for an extra location plate. The master wide shot is
 * ALWAYS first, followed by the other base angles (reverse, detail) and the extras generated so far,
 * de-duplicated and capped. Never empty when the master exists.
 */
export function extraJobImageInputs(
  loc: { imageUrl?: string | null; imageReverse?: string | null; imageDetail?: string | null },
  existingExtras: readonly string[],
  cap = EXTRA_JOB_IMAGE_INPUT_CAP
): string[] {
  const out: string[] = [];
  for (const u of [loc.imageUrl, loc.imageReverse, loc.imageDetail, ...existingExtras]) {
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Background job: generate N EXTRA angle/shot references for ONE location, beyond the base 3.
 * Stage 44: each is generated WITH the stored photographs of the place (master wide shot first, then the
 * other base angles and the extras made so far) as Seedream image_input so the place, light, weather
 * and materials stay identical — only the camera position changes (five-slot LOCATION_SHOT_PLAN). The new URLs are
 * APPENDED to Location.imageExtra (JSON array). Job type "location_extra_image".
 */
export async function runLocationExtraImagesJob({ jobId, projectId, locationId, count, imageModel }: { jobId: string; projectId: string; locationId: string; count: number; imageModel?: string }): Promise<void> {
  // User cancel: checked before every provider call (generateImage also cancels the running prediction)
  // and before a finished plate is written. Existing imageExtra stays as is; the caller's refund pass
  // returns the credits for every plate that was not added.
  const canceled = () => isCancelRequested(jobId);
  const CANCEL_MSG = "Generation canceled by the user";
  try {
    if (await canceled()) { await markCanceled(jobId, CANCEL_MSG); return; }
    const loc = await prisma.location.findFirst({ where: { id: locationId, projectId } });
    if (!loc) { await failJob(jobId, "Location not found"); return; }
    if (!loc.imageUrl) { await failJob(jobId, "First generate the base location references"); return; }

    const visual = loc.visualPrompt ?? loc.description ?? loc.name;
    const existing = parseLocationExtra(loc.imageExtra);
    // Continue the variant cycle after the base 3 angles + whatever extras already exist.
    const startIndex = existing.length;
    const added: string[] = [];
    let c2paMissing = 0;
    const c2paChecks: { angle: string; ok: boolean; signatures: string[]; bytes: number }[] = [];

    await updateJob(jobId, { status: "processing", progress: 8, message: `Additional location angles "${loc.name}» (0/${count})…` });
    for (let i = 0; i < count; i++) {
      // Stage 11: stop before the next extra angle. Already-added angles stay saved (persisted incrementally).
      if (await canceled()) {
        await markCanceled(jobId, added.length ? `${CANCEL_MSG} — added ${added.length} angles` : CANCEL_MSG);
        return;
      }
      await updateJob(jobId, { progress: 8 + Math.round((i / Math.max(count, 1)) * 90), message: `Additional location angles "${loc.name}» (${i + 1}/${count})…` });
      // Stage 44: EVERY extra plate is generated from the photographs of the place that already exist —
      // master wide shot first, then the other base angles, then the extras made so far — so the model
      // re-photographs the SAME place from the planned new position instead of inventing a new one.
      const idx = startIndex + i;
      try {
        const input: { prompt: string; aspect_ratio: string; image_input?: string[] } = {
          prompt: locationExtraAnglePrompt(visual, loc.name, idx),
          aspect_ratio: REFERENCE_ASPECT_RATIO,
          image_input: extraJobImageInputs(loc, [...existing, ...added]),
        };
        const remote = await generateImage(input, { jobId, imageModel, shouldCancel: canceled});
        if (await canceled()) throw new GenerationCanceledError(); // discard the plate, keep imageExtra as is
        const url = await uploadRemoteToS3(remote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-extra-${Date.now()}-${startIndex + i}.png`, "image/png");
        added.push(url);
        // Persist incrementally so a partial failure still keeps finished shots.
        await prisma.location.update({ where: { id: loc.id }, data: { imageExtra: JSON.stringify([...existing, ...added]) } });
        const r = await detectC2paFromUrl(url);
        c2paChecks.push({ angle: `extra-${startIndex + i}`, ok: r.ok, signatures: r.signatures, bytes: r.bytes });
        if (!r.ok) { c2paMissing += 1; console.warn(`[location-extra-images] C2PA metadata MISSING on ${url}`); }
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) {
          await markCanceled(jobId, added.length ? `${CANCEL_MSG} — added ${added.length} angles` : CANCEL_MSG);
          return;
        }
        console.error(`[location-extra-images] extra shot ${startIndex + i} failed for ${loc.name}:`, e?.message ?? e);
      }
      await sleep(1200);
    }
    await completeJob(
      jobId,
      { locationId, requested: count, added: added.length, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks },
      added.length ? `Done — ${added.length} extra angles` : "Failed to generate additional angles"
    );
  } catch (err: any) {
    console.error("[location-extra-images] failed:", err);
    await failJob(jobId, err?.message ?? "Extra location image generation failed");
  }
}
