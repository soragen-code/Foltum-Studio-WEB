import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob } from "@/lib/jobs";
import { locationImagePrompt, VISUAL_STYLE_ID } from "@/lib/visual-style";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Background job: one photoreal 9:16 PNG reference per location (Seedream, C2PA kept),
 * uploaded to S3 and written to Location.imageUrl. Job type "location_image".
 */
export async function runLocationImagesJob({ jobId, projectId, locationIds }: { jobId: string; projectId: string; locationIds: string[] }): Promise<void> {
  try {
    const locations = await prisma.location.findMany({ where: { id: { in: locationIds }, projectId }, orderBy: { createdAt: "asc" } });
    const total = locations.length;
    let done = 0;
    let failed = 0;
    const pct = () => 5 + Math.round((done / Math.max(total, 1)) * 95);
    await updateJob(jobId, { status: "processing", progress: pct(), message: `Генерация ${total} референсов локаций…` });
    for (const loc of locations) {
      await updateJob(jobId, { progress: pct(), message: `Референс локации «${loc.name}» (${done + 1}/${total})…` });
      try {
        const replicateUrl = await generateImage({ prompt: locationImagePrompt(loc.visualPrompt ?? loc.description ?? loc.name, loc.name), aspect_ratio: "9:16" }, { jobId });
        const s3Key = `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-${Date.now()}.png`;
        const url = await uploadRemoteToS3(replicateUrl, s3Key, "image/png");
        await prisma.location.update({ where: { id: loc.id }, data: { imageUrl: url } });
      } catch (e: any) {
        failed += 1;
        console.error(`[location-images] failed for ${loc.name}:`, e?.message ?? e);
      }
      done += 1;
      await sleep(1500);
    }
    await completeJob(jobId, { total, failed, locationIds }, failed > 0 ? `Готово — ${failed} из ${total} не удалось` : "Референсы локаций готовы");
  } catch (err: any) {
    console.error("[location-images] failed:", err);
    await failJob(jobId, err?.message ?? "Location image generation failed");
  }
}
