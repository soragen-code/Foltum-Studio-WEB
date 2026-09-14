import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { locationAnglePrompt, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";
import { loadProjectImageProvider } from "@/lib/providers/project-provider";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Background job: a photoreal 9:16 PNG reference SET per location (Seedream, C2PA kept):
 * ONE wide establishing master frame per location (Stage 46A — extra angles are added on demand
 * by the location_extra_image job), uploaded to S3 and written to Location.imageUrl. Job type "location_image".
 */
export async function runLocationImagesJob({ jobId, projectId, locationIds, imageModel }: { jobId: string; projectId: string; locationIds: string[]; imageModel?: string }): Promise<void> {
  // User cancel: checked before every provider call (inside generateImage, which also cancels the running
  // prediction) and again before any result is written. Location data is left untouched; the caller's
  // refund pass returns the credits for every location whose master frame did not change.
  const canceled = () => isCancelRequested(jobId);
  const imageProvider = await loadProjectImageProvider(projectId); // Stage 73: transport provider only
  const gen = (input: Parameters<typeof generateImage>[0]) => generateImage(input, { jobId, imageModel, shouldCancel: canceled, provider: imageProvider });
  const CANCEL_MSG = "Generation canceled by the user";
  try {
    if (await canceled()) { await markCanceled(jobId, CANCEL_MSG); return; }
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
    await updateJob(jobId, { status: "processing", progress: pct(), message: `Generating ${total} location references…` });
    for (const loc of locations) {
      // Stage 11: stop before starting the next location. Finished references stay saved.
      if (await isCancelRequested(jobId)) {
        await markCanceled(jobId, `Canceled — done ${done} of ${total} locations`);
        return;
      }
      await updateJob(jobId, { progress: pct(), message: `Location reference "${loc.name}» (${done + 1}/${total})…` });
      try {
        const visual = loc.visualPrompt ?? loc.description ?? loc.name;
        // 1) wide establishing angle — the anchor for the light and the place
        const wideRemote = await gen({ prompt: locationAnglePrompt(visual, loc.name, "wide"), aspect_ratio: "9:16" });
        if (await canceled()) throw new GenerationCanceledError(); // discard the result, keep the old master
        const stamp = Date.now();
        const wideUrl = await uploadRemoteToS3(wideRemote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-${stamp}-wide.png`, "image/png");
        await prisma.location.update({ where: { id: loc.id }, data: { imageUrl: wideUrl, imageReverse: null, imageDetail: null, imageExtra: null } }); // new master → the old angles no longer match; re-shot from this frame
        await checkC2pa(loc.id, "wide", wideUrl);
        // Stage 46A: ONLY the master frame is generated here. Additional angles are requested one at a time
        // by the author ("+ Angle" → location_extra_image job), never automatically.
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) { await markCanceled(jobId, CANCEL_MSG); return; }
        failed += 1;
        console.error(`[location-images] failed for ${loc.name}:`, e?.message ?? e);
      }
      done += 1;
      await sleep(1500);
    }
    await completeJob(jobId, { total, failed, locationIds, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks }, failed > 0 ? `Done — ${failed} of ${total} failed` : "Location references are ready");
  } catch (err: any) {
    console.error("[location-images] failed:", err);
    await failJob(jobId, err?.message ?? "Location image generation failed");
  }
}
