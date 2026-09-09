import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob } from "@/lib/jobs";

import { characterImagePrompt, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";

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
    // Non-blocking C2PA diagnostic: confirm every stored reference keeps its
    // content-credentials metadata (so Seedance moderation never drops it).
    let c2paMissing = 0;
    const c2paChecks: { characterId: string; shot: Shot; ok: boolean; signatures: string[]; bytes: number }[] = [];
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
            prompt: characterImagePrompt(char.appearance ?? "", shot, char.name, char.tier, char.groupSize),
            aspect_ratio: ASPECT_RATIOS[shot],
          }, { jobId, characterId: char.id });
          // Seedream outputs PNG (with its C2PA content-credentials watermark). We upload the
          // raw bytes as-is — the watermark is intentionally kept (it can aid video moderation).
          const s3Key = `media/public/characters/${projectId}/${char.id}/${VISUAL_STYLE_ID}/${shot}-${Date.now()}.png`;
          const url = await uploadRemoteToS3(replicateUrl, s3Key, "image/png");
          await prisma.character.update({ where: { id: char.id }, data: { [SHOT_FIELDS[shot]]: url } });
          // Verify the STORED bytes still carry C2PA / content-credentials metadata.
          const c2pa = await detectC2paFromUrl(url);
          c2paChecks.push({ characterId: char.id, shot, ok: c2pa.ok, signatures: c2pa.signatures, bytes: c2pa.bytes });
          if (!c2pa.ok) {
            c2paMissing += 1;
            console.warn(`[images-job] C2PA metadata MISSING on stored ${shot} reference for ${char.name} (${url}) — Seedance moderation may drop it.`);
          }
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
      { total, failed, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks },
      failed > 0 ? `Done — ${failed} of ${total} images failed` : "All character images ready"
    );
  } catch (err: any) {
    console.error("[images-job] failed:", err);
    await failJob(jobId, err?.message ?? "Image generation failed");
  }
}
