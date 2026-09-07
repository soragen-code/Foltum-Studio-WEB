export const dynamic = "force-dynamic";
export const maxDuration = 300; // video concatenation can take a while

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { concatVideos } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";

/**
 * Assemble a full episode by concatenating all accepted scene videos
 * (in scene order) via Replicate's ffmpeg model, then store in S3.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { episodeId } = await request.json();
    if (!episodeId)
      return NextResponse.json({ error: "Episode ID required" }, { status: 400 });

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { select: { projectId: true } } },
    });
    if (!episode)
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });

    const scenes = await prisma.scene.findMany({
      where: { episodeId },
      orderBy: { number: "asc" },
    });
    if (scenes.length === 0)
      return NextResponse.json({ error: "Episode has no scenes" }, { status: 400 });

    const allAccepted = scenes.every((s) => s.status === "accepted");
    if (!allAccepted)
      return NextResponse.json({ error: "All scenes must be accepted first" }, { status: 400 });

    const videoUrls = scenes.map((s) => s.videoUrl).filter((u): u is string => !!u);
    if (videoUrls.length !== scenes.length)
      return NextResponse.json({ error: "Some scenes have no generated video" }, { status: 400 });

    // Concatenate via Replicate (ffmpeg)
    const mergedUrl =
      videoUrls.length === 1 ? videoUrls[0] : await concatVideos(videoUrls);

    // Persist to S3
    const projectId = episode.season?.projectId ?? "unknown";
    const s3Key = `media/public/episodes/${projectId}/${episodeId}/episode_${Date.now()}.mp4`;
    const videoUrl = await uploadRemoteToS3(mergedUrl, s3Key, "video/mp4");

    await prisma.episode.update({
      where: { id: episodeId },
      data: { videoUrl },
    });

    return NextResponse.json({ videoUrl, sceneCount: scenes.length });
  } catch (err: any) {
    console.error("Episode assembly error:", err);
    return NextResponse.json({ error: "Assembly failed" }, { status: 500 });
  }
}
