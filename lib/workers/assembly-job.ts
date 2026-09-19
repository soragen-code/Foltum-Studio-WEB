/**
 * Stage 167 — SHOT-PIPELINE ASSEMBLY worker.
 *
 * The terminal step of the per-shot chain. Once the last shot of an episode has a generated clip
 * (video-job's `continueShotChain` calls this when `nextSequentialShot` returns null), this worker
 * turns the ordered per-shot clips into the ONE deliverable artifact — `Episode.videoUrl`:
 *
 *   1. load every Shot of the episode (joined to its scene for the global order + closing beat),
 *   2. buildConcatPlan(shots) — a pure readiness/order check; bail out if any shot is missing a clip,
 *   3. assembleEpisodeLocally(clips) — the SAME seamless-hard-cut join used by the scene assembler,
 *      with QUIET background music chosen by the episode's closing escalation beat (musicForBeat),
 *   4. buildSubtitleSpec → subtitleSpecToAss → burnSubtitlesFile — BURN the CENTERED dialogue
 *      subtitles (Alignment=2 = bottom-center; dialogueLanguage defaults to "en"),
 *   5. upload the subtitled mp4 to S3 and persist `Episode.videoUrl` + `status="assembled"`.
 *
 * The terminal artifact is Episode.videoUrl (NOT any per-scene video). Fully non-blocking: any failure
 * is logged and swallowed so the chain never crashes; the episode simply stays un-assembled and can be
 * retried. This is the shot-pipeline counterpart of lib/assemble.ts (which stitches whole scenes).
 */
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import {
  assembleEpisodeLocally,
  burnSubtitlesFile,
  downloadToFile,
  DEFAULT_ASSEMBLE_FPS,
  DEFAULT_ASSEMBLE_QUALITY,
} from "@/lib/ffmpeg";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { getOrCreateMusicTrack } from "@/lib/music";
import { getDialogueLanguage } from "@/lib/dialogue-language";
import {
  buildConcatPlan,
  buildSubtitleSpec,
  subtitleSpecToAss,
  musicForBeat,
} from "@/lib/shot-pipeline";
import type { PlannedShot } from "@/lib/prompts/shot-plan";

const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;

export interface AssemblyJobResult {
  ok: boolean;
  videoUrl?: string;
  shotCount: number;
  reason?: string;
}

/**
 * Assemble the per-shot clips of an episode into the final subtitled `Episode.videoUrl`.
 * Non-blocking: returns `{ ok: false, reason }` instead of throwing on any precondition/runtime failure.
 */
export async function runAssemblyJob(episodeId: string): Promise<AssemblyJobResult> {
  let workDir: string | null = null;
  try {
    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: {
        season: { select: { projectId: true, project: { select: { dialogueLanguage: true } } } },
        scenes: {
          orderBy: { number: "asc" },
          include: { shots: { orderBy: { index: "asc" } } },
        },
      },
    });
    if (!episode) return { ok: false, shotCount: 0, reason: "Episode not found" };

    // Flatten to an EPISODE-GLOBAL ordered shot list (scene number, then shot index within the scene).
    // Each shot carries its scene's number so the concat plan / subtitle timings run in play order.
    const ordered = episode.scenes
      .flatMap((scene) =>
        scene.shots.map((shot) => ({
          index: 0, // filled below with the global running index
          sceneNumber: scene.number,
          shotIndex: shot.index,
          duration: shot.duration ?? 0,
          postFx: (shot.postFx || "none") as PlannedShot["postFx"],
          line: shot.line ?? "",
          escalationBeat: shot.escalationBeat ?? "",
          videoUrl: shot.videoUrl ?? undefined,
          audioUrl: null as string | null,
        }))
      )
      .sort((a, b) => a.sceneNumber - b.sceneNumber || a.shotIndex - b.shotIndex)
      .map((s, i) => ({ ...s, index: i }));

    if (ordered.length === 0) return { ok: false, shotCount: 0, reason: "Episode has no shots" };

    // Pure readiness + order check: every shot must have a generated clip before we can assemble.
    const plan = buildConcatPlan(ordered);
    if (!plan.ready) {
      return { ok: false, shotCount: ordered.length, reason: "Not all shots have a generated clip yet" };
    }
    if (ordered.some((s) => !validUrl(s.videoUrl))) {
      return { ok: false, shotCount: ordered.length, reason: "A shot clip URL is invalid" };
    }

    const projectId = episode.season?.projectId ?? "unknown";
    const dialogueLanguage = getDialogueLanguage(episode.season?.project ?? null);
    // QUIET music mood is chosen from the episode's CLOSING beat (the last shot's escalation step).
    const closingBeat = ordered[ordered.length - 1]?.escalationBeat ?? "";
    const mood = musicForBeat(closingBeat);

    // 1. Join the per-shot clips (seamless hard cut, shots carry their own native audio) with a single
    //    continuous QUIET background-music track for the closing mood. Best-effort music (never fatal).
    const assembled = await assembleEpisodeLocally(
      ordered.map((s) => ({ videoUrl: s.videoUrl as string, audioUrl: s.audioUrl })),
      {
        quality: DEFAULT_ASSEMBLE_QUALITY,
        fps: DEFAULT_ASSEMBLE_FPS,
        resolveMusic: async (dir) => {
          try {
            const url = await getOrCreateMusicTrack(projectId, mood);
            const local = path.join(dir, `music_${mood}.mp3`);
            await downloadToFile(url, local);
            return local;
          } catch (err) {
            console.warn(`[assembly] ${episodeId}: music unavailable —`, (err as Error).message);
            return null;
          }
        },
      }
    );
    workDir = assembled.workDir;

    // 2. BURN the CENTERED dialogue subtitles (from the shot lines) over the joined video.
    let finalPath = assembled.outputPath;
    const spec = buildSubtitleSpec(ordered, { dialogueLanguage });
    if (spec.cues.length > 0) {
      try {
        const assPath = path.join(workDir, "subs.ass");
        await fs.writeFile(assPath, subtitleSpecToAss(spec), "utf8");
        const subbedPath = path.join(workDir, "episode_subbed.mp4");
        await burnSubtitlesFile(assembled.outputPath, assPath, subbedPath);
        finalPath = subbedPath;
      } catch (err) {
        // Subtitles are best-effort: a burn failure must not lose the assembled episode.
        console.warn(`[assembly] ${episodeId}: subtitle burn failed — using un-subtitled cut:`, (err as Error).message);
        finalPath = assembled.outputPath;
      }
    }

    // 3. Upload the final artifact and persist Episode.videoUrl (+ status="assembled").
    const s3Key = `media/public/episodes/${projectId}/${episodeId}/shots_${Date.now()}.mp4`;
    const buffer = await fs.readFile(finalPath);
    const videoUrl = await uploadBufferToS3(buffer, s3Key, "video/mp4");

    await prisma.episode.update({
      where: { id: episodeId },
      data: {
        videoUrl,
        status: "assembled",
        assembleQuality: DEFAULT_ASSEMBLE_QUALITY,
        assembleFps: DEFAULT_ASSEMBLE_FPS,
        chainRunActive: false,
      },
    });

    console.log(
      `[assembly] ${episodeId}: assembled ${ordered.length} shots → ${videoUrl} ` +
        `(mood=${mood}, subtitles=${spec.cues.length}, lang=${dialogueLanguage})`
    );
    return { ok: true, videoUrl, shotCount: ordered.length };
  } catch (err: any) {
    console.error(`[assembly] ${episodeId}: assembly failed —`, err?.message ?? err);
    return { ok: false, shotCount: 0, reason: err?.message ?? "assembly failed" };
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
