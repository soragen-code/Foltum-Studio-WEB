/**
 * Local ffmpeg helpers (server-side, via the `ffmpeg-static` binary).
 *
 * Used by episode assembly: every scene clip gets a UNIFORM audio track
 * (ElevenLabs voiceover if present, otherwise the clip's own audio, otherwise
 * silence), then all clips are concatenated. Doing this locally — instead of
 * through a remote ffmpeg model — guarantees the final file keeps its audio
 * stream; the previous remote concatenation silently dropped it.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Resolve the ffmpeg binary: env override → ffmpeg-static → PATH. */
function getFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require("ffmpeg-static") as string | null;
    if (p) return p;
  } catch {
    /* fall through */
  }
  return "ffmpeg";
}

async function runFfmpeg(args: string[], label: string): Promise<string> {
  const bin = getFfmpegPath();
  try {
    const { stderr } = await execFileAsync(bin, ["-hide_banner", "-nostdin", "-y", ...args], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    return stderr ?? "";
  } catch (err: any) {
    const tail = String(err?.stderr ?? err?.message ?? "").split("\n").slice(-12).join("\n");
    throw new Error(`ffmpeg ${label} failed: ${tail}`);
  }
}

/** Download a remote file to disk. */
export async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export interface MediaInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  /** Container duration in seconds (0 if unknown). */
  duration: number;
}

/** Probe a media file using ffmpeg's `-i` listing (ffmpeg-static ships no ffprobe). */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const bin = getFfmpegPath();
  let out = "";
  try {
    const { stderr } = await execFileAsync(bin, ["-hide_banner", "-nostdin", "-i", file], {
      maxBuffer: 8 * 1024 * 1024,
    });
    out = stderr ?? "";
  } catch (err: any) {
    // ffmpeg exits non-zero when no output is specified — the stream listing is still in stderr.
    out = String(err?.stderr ?? "");
  }
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  return {
    hasVideo: /Stream #\d+:\d+.*?: Video:/.test(out),
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(out),
    duration,
  };
}

export interface SceneClipInput {
  videoUrl: string;
  /** Separate voiceover (e.g. ElevenLabs mp3). Takes priority over the clip's own audio. */
  audioUrl?: string | null;
}

export interface AssembleResult {
  /** Path to the assembled mp4 (inside `workDir`). */
  outputPath: string;
  /** Temp directory holding all intermediates — remove when done. */
  workDir: string;
  /** Per-scene audio source actually used, for logging/diagnostics. */
  audioSources: Array<"voiceover" | "native" | "silence">;
  info: MediaInfo;
}

/**
 * Build one uniform clip: video stream copied, audio always present as AAC 44.1kHz stereo.
 * - voiceover present  → mux the voiceover (clip's native audio, if any, is ignored)
 * - no voiceover       → keep native audio if the clip has one, else add a silent track
 * Audio is trimmed to the video length so scene timing stays intact.
 */
async function normalizeClip(
  videoPath: string,
  audioPath: string | null,
  outPath: string
): Promise<"voiceover" | "native" | "silence"> {
  const audioArgs = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"];
  const info = await probeMedia(videoPath);
  // Clip length is dictated by the VIDEO: a shorter voiceover is padded with silence
  // (`apad`), a longer one is cut at the video end (`-t`). Never `-shortest` alone — it
  // would truncate the video to a short voiceover.
  const lengthArgs = info.duration > 0 ? ["-t", info.duration.toFixed(3)] : ["-shortest"];

  if (audioPath) {
    await runFfmpeg(
      [
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0", "-map", "1:a:0",
        "-af", "apad",
        "-c:v", "copy", ...audioArgs,
        ...lengthArgs,
        "-movflags", "+faststart",
        outPath,
      ],
      "mux voiceover"
    );
    return "voiceover";
  }

  if (info.hasAudio) {
    await runFfmpeg(
      ["-i", videoPath, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", ...audioArgs, "-movflags", "+faststart", outPath],
      "normalize native audio"
    );
    return "native";
  }

  await runFfmpeg(
    [
      "-i", videoPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", ...audioArgs,
      "-shortest",
      "-movflags", "+faststart",
      outPath,
    ],
    "add silent track"
  );
  return "silence";
}

/**
 * Concatenate uniform clips. First try a lossless stream copy (fast — clips come from the
 * same generator with identical encoding); if that fails, re-encode via the concat filter.
 */
async function concatClips(clips: string[], workDir: string, outPath: string): Promise<void> {
  const listPath = path.join(workDir, "concat.txt");
  const escape = (p: string) => p.replace(/'/g, "'\\''");
  await fs.writeFile(listPath, clips.map((c) => `file '${escape(c)}'`).join("\n") + "\n");

  try {
    await runFfmpeg(
      ["-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", outPath],
      "concat (copy)"
    );
    const info = await probeMedia(outPath);
    if (info.hasVideo && info.hasAudio) return;
    console.warn("[ffmpeg] concat copy produced no audio/video stream — re-encoding");
  } catch (err) {
    console.warn("[ffmpeg] concat copy failed — re-encoding:", (err as Error).message);
  }

  const inputs = clips.flatMap((c) => ["-i", c]);
  const filter =
    clips.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("") + `concat=n=${clips.length}:v=1:a=1[v][a]`;
  await runFfmpeg(
    [
      ...inputs,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart",
      outPath,
    ],
    "concat (re-encode)"
  );
}

/**
 * Download all scene clips (+ voiceovers), give every clip a uniform audio track and
 * concatenate them in order. Caller must `fs.rm(result.workDir, { recursive: true })`.
 */
export async function assembleEpisodeLocally(scenes: SceneClipInput[]): Promise<AssembleResult> {
  if (scenes.length === 0) throw new Error("No scenes to assemble");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "episode-"));

  const audioSources: AssembleResult["audioSources"] = [];
  const normalized: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const idx = String(i + 1).padStart(3, "0");
    const videoPath = path.join(workDir, `scene_${idx}.mp4`);
    await downloadToFile(s.videoUrl, videoPath);

    let audioPath: string | null = null;
    if (s.audioUrl) {
      audioPath = path.join(workDir, `scene_${idx}_voice.audio`);
      await downloadToFile(s.audioUrl, audioPath);
    }

    const outPath = path.join(workDir, `clip_${idx}.mp4`);
    audioSources.push(await normalizeClip(videoPath, audioPath, outPath));
    normalized.push(outPath);

    // Free disk early — /tmp on serverless is limited.
    await fs.rm(videoPath, { force: true });
    if (audioPath) await fs.rm(audioPath, { force: true });
  }

  const outputPath = path.join(workDir, "episode.mp4");
  if (normalized.length === 1) {
    await fs.copyFile(normalized[0], outputPath);
  } else {
    await concatClips(normalized, workDir, outputPath);
  }

  const info = await probeMedia(outputPath);
  if (!info.hasVideo) throw new Error("Assembled episode has no video stream");
  if (!info.hasAudio) throw new Error("Assembled episode has no audio stream");

  return { outputPath, workDir, audioSources, info };
}
