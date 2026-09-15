/**
 * Shared episode-stitch helper.
 *
 * Extracted from POST /api/ai/assemble-episode so the SAME stitch logic runs from:
 *   1. the background "Assembly" job (episode_assemble) in /api/ai/assemble-episode/polish, and
 *   2. the standalone POST /api/ai/assemble-episode route (kept for backward compat).
 *
 * It downloads every scene clip, muxes voiceovers, joins them with local ffmpeg using the
 * default seamless hard cut (Stage 117: a frame-exact hard cut on both video and audio at every
 * seam — no blend, no edge fades, no AI bridges, no visible dissolves; nothing is charged for the
 * join), uploads the result to S3 and stores `episode.videoUrl` + `status='assembled'`.
 *
 * Stage 46B: the FINAL file is rendered at the chosen production quality / fps (scenes are always
 * 480p) and clips download in parallel, with every real stage reported through `onProgress`.
 * Stage 117: ONE background-music mood is chosen for the WHOLE episode (mood via gpt-4o →
 * MusicGen track cached per project+mood) and played as a single continuous looped track — a hard
 * start and only a minimal fade-out at the very finale, no per-scene mood changes or seam fades.
 */
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import {
  assembleEpisodeLocally,
  downloadToFile,
  DEFAULT_ASSEMBLE_FPS,
  DEFAULT_ASSEMBLE_QUALITY,
  type AssembleFps,
  type AssembleProgressEvent,
  type AssembleQuality,
} from "@/lib/ffmpeg";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { getOrCreateMusicTrack, pickMood, DEFAULT_MOOD, MOOD_LABELS, type Mood } from "@/lib/music";

/** Stage 117: one music segment spanning the whole episode (shape kept for the resultData / UI). */
interface EpisodeMoodSegment {
  mood: Mood;
  startSceneIndex: number;
  endSceneIndex: number;
  intensity: number;
}

const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;

export interface AssembleEpisodeOptions {
  quality?: AssembleQuality;
  fps?: AssembleFps;
  /** Mix thematic background music (default true). */
  music?: boolean;
  /** Real progress (0–100) + Russian stage message, for the job bar. */
  onProgress?: (progress: number, message: string) => void | Promise<void>;
}

export interface AssembleEpisodeResult {
  videoUrl: string;
  sceneCount: number;
  quality: AssembleQuality;
  fps: AssembleFps;
  mood: Mood | null;
  musicApplied: boolean;
  /** Stage 117: one segment covering the whole episode (single continuous mood), or null. */
  musicPlan: { segments: EpisodeMoodSegment[]; scenesWithoutMusic: number } | null;
  /** Stage 117: human-readable label of the single chosen mood, or null. */
  musicSummary: string | null;
  /** Stage 79: Russian error when music could not be produced, or null. */
  musicError: string | null;
  /** Russian note for the UI ("Music unavailable — assembled without music") or null. */
  note: string | null;
}

/** Stage 46B — progress budget per stage: download 0–30, music 30–40, join/render 40–90, upload 90–100. */
export function assembleStageProgress(ev: AssembleProgressEvent): { progress: number; message: string } {
  switch (ev.stage) {
    case "download": {
      const frac = ev.total > 0 ? ev.done / ev.total : 0;
      return { progress: Math.round(frac * 30), message: `Downloading clips ${ev.done}/${ev.total}` };
    }
    case "music":
      return { progress: 30, message: "Selecting music" };
    case "join":
      return { progress: 40, message: "Assembly" };
    case "render":
      return { progress: 40 + Math.round((Math.max(0, Math.min(100, ev.pct)) / 100) * 50), message: `Assembly ${Math.round(ev.pct)}%` };
  }
}
export const ASSEMBLE_UPLOAD_PROGRESS = 90;

/**
 * Stitch a fully-generated episode into one mp4.
 * Throws an Error (Russian message) on any precondition failure so callers can surface it.
 */
