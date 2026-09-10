/**
 * Shared episode-stitch helper.
 *
 * Extracted from POST /api/ai/assemble-episode so the SAME stitch logic runs from:
 *   1. the background «Ассембл» job (episode_assemble) in /api/ai/assemble-episode/polish, and
 *   2. the standalone POST /api/ai/assemble-episode route (kept for backward compat).
 *
 * It downloads every scene clip, muxes voiceovers, joins them with local ffmpeg —
 * smoothing every scene seam with an AI-synthesized FILM frame-interpolation bridge so
 * the episode reads as one continuous take — uploads the result to S3 and stores
 * `episode.videoUrl` + `status='assembled'`.
 */
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { assembleEpisodeLocally } from "@/lib/ffmpeg";
import { uploadBufferToS3 } from "@/lib/s3-upload";

const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;

/**
 * Stitch a fully-generated episode into one mp4.
 * Throws an Error (Russian message) on any precondition failure so callers can surface it.
 */
export async function assembleEpisodeVideo(episodeId: string): Promise<{ videoUrl: string; sceneCount: number }> {
  let workDir: string | null = null;
  try {
    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { select: { projectId: true } } },
    });
    if (!episode) throw new Error("Эпизод не найден");

    const scenes = await prisma.scene.findMany({
      where: { episodeId },
      orderBy: { number: "asc" },
    });
    if (scenes.length === 0) throw new Error("В эпизоде нет сцен");
    if (scenes.some((s) => !validUrl(s.videoUrl)))
      throw new Error("Не все сцены имеют сгенерированное видео");

    // Mux voiceovers + concatenate with local ffmpeg (audio-preserving).
    const result = await assembleEpisodeLocally(
      scenes.map((s) => ({
        videoUrl: s.videoUrl as string,
        audioUrl: s.audioUrl,
      }))
    );
    workDir = result.workDir;
    console.log(
      `[assemble] ${episodeId}: ${scenes.length} scenes, audio=${result.audioSources.join(",")}, ` +
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

    return { videoUrl, sceneCount: scenes.length };
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
