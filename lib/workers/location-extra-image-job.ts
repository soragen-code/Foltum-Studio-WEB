import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { locationExtraAnglePrompt, parseLocationExtra, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Background job: generate N EXTRA angle/shot references for ONE location, beyond the base 3.
 * Each is generated WITH the stored wide shot (Location.imageUrl) as Seedream image_input so the
 * place, light, weather and materials stay identical — only the framing changes. The new URLs are
 * APPENDED to Location.imageExtra (JSON array). Job type "location_extra_image".
 */
export async function runLocationExtraImagesJob({ jobId, projectId, locationId, count }: { jobId: string; projectId: string; locationId: string; count: number }): Promise<void> {
  try {
    const loc = await prisma.location.findFirst({ where: { id: locationId, projectId } });
    if (!loc) { await failJob(jobId, "Локация не найдена"); return; }
    if (!loc.imageUrl) { await failJob(jobId, "Сначала сгенерируйте базовые референсы локации"); return; }

    const visual = loc.visualPrompt ?? loc.description ?? loc.name;
    const existing = parseLocationExtra(loc.imageExtra);
    // Continue the variant cycle after the base 3 angles + whatever extras already exist.
    const startIndex = existing.length;
    const added: string[] = [];
    let c2paMissing = 0;
    const c2paChecks: { angle: string; ok: boolean; signatures: string[]; bytes: number }[] = [];

    await updateJob(jobId, { status: "processing", progress: 8, message: `Дополнительные ракурсы локации «${loc.name}» (0/${count})…` });
    for (let i = 0; i < count; i++) {
      // Stage 11: stop before the next extra angle. Already-added angles stay saved (persisted incrementally).
      if (await isCancelRequested(jobId)) {
        await markCanceled(jobId, added.length ? `Отменено — добавлено ${added.length} ракурсов` : "Отменено");
        return;
      }
      await updateJob(jobId, { progress: 8 + Math.round((i / Math.max(count, 1)) * 90), message: `Дополнительные ракурсы локации «${loc.name}» (${i + 1}/${count})…` });
      // Stage 16 (B1): DON'T hard-bind every extra frame to the wide shot — that pins the viewpoint
      // and yields near-copies. Re-anchor to the base image only on every 3rd frame; the rest rely on
      // the rich textual location description so the camera genuinely moves while the place stays the same.
      const idx = startIndex + i;
      const withBaseImage = idx % 3 === 2;
      try {
        const input: { prompt: string; aspect_ratio: string; image_input?: string[] } = {
          prompt: locationExtraAnglePrompt(visual, loc.name, idx, { withBaseImage }),
          aspect_ratio: "9:16",
        };
        if (withBaseImage) input.image_input = [loc.imageUrl];
        const remote = await generateImage(input, { jobId });
        const url = await uploadRemoteToS3(remote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-extra-${Date.now()}-${startIndex + i}.png`, "image/png");
        added.push(url);
        // Persist incrementally so a partial failure still keeps finished shots.
        await prisma.location.update({ where: { id: loc.id }, data: { imageExtra: JSON.stringify([...existing, ...added]) } });
        const r = await detectC2paFromUrl(url);
        c2paChecks.push({ angle: `extra-${startIndex + i}`, ok: r.ok, signatures: r.signatures, bytes: r.bytes });
        if (!r.ok) { c2paMissing += 1; console.warn(`[location-extra-images] C2PA metadata MISSING on ${url}`); }
      } catch (e: any) {
        console.error(`[location-extra-images] extra shot ${startIndex + i} failed for ${loc.name}:`, e?.message ?? e);
      }
      await sleep(1200);
    }
    await completeJob(
      jobId,
      { locationId, requested: count, added: added.length, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks },
      added.length ? `Готово — ${added.length} доп. ракурсов` : "Не удалось сгенерировать доп. ракурсы"
    );
  } catch (err: any) {
    console.error("[location-extra-images] failed:", err);
    await failJob(jobId, err?.message ?? "Extra location image generation failed");
  }
}