export async function assembleEpisodeVideo(episodeId: string, opts: AssembleEpisodeOptions = {}): Promise<AssembleEpisodeResult> {
  let workDir: string | null = null;
  const quality = opts.quality ?? DEFAULT_ASSEMBLE_QUALITY;
  const fps = opts.fps ?? DEFAULT_ASSEMBLE_FPS;
  const report = (ev: AssembleProgressEvent) => {
    const { progress, message } = assembleStageProgress(ev);
    void opts.onProgress?.(progress, message);
  };
  try {
    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { select: { projectId: true, project: { select: { synopsis: true } } } } },
    });
    if (!episode) throw new Error("Episode not found");

    const scenes = await prisma.scene.findMany({
      where: { episodeId },
      orderBy: { number: "asc" },
    });
    if (scenes.length === 0) throw new Error("There are no scenes in the episode");
    if (scenes.some((s) => !validUrl(s.videoUrl)))
      throw new Error("Not all scenes have generated video");

    const projectId = episode.season?.projectId ?? "unknown";
    let mood: Mood | null = null;
    let musicFailed = false;
    // Stage 117: ONE mood for the whole episode. The chosen mood, its label and any error are
    // captured inside the resolveMusic callback (a single continuous looped track) for the resultData.
    let musicSummary: string | null = null;
    let musicError: string | null = null;

    // Mux voiceovers + join with local ffmpeg (audio-preserving, default seamless hard cut), then
    // the final render at the chosen quality / fps with ONE continuous background-music track (Stage 117).
    const result = await assembleEpisodeLocally(
      scenes.map((s) => ({
        videoUrl: s.videoUrl as string,
        audioUrl: s.audioUrl,
      })),
      {
        quality,
        fps,
        onProgress: report,
        resolveMusic:
          opts.music === false
            ? undefined
            : async (dir) => {
                try {
                  // 1. Pick ONE mood for the WHOLE episode (gpt-4o; falls back to DEFAULT_MOOD).
                  mood = await pickMood({
                    title: episode.title,
                    logline: episode.logline,
                    synopsis: episode.season?.project?.synopsis,
                  });
                  musicSummary = MOOD_LABELS[mood];
                  void opts.onProgress?.(30, `Selecting music: ${musicSummary}`);
                  // 2. One cached track for that mood (reused from the S3 cache across assemblies),
                  //    played as a single continuous looped track over the entire episode.
                  const url = await getOrCreateMusicTrack(projectId, mood);
                  const local = path.join(dir, `music_${mood}.mp3`);
                  await downloadToFile(url, local);
                  return local;
                } catch (err) {
                  console.warn(`[assemble] ${episodeId}: music unavailable —`, (err as Error).message);
                  mood = mood ?? DEFAULT_MOOD;
                  musicFailed = true;
                  musicError = (err as Error).message;
                  return null;
                }
              },
      }
    );
    workDir = result.workDir;
    if (Boolean(mood) && !result.musicApplied) musicFailed = true;
    console.log(
      `[assemble] ${episodeId}: ${scenes.length} scenes, audio=${result.audioSources.join(",")}, ` +
        `duration=${result.info.duration.toFixed(1)}s, hasAudio=${result.info.hasAudio}, ${quality}/${fps}fps, ` +
        `music=${result.musicApplied ? musicSummary : "none"}`
    );

    // Persist to S3
    void opts.onProgress?.(ASSEMBLE_UPLOAD_PROGRESS, "Loading");
    const s3Key = `media/public/episodes/${projectId}/${episodeId}/episode_${Date.now()}.mp4`;
    const buffer = await fs.readFile(result.outputPath);
    const videoUrl = await uploadBufferToS3(buffer, s3Key, "video/mp4");

    await prisma.episode.update({
      where: { id: episodeId },
      data: { videoUrl, status: "assembled", assembleQuality: quality, assembleFps: fps },
    });

    return {
      videoUrl,
      sceneCount: scenes.length,
      quality,
      fps,
      mood,
      musicApplied: result.musicApplied,
      musicPlan:
        result.musicApplied && mood
          ? {
              segments: [
                { mood, startSceneIndex: 0, endSceneIndex: Math.max(0, scenes.length - 1), intensity: 1 },
              ],
              scenesWithoutMusic: 0,
            }
          : null,
      musicSummary,
      musicError: musicFailed ? musicError ?? "unknown error" : null,
      note: opts.music !== false && musicFailed ? "Music unavailable — assembled without music" : null,
    };
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
