/**
 * Shared episode-stitch helper.
 *
 * Extracted from POST /api/ai/assemble-episode so the SAME stitch logic runs from:
 *   1. the background «Ассембл» job (episode_assemble) in /api/ai/assemble-episode/polish, and
 *   2. the standalone POST /api/ai/assemble-episode route (kept for backward compat).
 *
 * It downloads every scene clip, muxes voiceovers, joins them with local ffmpeg using the
 * default seamless hard cut (Stage 43: a straight cut with an invisible ~0.08s video/audio
 * micro-blend on the seam — no AI bridges, no visible dissolves; nothing is charged for the
 * join), uploads the result to S3 and stores `episode.videoUrl` + `status='assembled'`.
 *
 * Stage 46B: the FINAL file is rendered at the chosen production quality / fps (scenes are always
 * 480p), thematic background music is mixed in (mood via gpt-4o → MusicGen track cached per
 * project+mood), clips download in parallel and every real stage is reported through `onProgress`.
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
import { getOrCreateMusicTrack, type Mood } from "@/lib/music";
import {
  buildMusicPlan,
  mergeMoodSegments,
  limitMoods,
  toTimelineSegments,
  summarizePlan,
  countScenesWithoutMusic,
  type SceneMoodInput,
  type MoodSegment,
} from "@/lib/music-plan";

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
  /** Stage 79: the per-moment plan actually used (segments + scenes left silent), or null. */
  musicPlan: { segments: MoodSegment[]; scenesWithoutMusic: number } | null;
  /** Stage 79: Russian summary of the plan («напряжённая → загадочная (2 сегмента …)») or null. */
  musicSummary: string | null;
  /** Stage 79: Russian error when music could not be produced, or null. */
  musicError: string | null;
  /** Russian note for the UI («Музыка недоступна — собрано без музыки») or null. */
  note: string | null;
}

/** Stage 46B — progress budget per stage: download 0–30, music 30–40, join/render 40–90, upload 90–100. */
export function assembleStageProgress(ev: AssembleProgressEvent): { progress: number; message: string } {
  switch (ev.stage) {
    case "download": {
      const frac = ev.total > 0 ? ev.done / ev.total : 0;
      return { progress: Math.round(frac * 30), message: `Скачивание клипов ${ev.done}/${ev.total}` };
    }
    case "music":
      return { progress: 30, message: "Подбор музыки" };
    case "join":
      return { progress: 40, message: "Склейка" };
    case "render":
      return { progress: 40 + Math.round((Math.max(0, Math.min(100, ev.pct)) / 100) * 50), message: `Склейка ${Math.round(ev.pct)}%` };
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
    if (!episode) throw new Error("Эпизод не найден");

    const scenes = await prisma.scene.findMany({
      where: { episodeId },
      orderBy: { number: "asc" },
    });
    if (scenes.length === 0) throw new Error("В эпизоде нет сцен");
    if (scenes.some((s) => !validUrl(s.videoUrl)))
      throw new Error("Не все сцены имеют сгенерированное видео");

    const projectId = episode.season?.projectId ?? "unknown";
    let mood: Mood | null = null;
    let musicFailed = false;
    // Stage 79: per-moment thematic soundtrack — the plan (segments + silent scenes), its Russian
    // summary and any error are captured inside the resolveMusicSegments callback for the resultData.
    let planSegments: MoodSegment[] = [];
    let scenesWithoutMusic = 0;
    let musicSummary: string | null = null;
    let musicError: string | null = null;

    // Mux voiceovers + join with local ffmpeg (audio-preserving, default seamless hard cut), then
    // the final render at the chosen quality / fps with the per-moment thematic soundtrack (Stage 79).
    const result = await assembleEpisodeLocally(
      scenes.map((s) => ({
        videoUrl: s.videoUrl as string,
        audioUrl: s.audioUrl,
      })),
      {
        quality,
        fps,
        onProgress: report,
        resolveMusicSegments:
          opts.music === false
            ? undefined
            : async (dir, seamOffsets, totalDuration) => {
                try {
                  // 1. Per-scene mood plan (gpt-4o) → merged consecutive segments → cap at 3 moods.
                  const sceneInputs: SceneMoodInput[] = scenes.map((s, i) => ({
                    index: i,
                    action: s.action ?? undefined,
                    dialogue: s.dialogue ?? undefined,
                    kind: s.sceneKind ?? undefined,
                  }));
                  const perScene = await buildMusicPlan(sceneInputs, {
                    title: episode.title,
                    logline: episode.logline,
                    synopsis: episode.season?.project?.synopsis,
                  });
                  planSegments = limitMoods(mergeMoodSegments(perScene), 3);
                  scenesWithoutMusic = countScenesWithoutMusic(perScene);
                  musicSummary = summarizePlan(planSegments, scenesWithoutMusic);
                  mood = planSegments[0]?.mood ?? null;
                  if (planSegments.length === 0) return null; // every scene is "none" — no music

                  void opts.onProgress?.(30, `Подбор музыки: ${musicSummary}`);
                  // 2. One cached track per UNIQUE mood (parallel; the S3 cache is reused).
                  const uniqueMoods = [...new Set(planSegments.map((s) => s.mood))];
                  const moodFiles = new Map<Mood, string>();
                  await Promise.all(
                    uniqueMoods.map(async (m) => {
                      const url = await getOrCreateMusicTrack(projectId, m);
                      const local = path.join(dir, `music_${m}.mp3`);
                      await downloadToFile(url, local);
                      moodFiles.set(m, local);
                    })
                  );
                  // 3. Map segments onto the output timeline (seam offsets) → per-window inputs.
                  const timeline = toTimelineSegments(planSegments, seamOffsets, totalDuration);
                  return timeline.map((t) => ({
                    path: moodFiles.get(t.mood) as string,
                    startSec: t.startSec,
                    endSec: t.endSec,
                    intensity: t.intensity,
                  }));
                } catch (err) {
                  console.warn(`[assemble] ${episodeId}: music unavailable —`, (err as Error).message);
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
    void opts.onProgress?.(ASSEMBLE_UPLOAD_PROGRESS, "Загрузка");
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
      musicPlan: planSegments.length > 0 ? { segments: planSegments, scenesWithoutMusic } : null,
      musicSummary,
      musicError: musicFailed ? musicError ?? "неизвестная ошибка" : null,
      note: opts.music !== false && musicFailed ? "Музыка недоступна — собрано без музыки" : null,
    };
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
