export const dynamic = "force-dynamic";
export const maxDuration = 800; // per-scene audio mux + concatenation can take a while

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, assembleEpisodeSchema } from "@/lib/validations";
import { concatVideos, muxAudioIntoVideo } from "@/lib/replicate";
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

    const limited = rateLimitByUser(request, "ai:assemble-episode", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, assembleEpisodeSchema);
    if (!parsed.ok) return parsed.response;
    const { episodeId } = parsed.data;
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

    if (scenes.some((s) => !s.videoUrl))
      return NextResponse.json({ error: "Some scenes have no generated video" }, { status: 400 });

    // Native-audio mode: each clip already carries in-scene voices + ambience, so it is
    // used as-is (muxing a silent track would DROP that audio).
    // Legacy mode: a scene has a SILENT video (s.videoUrl) + separate ElevenLabs voiceover
    // (s.audioUrl); mux the voiceover in first. Dialogue-free legacy clips get a silent
    // track so every input to the concatenator has a uniform video+audio layout.
    const clipsWithAudio: string[] = [];
    for (const s of scenes) {
      if (s.audioUrl) {
        clipsWithAudio.push(await muxAudioIntoVideo(s.videoUrl as string, s.audioUrl));
      } else {
        clipsWithAudio.push(s.videoUrl as string);
      }
    }

    // Concatenate via Replicate (ffmpeg)
    const mergedUrl =
      clipsWithAudio.length === 1 ? clipsWithAudio[0] : await concatVideos(clipsWithAudio);

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
