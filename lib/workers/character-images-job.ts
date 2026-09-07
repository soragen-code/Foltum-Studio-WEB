import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob } from "@/lib/jobs";

const SHOTS = ["front", "profile", "full"] as const;
type Shot = (typeof SHOTS)[number];
const ASPECT_RATIOS: Record<Shot, string> = { front: "3:4", profile: "3:4", full: "9:16" };
const SHOT_LABELS: Record<Shot, string> = { front: "front portrait", profile: "side profile", full: "full-body shot" };
const SHOT_FIELDS: Record<Shot, "imageFront" | "imageProfile" | "imageFull"> = {
  front: "imageFront",
  profile: "imageProfile",
  full: "imageFull",
};

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Build a FLUX prompt for a specific shot type */
function imagePrompt(appearance: string, shotType: Shot): string {
  const base = `Cinematic character portrait, dramatic lighting, dark moody atmosphere, film still quality. Character: ${appearance}.`;
  switch (shotType) {
    case "front":
      return `${base} Close-up front view, facing camera directly, eye contact, shallow depth of field, studio portrait.`;
    case "profile":
      return `${base} Side profile view, dramatic rim lighting, silhouette edge, cinematic composition.`;
    case "full":
      return `${base} Full body shot, standing pose, environmental portrait, wide angle, atmospheric background.`;
  }
}

export interface CharacterImagesJobParams {
  jobId: string;
  projectId: string;
  characterIds: string[];
}

/**
 * Background job: generates the 3 reference images per character sequentially,
 * writing each URL to the Character row and updating job progress after every image.
 * Runs inside the same serverless invocation via `after()`.
 */
export async function runCharacterImagesJob({ jobId, projectId, characterIds }: CharacterImagesJobParams): Promise<void> {
  try {
    const characters = await prisma.character.findMany({
      where: { id: { in: characterIds }, projectId },
      orderBy: { createdAt: "asc" },
    });

    const total = characters.length * SHOTS.length;
    let done = 0;
    let failed = 0;
    // Progress: 5% reserved for the text step already done, 5..100 for images
    const pct = () => 5 + Math.round((done / Math.max(total, 1)) * 95);

    await updateJob(jobId, { status: "processing", progress: pct(), message: `Generating ${total} character images...` });

    for (const char of characters) {
      for (const shot of SHOTS) {
        await updateJob(jobId, {
          progress: pct(),
          message: `Generating ${SHOT_LABELS[shot]} for ${char.name} (${done + 1}/${total})...`,
        });
        try {
          const replicateUrl = await generateImage({
            prompt: imagePrompt(char.appearance ?? "", shot),
            aspect_ratio: ASPECT_RATIOS[shot],
          });
          const s3Key = `media/public/characters/${projectId}/${char.id}/${shot}.webp`;
          const url = await uploadRemoteToS3(replicateUrl, s3Key, "image/webp");
          await prisma.character.update({ where: { id: char.id }, data: { [SHOT_FIELDS[shot]]: url } });
        } catch (imgErr: any) {
          failed += 1;
          console.error(`[images-job] ${shot} failed for ${char.name}:`, imgErr?.message ?? imgErr);
        }
        done += 1;
        await sleep(1500); // be gentle with Replicate rate limits
      }
    }

    await completeJob(
      jobId,
      { total, failed },
      failed > 0 ? `Done — ${failed} of ${total} images failed` : "All character images ready"
    );
  } catch (err: any) {
    console.error("[images-job] failed:", err);
    await failJob(jobId, err?.message ?? "Image generation failed");
  }
}
