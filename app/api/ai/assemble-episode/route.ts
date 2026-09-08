export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800; // download + per-scene audio mux + concatenation can take a while

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, assembleEpisodeSchema } from "@/lib/validations";
import { assembleEpisodeLocally } from "@/lib/ffmpeg";
import { parseDialogue } from "@/lib/voiceover";
import { uploadBufferToS3 } from "@/lib/s3-upload";

/** Clean a scene's dialogue into plain spoken text for the burned-in subtitle. */
function subtitleFor(dialogue: string | null | undefined): string {
  return parseDialogue(dialogue).map((l) => l.text).join(" ").trim();
}

/**
 * Assemble a full episode from all accepted scene videos (in scene order).
 *
 * New scenes carry Seedance native speech and ambience. Older scenes may retain
 * a separate audio asset in `scene.audioUrl`; assembly preserves that compatibility:
 *   1. muxes each scene's voiceover into its clip (clips without a voiceover keep their
 *      own audio if they have one, otherwise get a silent track) so every clip has a
 *      uniform video + AAC audio layout,
 *   2. concatenates the clips with local ffmpeg — the audio stream is verified to be
 *      present in the result,
 *   3. uploads the file to S3 and stores the URL on the episode.
 */
export async function POST(request: Request) {
  let workDir: string | null = null;
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

    // A scene is usable when it has a clip: accepted, generated, or text-revised ("pending") but still holding its last clip.
    if (scenes.some((s) => !s.videoUrl))
      return NextResponse.json({ error: "Some scenes have no generated video" }, { status: 400 });

    // Mux voiceovers + concatenate with local ffmpeg (audio-preserving).
    const result = await assembleEpisodeLocally(
      scenes.map((s) => ({
        videoUrl: s.videoUrl as string,
        audioUrl: s.audioUrl,
        subtitle: subtitleFor(s.dialogue),
      }))
    );
    workDir = result.workDir;
    console.log(
      `[assemble-episode] ${episodeId}: ${scenes.length} scenes, audio=${result.audioSources.join(",")}, ` +
        `duration=${result.info.duration.toFixed(1)}s, hasAudio=${result.info.hasAudio}`
    );

    // Persist to S3
    const projectId = episode.season?.projectId ?? "unknown";
    const s3Key = `media/public/episodes/${projectId}/${episodeId}/episode_${Date.now()}.mp4`;
    const buffer = await fs.readFile(result.outputPath);
    const videoUrl = await uploadBufferToS3(buffer, s3Key, "video/mp4");

    await prisma.episode.update({
      where: { id: episodeId },
      data: { videoUrl, status: "assembled" },
    });

    return NextResponse.json({ videoUrl, sceneCount: scenes.length });
  } catch (err: any) {
    console.error("Episode assembly error:", err);
    return NextResponse.json({ error: "Assembly failed" }, { status: 500 });
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
