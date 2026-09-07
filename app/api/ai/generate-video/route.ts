export const dynamic = "force-dynamic";
export const maxDuration = 300; // Seedance can take a few minutes

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { generateVideo } from "@/lib/replicate";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { generateSpeech } from "@/lib/elevenlabs";
import { getBucketConfig } from "@/lib/aws-config";

/**
 * Generate a scene video using Seedance 2.5 via Replicate.
 * 1. Deduct credits based on project tier
 * 2. Call Seedance 2.5 with the scene's videoPrompt (generate_audio: false —
 *    Seedance's own audio track triggers copyright rejections)
 * 3. If the scene has dialogue, generate a voiceover via ElevenLabs TTS
 * 4. Upload video (and voiceover) to S3
 * 5. Save both URLs to the scene record; the frontend plays them in sync
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { projectId, sceneId } = await request.json();

    const project = await prisma.project.findFirst({ where: { id: projectId } });
    if (!project)
      return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // Tier determines credit cost AND video quality
    const tierConfig: Record<string, { cost: number; duration: number; resolution: string }> = {
      minimum: { cost: 1, duration: 5, resolution: "480p" },
      medium: { cost: 3, duration: 5, resolution: "720p" },
      maximum: { cost: 8, duration: 10, resolution: "720p" },
    };
    const config = tierConfig[project.tier] ?? tierConfig.minimum;

    if ((user.credits ?? 0) < config.cost) {
      return NextResponse.json(
        { error: `Not enough credits. Need ${config.cost}, have ${user.credits ?? 0}` },
        { status: 400 }
      );
    }

    const sceneData = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!sceneData)
      return NextResponse.json({ error: "Scene not found" }, { status: 404 });

    if (!sceneData.videoPrompt)
      return NextResponse.json({ error: "Scene has no video prompt" }, { status: 400 });

    // Mark as generating
    await prisma.scene.update({ where: { id: sceneId }, data: { status: "generating" } });

    // Deduct credits
    await prisma.user.update({
      where: { id: user.id },
      data: { credits: { decrement: config.cost } },
    });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -config.cost,
        description: `Video generation for scene ${sceneData.number} (${project.tier} tier)`,
      },
    });

    // Generate video via Seedance 2.5
    const replicateVideoUrl = await generateVideo({
      prompt: sceneData.videoPrompt,
      duration: config.duration,
      resolution: config.resolution,
      aspect_ratio: "9:16", // vertical drama format
      generate_audio: false, // silent video — voiceover is added via ElevenLabs
      watermark: false,
    });

    // Upload to S3 for permanent storage
    const { folderPrefix } = getBucketConfig();
    const stamp = Date.now();
    const baseKey = `${folderPrefix}public/videos/${project.id}/${sceneData.episodeId}/scene-${sceneData.number}-${stamp}`;
    const videoUrl = await uploadRemoteToS3(replicateVideoUrl, `${baseKey}.mp4`, "video/mp4");

    // Voiceover via ElevenLabs (only when the scene has dialogue).
    // A TTS failure must not lose the already-generated (and paid for) video.
    let audioUrl: string | null = null;
    const dialogue = (sceneData.dialogue ?? "").trim();
    if (dialogue) {
      try {
        const audioBuffer = await generateSpeech(dialogue);
        audioUrl = await uploadBufferToS3(audioBuffer, `${baseKey}.mp3`, "audio/mpeg");
      } catch (ttsErr: any) {
        console.error("ElevenLabs voiceover failed (video kept without audio):", ttsErr?.message ?? ttsErr);
      }
    }

    // Save to DB
    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: { videoUrl, audioUrl, status: "generated" },
    });

    return NextResponse.json({ scene, creditsRemaining: (user.credits ?? 0) - config.cost });
  } catch (err: any) {
    console.error("Video generation error:", err);

    // Try to reset scene status on failure
    try {
      const { sceneId } = await request.clone().json();
      if (sceneId) {
        await prisma.scene.update({ where: { id: sceneId }, data: { status: "pending" } });
      }
    } catch {}

    return NextResponse.json({ error: "Video generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
