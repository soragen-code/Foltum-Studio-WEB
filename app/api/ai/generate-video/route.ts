export const dynamic = "force-dynamic";
export const maxDuration = 300; // Seedance can take a few minutes

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { generateVideo } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { getBucketConfig } from "@/lib/aws-config";

/**
 * Generate a scene video using Seedance 2.5 via Replicate.
 * 1. Deduct credits based on project tier
 * 2. Call Seedance 2.5 with the scene's videoPrompt
 * 3. Upload the generated video to S3
 * 4. Save the S3 URL to the scene record
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
      generate_audio: true,
      watermark: false,
    });

    // Upload to S3 for permanent storage
    const { folderPrefix } = getBucketConfig();
    const s3Key = `${folderPrefix}public/videos/${project.id}/${sceneData.episodeId}/scene-${sceneData.number}-${Date.now()}.mp4`;
    const videoUrl = await uploadRemoteToS3(replicateVideoUrl, s3Key, "video/mp4");

    // Save to DB
    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: { videoUrl, status: "generated" },
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
