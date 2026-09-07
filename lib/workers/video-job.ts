import { prisma } from "@/lib/db";
import { generateVideo } from "@/lib/replicate";
import { generateSpeech } from "@/lib/elevenlabs";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { getBucketConfig } from "@/lib/aws-config";
import { updateJob, completeJob, failJob } from "@/lib/jobs";

export interface VideoJobParams {
  jobId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  duration?: number;
  resolution?: string;
}

/**
 * Background video job (runs inside the same serverless invocation via `after()`).
 *
 * 1. Seedance video (silent — generate_audio: false)      → progress 60%
 * 2. ElevenLabs voiceover if the scene has dialogue        → progress 80%
 * 3. Upload both to S3, update the Scene row               → progress 95%
 * 4. Job completed with resultData { videoUrl, audioUrl }
 * On failure: scene status reset, credits refunded, job marked failed.
 */
export async function runVideoJob(params: VideoJobParams): Promise<void> {
  const { jobId, sceneId, projectId, userId } = params;
  const cost = Number(params.cost ?? 0);

  try {
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene?.videoPrompt) throw new Error("Scene has no video prompt");

    await updateJob(jobId, {
      status: "processing",
      progress: 5,
      message: "Generating video with Seedance (this takes ~3 min)...",
    });

    // 1. Video (silent)
    const replicateVideoUrl = await generateVideo({
      prompt: scene.videoPrompt,
      duration: Number(params.duration ?? 5),
      resolution: String(params.resolution ?? "480p"),
      aspect_ratio: "9:16",
      generate_audio: false, // voiceover is added via ElevenLabs
      watermark: false,
    });
    await updateJob(jobId, { progress: 60, message: "Video ready. Generating voiceover..." });

    // 2. Voiceover (optional, non-fatal)
    let audioBuffer: Buffer | null = null;
    const dialogue = (scene.dialogue ?? "").trim();
    if (dialogue) {
      try {
        audioBuffer = await generateSpeech(dialogue);
      } catch (ttsErr: any) {
        console.error("[video-job] ElevenLabs failed (video kept without audio):", ttsErr?.message ?? ttsErr);
      }
    }
    await updateJob(jobId, { progress: 80, message: "Uploading to storage..." });

    // 3. Upload + save
    const { folderPrefix } = getBucketConfig();
    const baseKey = `${folderPrefix}public/videos/${projectId}/${scene.episodeId}/scene-${scene.number}-${Date.now()}`;
    const videoUrl = await uploadRemoteToS3(replicateVideoUrl, `${baseKey}.mp4`, "video/mp4");
    let audioUrl: string | null = null;
    if (audioBuffer) {
      try {
        audioUrl = await uploadBufferToS3(audioBuffer, `${baseKey}.mp3`, "audio/mpeg");
      } catch (upErr: any) {
        console.error("[video-job] audio upload failed:", upErr?.message ?? upErr);
      }
    }
    await updateJob(jobId, { progress: 95, message: "Saving scene..." });

    const updated = await prisma.scene.update({
      where: { id: sceneId },
      data: { videoUrl, audioUrl, status: "generated" },
    });

    await completeJob(jobId, { videoUrl, audioUrl, scene: updated }, "Video ready");
  } catch (err: any) {
    console.error("[video-job] failed:", err);
    try {
      await prisma.scene.update({ where: { id: sceneId }, data: { status: "pending" } });
    } catch {}
    try {
      if (userId && cost > 0) {
        await prisma.user.update({ where: { id: userId }, data: { credits: { increment: cost } } });
        await prisma.creditTransaction.create({
          data: { userId, amount: cost, description: "Refund: video generation failed" },
        });
      }
    } catch {}
    await failJob(jobId, err?.message ?? "Video generation failed");
  }
}
