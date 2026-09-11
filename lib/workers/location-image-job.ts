import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { locationAnglePrompt, LOCATION_ANGLES, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Background job: a photoreal 9:16 PNG reference SET per location (Seedream, C2PA kept):
 * wide establishing shot + reverse angle + medium angle of the same place with identical light,
 * uploaded to S3 and written to Location.imageUrl / imageReverse / imageDetail. Job type "location_image".
 */
export async function runLocationImagesJob({ jobId, projectId, locationIds, imageModel }: { jobId: string; projectId: string; locationIds: string[]; imageModel?: string }): Promise<void> {
  try {
    const locations = await prisma.location.findMany({ where: { id: { in: locationIds }, projectId }, orderBy: { createdAt: "asc" } });
    const total = locations.length;
    let done = 0;
    let failed = 0;
    // Non-blocking C2PA diagnostic across every stored angle.
    let c2paMissing = 0;
    const c2paChecks: { locationId: string; angle: string; ok: boolean; signatures: string[]; bytes: number }[] = [];
    const checkC2pa = async (locationId: string, angle: string, url: string) => {
      const r = await detectC2paFromUrl(url);
      c2paChecks.push({ locationId, angle, ok: r.ok, signatures: r.signatures, bytes: r.bytes });
      if (!r.ok) {
        c2paMissing += 1;
        console.warn(`[location-images] C2PA metadata MISSING on stored ${angle} angle (${url}) — Seedance moderation may drop it.`);
      }
    };
    const pct = () => 5 + Math.round((done / Math.max(total, 1)) * 95);
    await updateJob(jobId, { status: "processing", progress: pct(), message: `Генерация ${total} референсов локаций…` });
    for (const loc of locations) {
      // Stage 11: stop before starting the next location. Finished references stay saved.
      if (await isCancelRequested(jobId)) {
        await markCanceled(jobId, `Отменено — готово ${done} из ${total} локаций`);
        return;
      }
      await updateJob(jobId, { progress: pct(), message: `Референс локации «${loc.name}» (${done + 1}/${total})…` });
      try {
        const visual = loc.visualPrompt ?? loc.description ?? loc.name;
        // 1) wide establishing angle — the anchor for the light and the place
        const wideRemote = await generateImage({ prompt: locationAnglePrompt(visual, loc.name, "wide"), aspect_ratio: "9:16" }, { jobId, imageModel });
        const stamp = Date.now();
        const wideUrl = await uploadRemoteToS3(wideRemote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-${stamp}-wide.png`, "image/png");
        await prisma.location.update({ where: { id: loc.id }, data: { imageUrl: wideUrl, imageReverse: null, imageDetail: null, imageExtra: null } }); // new master → the old angles no longer match; re-shot from this frame
        await checkC2pa(loc.id, "wide", wideUrl);
        // 2) other angles of the SAME place: the wide shot is passed as image_input so light/materials stay identical
        for (const a of LOCATION_ANGLES.filter((x) => x.angle !== "wide")) {
          await updateJob(jobId, { progress: pct(), message: `Референс локации «${loc.name}» — ${a.label.toLowerCase()} (${done + 1}/${total})...` });
          try {
            const remote = await generateImage({ prompt: locationAnglePrompt(visual, loc.name, a.angle), aspect_ratio: "9:16", image_input: [wideRemote] }, { jobId, imageModel });
            const url = await uploadRemoteToS3(remote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-${stamp}-${a.angle}.png`, "image/png");
            await prisma.location.update({ where: { id: loc.id }, data: { [a.key]: url } });
            await checkC2pa(loc.id, a.angle, url);
          } catch (e: any) {
            // the wide angle alone is still a valid reference — log and continue
            console.error(`[location-images] ${a.angle} angle failed for ${loc.name}:`, e?.message ?? e);
          }
        }
      } catch (e: any) {
        failed += 1;
        console.error(`[location-images] failed for ${loc.name}:`, e?.message ?? e);
      }
      done += 1;
      await sleep(1500);
    }
    await completeJob(jobId, { total, failed, locationIds, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks }, failed > 0 ? `Готово — ${failed} из ${total} не удалось` : "Референсы локаций готовы");
  } catch (err: any) {
    console.error("[location-images] failed:", err);
    await failJob(jobId, err?.message ?? "Location image generation failed");
  }
}
