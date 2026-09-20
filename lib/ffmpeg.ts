/**
 * Local ffmpeg helpers (server-side, via the `ffmpeg-static` binary).
 *
 * Used by episode assembly: every scene clip gets a UNIFORM audio track
 * (legacy separate audio if present, otherwise the clip's own audio, otherwise
 * silence), then all clips are joined. Doing this locally — instead of
 * through a remote ffmpeg model — guarantees the final file keeps its audio
 * stream; the previous remote concatenation silently dropped it.
 *
 * Stage 43 — DEFAULT join mode is the «seamless hard cut» (`seamlessCutClips`): a plain
 * editorial cut. Stage 117: the seam is a FRAME-EXACT hard cut on both video and audio — the clips
 * are joined with `concat=n=N:v=1:a=1`, no xfade, no acrossfade, no edge fades. The visible-dissolve
 * (`crossfadeClips`) path is kept but only used when explicitly requested via `AssembleOptions.mode`.
 * (Stage 104: the old FILM-bridge path and its remote frame-interpolation dependency were removed — a
 * seam is always a hard cut.)
 */
import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  ASSEMBLE_DIMENSIONS, ASSEMBLE_FPS, ASSEMBLE_QUALITIES, DEFAULT_ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY,
  type AssembleFps, type AssembleQuality,
} from "./assemble-options";

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

async function runFfmpeg(args: string[], label: string, opts?: { cwd?: string }): Promise<string> {
  const bin = getFfmpegPath();
  try {
    const { stderr } = await execFileAsync(bin, ["-hide_banner", "-nostdin", "-y", ...args], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    return stderr ?? "";
  } catch (err: any) {
    const tail = String(err?.stderr ?? err?.message ?? "").split("\n").slice(-12).join("\n");
    throw new Error(`ffmpeg ${label} failed: ${tail}`);
  }
}

/**
 * Stage 46B — run ffmpeg with `-progress pipe:1` and report REAL render progress (0–100 % of
 * `totalSec`) through `onPct`. Used for the final episode render so the job bar shows how far the
 * encode actually is instead of a timer.
 */
export async function runFfmpegWithProgress(
  args: string[],
  label: string,
  totalSec: number,
  onPct?: (pct: number) => void
): Promise<void> {
  const bin = getFfmpegPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", ...args]);
    let stderr = "";
    let stdoutBuf = "";
    let lastPct = -1;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.stderr.on("data", (d) => { stderr += String(d); if (stderr.length > 64_000) stderr = stderr.slice(-32_000); });
    child.stdout.on("data", (d) => {
      stdoutBuf += String(d);
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const sec = parseProgressLine(line);
        if (sec === null || totalSec <= 0) continue;
        const pct = Math.max(0, Math.min(100, Math.round((sec / totalSec) * 100)));
        if (pct !== lastPct) { lastPct = pct; onPct?.(pct); }
      }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(new Error(`ffmpeg ${label} failed: ${err.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) { if (lastPct !== 100) onPct?.(100); resolve(); }
      else reject(new Error(`ffmpeg ${label} failed: ${stderr.split("\n").slice(-12).join("\n")}`));
    });
  });
}

/** Parse one `-progress` key=value line into seconds of output written (null for other keys). */
export function parseProgressLine(line: string): number | null {
  const ms = line.match(/^out_time_us=(\d+)/) ?? line.match(/^out_time_ms=(\d+)/);
  if (ms) return Number(ms[1]) / 1_000_000;
  const t = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (t) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  return null;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Download a remote file to disk. */
export async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Extract the LAST frame of a video as a JPEG buffer.
 *
 * Used for one-take frame-chaining: the last frame of scene N is fed to Seedance as the
 * first-frame (`image`) of scene N+1, so the next clip starts exactly where the previous
 * one ended and the whole episode reads as a single continuous take.
 *
 * `-sseof -1` seeks to the last second and `-update 1` keeps overwriting the output with
 * each decoded frame, so the file left on disk is the very last frame of the clip.
 */
export async function extractLastFrameBuffer(videoUrl: string): Promise<Buffer> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "lastframe-"));
  const videoPath = path.join(workDir, "src.mp4");
  const outPath = path.join(workDir, "last.jpg");
  try {
    await downloadToFile(videoUrl, videoPath);
    // Try the fast seek-from-end approach first.
    try {
      await runFfmpeg(
        ["-sseof", "-1", "-i", videoPath, "-update", "1", "-q:v", "2", "-frames:v", "1", outPath],
        "extract last frame (sseof)"
      );
    } catch {
      // Fallback: reverse the last chunk and grab its first frame.
      await runFfmpeg(
        ["-i", videoPath, "-vf", "reverse", "-q:v", "2", "-frames:v", "1", outPath],
        "extract last frame (reverse)"
      );
    }
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract the FIRST frame of a video as a JPEG buffer.
 *
 * Counterpart of extractLastFrameBuffer (diagnostics / tests).
 */
export async function extractFirstFrameBuffer(videoUrl: string): Promise<Buffer> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "firstframe-"));
  const videoPath = path.join(workDir, "src.mp4");
  const outPath = path.join(workDir, "first.jpg");
  try {
    await downloadToFile(videoUrl, videoPath);
    await runFfmpeg(["-i", videoPath, "-frames:v", "1", "-q:v", "2", outPath], "extract first frame");
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface MediaInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  /** Container duration in seconds (0 if unknown) — max of the video/audio streams. Kept for compatibility. */
  duration: number;
  /**
   * Stage 78: duration of the VIDEO stream itself (0 if unknown). Seedance clips often carry an audio
   * track a few hundred ms longer than the picture; cutting on the container duration then leaves a
   * frozen last frame on every seam. The seamless-cut graph and normalizeClip use THIS value.
   */
  videoDuration: number;
  /** Video geometry / frame rate (0 if unknown). */
  width: number;
  height: number;
  fps: number;
}

/** Resolve an ffprobe binary: env override → PATH. Returns null when none is configured (ffmpeg-static ships no ffprobe). */
function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

/**
 * Stage 78 — duration of the first VIDEO stream. Primary: `ffprobe -select_streams v:0 -show_entries
 * stream=duration,nb_frames,r_frame_rate` (stream duration, else nb_frames / r_frame_rate). Fallback when
 * ffprobe is missing / fails / returns 0: decode the video stream with ffmpeg (`-an -f null -`) and read the
 * final `time=` progress stamp — exact, and available wherever ffmpeg-static is. Returns 0 when unknown.
 */
export async function probeVideoDuration(file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=duration,nb_frames,r_frame_rate",
      "-of", "json", file,
    ], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout || "{}");
    const st = parsed?.streams?.[0] ?? {};
    const d = Number(st.duration);
    if (Number.isFinite(d) && d > 0) return d;
    const nb = Number(st.nb_frames);
    const [num, den] = String(st.r_frame_rate ?? "").split("/").map(Number);
    if (nb > 0 && num > 0 && den > 0) return nb / (num / den);
  } catch {
    /* ffprobe unavailable — fall through to the ffmpeg decode */
  }
  try {
    let out = "";
    try {
      const { stderr } = await execFileAsync(getFfmpegPath(), ["-hide_banner", "-nostdin", "-i", file, "-map", "0:v:0", "-an", "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
      out = stderr ?? "";
    } catch (err: any) {
      out = String(err?.stderr ?? "");
    }
    const stamps = [...out.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const last = stamps[stamps.length - 1];
    if (last) return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  } catch {
    /* unknown */
  }
  return 0;
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
  const videoLine = out.match(/Stream #\d+:\d+.*?: Video:.*$/m)?.[0] ?? "";
  const dim = videoLine.match(/[ ,](\d{2,5})x(\d{2,5})(?:[ ,\[]|$)/);
  const fpsM = videoLine.match(/(\d+(?:\.\d+)?)\s*fps/);
  const hasVideo = videoLine.length > 0;
  // Stage 78: the video stream length (falls back to the container duration when it cannot be measured).
  const measured = hasVideo ? await probeVideoDuration(file) : 0;
  const videoDuration = measured > 0 ? measured : duration;
  return {
    hasVideo,
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(out),
    duration,
    videoDuration,
    width: dim ? Number(dim[1]) : 0,
    height: dim ? Number(dim[2]) : 0,
    fps: fpsM ? Number(fpsM[1]) : 0,
  };
}

export interface SceneClipInput {
  videoUrl: string;
  /** Separate voiceover (e.g. uploaded audio). Takes priority over the clip's own audio. */
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
  /** Stage 46B: production settings actually rendered. */
  quality: AssembleQuality;
  fps: AssembleFps;
  /** Stage 46B: true when background music was mixed into the file. */
  musicApplied: boolean;
}

/** Stage 78: default constant frame rate of the normalized clips when the source fps is unknown. */
export const NORMALIZE_DEFAULT_FPS = 24;

/**
 * Build one uniform clip: video re-encoded to a CONSTANT frame rate (Stage 78 — the seam math needs
 * exact, frame-aligned durations; `-c:v copy` kept variable-rate timestamps and let a frozen tail
 * frame survive at the cut), audio always present as AAC 44.1kHz stereo.
 * - voiceover present  → mux the voiceover (clip's native audio, if any, is ignored)
 * - no voiceover       → keep native audio if the clip has one, else add a silent track
 * Audio is cut to EXACTLY the video-stream length (`-t videoDuration`, apad when shorter) so an audio
 * track that outlives the picture can never stretch the clip with a held frame.
 */
async function normalizeClip(
  videoPath: string,
  audioPath: string | null,
  outPath: string,
  targetFps?: number
): Promise<"voiceover" | "native" | "silence"> {
  const audioArgs = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"];
  const info = await probeMedia(videoPath);
  const fps = targetFps && targetFps > 0 ? Math.round(targetFps) : info.fps > 0 ? Math.round(info.fps) : NORMALIZE_DEFAULT_FPS;
  const videoArgs = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), "-vsync", "cfr"];
  // Clip length is dictated by the VIDEO STREAM: a shorter voiceover / native track is padded with
  // silence (`apad`), a longer one is cut at the video end (`-t`). Never `-shortest` alone — it
  // would truncate the video to a short voiceover.
  const videoLen = info.videoDuration > 0 ? info.videoDuration : info.duration;
  const lengthArgs = videoLen > 0 ? ["-t", videoLen.toFixed(3)] : ["-shortest"];

  if (audioPath) {
    await runFfmpeg(
      [
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0", "-map", "1:a:0",
        "-af", "apad",
        ...videoArgs, ...audioArgs,
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
      ["-i", videoPath, "-map", "0:v:0", "-map", "0:a:0", "-af", "apad", ...videoArgs, ...audioArgs, ...lengthArgs, "-movflags", "+faststart", outPath],
      "normalize native audio"
    );
    return "native";
  }

  await runFfmpeg(
    [
      "-i", videoPath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-map", "0:v:0", "-map", "1:a:0",
      ...videoArgs, ...audioArgs,
      ...(videoLen > 0 ? lengthArgs : ["-shortest"]),
      "-movflags", "+faststart",
      outPath,
    ],
    "add silent track"
  );
  return "silence";
}

/**
 * Blend length between consecutive shots, in seconds. Kept SHORT (a match-cut, not an
 * obvious dissolve): with frame-chaining the last frame of one clip already matches the
 * first frame of the next, so a tiny 0.2s blend hides the seam and the episode reads as
 * one continuous take rather than a slideshow of dissolves.
 */
export const TRANSITION_SEC = 0.2;

/**
 * Join uniform clips with smooth dissolves: N clips → N-1 chained `xfade=transition=fade`
 * filters on video and matching `acrossfade` filters on audio. Every input is first
 * normalized to the geometry / frame rate of the first clip (xfade requires identical
 * size, fps and timebase). Each transition overlaps the clips by `fade` seconds, so the
 * k-th transition starts at `sum(d_0..d_{k-1}) - k * fade`.
 */
async function crossfadeClips(
  clips: string[],
  infos: MediaInfo[],
  outPath: string,
  fade: number
): Promise<void> {
  const n = clips.length;
  const ref = infos[0];
  const w = ref.width || 720;
  const h = ref.height || 1280;
  const fps = ref.fps > 0 ? Math.round(ref.fps) : 24;

  // Never let a transition eat more than half of the shortest shot.
  const minDur = Math.min(...infos.map((i) => i.duration).filter((d) => d > 0));
  const d = Math.max(0.1, Math.min(fade, (Number.isFinite(minDur) ? minDur : fade) / 2));

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,settb=AVTB[v${i}]`
    );
    parts.push(`[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
  }

  let vPrev = "v0";
  let aPrev = "a0";
  let elapsed = infos[0].duration;
  for (let i = 1; i < n; i++) {
    const offset = Math.max(0, elapsed - d);
    const vOut = i === n - 1 ? "vout" : `vx${i}`;
    const aOut = i === n - 1 ? "aout" : `ax${i}`;
    parts.push(`[${vPrev}][v${i}]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`);
    parts.push(`[${aPrev}][a${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${aOut}]`);
    vPrev = vOut;
    aPrev = aOut;
    elapsed = elapsed + infos[i].duration - d;
  }

  await runFfmpeg(
    [
      ...clips.flatMap((c) => ["-i", c]),
      "-filter_complex", parts.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart",
      outPath,
    ],
    "xfade crossfade"
  );
}

/**
 * Fallback: hard-cut concatenation of uniform clips. First try a lossless stream copy;
 * if that fails, re-encode via the concat filter.
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

/* ------------------------------------------------------------------ */
/*  Stage 43 — seamless hard cut (default join mode)                    */
/* ------------------------------------------------------------------ */

/** How consecutive scene clips are joined into an episode. */
export type StitchMode = "seamless-cut" | "crossfade" | "concat";
/** Default: a straight editorial cut — a frame-exact hard cut on both video and audio (no blend). */
export const DEFAULT_STITCH_MODE: StitchMode = "seamless-cut";

/**
 * Length of the micro-blend on every seam, in seconds — Stage 43 constant kept for compatibility
 * (hard limits still enforced by scripts/test-stage43.ts). Stage 78 no longer blends the VIDEO at all:
 * the seam is a frame-exact hard cut (`concat`), because even a 2-frame xfade held the previous clip's
 * final frame over the seam and read as a freeze. Stage 117: the audio is a hard cut too (no edge
 * afades — see SEAM_AUDIO_FADE_SEC = 0), so the audio and video timelines stay exactly the same length.
 * HARD LIMIT: must stay ≤ 0.12s (video) and ≤ 0.08s (audio) — see scripts/test-stage43.ts.
 */
export const SEAMLESS_BLEND_SEC = 0.08;
export const SEAMLESS_BLEND_MAX_VIDEO_SEC = 0.12;
export const SEAMLESS_BLEND_MAX_AUDIO_SEC = 0.08;

/**
 * Stage 78 — seconds trimmed from the TAIL of every clip except the last. Seedance clips end on a
 * settled / frozen beat (the model "lands" its last frame and the audio outlives the picture); cutting
 * ~0.35 s early makes the cut land mid-motion. Skipped for clips that would drop below 1.0 s.
 */
export const SEAM_TAIL_TRIM_SEC = 0.35;
/** Stage 78 — minimum clip length that still gets a tail trim. */
export const SEAM_TAIL_TRIM_MIN_CLIP_SEC = 1.0;
/**
 * Stage 117 — the seam audio fade is REMOVED: every clip-to-clip transition is a frame-exact HARD
 * cut on BOTH video and audio (no afade at the tails / heads). Kept as an exported constant (= 0) so
 * the seam builder and its callers stay signature-compatible; a non-zero value would re-enable the
 * old edge afades. (Stage 78 used 0.03 s; the user asked for hard cuts with no fades on transitions.)
 */
export const SEAM_AUDIO_FADE_SEC = 0;

export interface SeamlessCutGraph {
  /** ffmpeg `-filter_complex` string; outputs are `[vout]` and `[aout]`. */
  filter: string;
  /** Video blend actually used on every seam (s). Stage 78: always 0 — hard cut. */
  blend: number;
  /** Stage 78: edge afade length (s) on each side of a seam (audio is not overlapped). */
  audioFade: number;
  /** Stage 78: tail trim (s) applied to the non-last clips (0 when disabled). */
  tailTrimSec: number;
  /** Stage 78: effective per-clip durations after the tail trim (same order as the inputs). */
  clipDurations: number[];
  /** Expected output duration: sum(clipDurations). */
  expectedDuration: number;
  /** Seam positions in the OUTPUT timeline (the cut instants), for markers / music offsets. */
  seamOffsets: number[];
  width: number;
  height: number;
  fps: number;
}

export interface SeamlessCutGraphOptions {
  /** Tail trim per non-last clip (s). Default SEAM_TAIL_TRIM_SEC; 0 disables. */
  tailTrimSec?: number;
  /** Video blend (s). Stage 78: ignored — the cut is always hard (kept for signature compatibility). */
  videoBlend?: number;
}

/** Duration of a clip as the seam math sees it: the VIDEO stream, falling back to the container. */
function seamClipDuration(i: MediaInfo): number {
  return i.videoDuration > 0 ? i.videoDuration : i.duration;
}

/**
 * Pure builder for the seamless-cut filtergraph (unit-testable, no ffmpeg run).
 * Stage 78: every input is normalized to the geometry / fps / timebase of the first clip; every clip
 * except the LAST is trimmed by `tailTrimSec` at the tail (only when the remainder stays ≥ 1.0 s) and
 * the PTS are re-based. Stage 117: the audio is a HARD cut too — with SEAM_AUDIO_FADE_SEC = 0 no afade
 * is emitted at any seam; the streams are joined with `concat=n=N:v=1:a=1` — a frame-exact hard cut,
 * no xfade, no acrossfade, so the audio and video are exactly the same length. The k-th seam sits at
 * `sum(clipDurations[0..k-1])` in the output. `blend` (video) is reported as 0.
 * Signature-compatible with Stage 43: `(infos, blend?, opts?)` — `blend` is accepted and ignored.
 */
export function buildSeamlessCutGraph(
  infos: MediaInfo[],
  _blend: number = SEAMLESS_BLEND_SEC,
  opts: SeamlessCutGraphOptions = {}
): SeamlessCutGraph {
  const n = infos.length;
  if (n < 2) throw new Error("buildSeamlessCutGraph needs at least 2 clips");
  const ref = infos[0];
  const w = ref.width || 720;
  const h = ref.height || 1280;
  const fps = ref.fps > 0 ? Math.round(ref.fps) : 24;
  const tailTrim = Math.max(0, opts.tailTrimSec ?? SEAM_TAIL_TRIM_SEC);
  const fade = SEAM_AUDIO_FADE_SEC;

  // Effective durations: trim the tail of every clip but the last when the clip stays ≥ 1.0 s.
  const clipDurations = infos.map((info, i) => {
    const dur = seamClipDuration(info);
    if (i === n - 1 || tailTrim <= 0 || dur <= 0) return dur;
    const trimmed = dur - tailTrim;
    return trimmed >= SEAM_TAIL_TRIM_MIN_CLIP_SEC ? trimmed : dur;
  });

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const dur = clipDurations[i];
    const trimmed = i !== n - 1 && tailTrim > 0 && dur > 0 && dur < seamClipDuration(infos[i]);
    const vTrim = trimmed ? `trim=0:${dur.toFixed(3)},` : "";
    const aTrim = trimmed ? `atrim=0:${dur.toFixed(3)},` : "";
    parts.push(
      `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},${vTrim}setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[v${i}]`
    );
    // Stage 117 — HARD cut on the audio too: with `fade === 0` no afade is emitted at any seam, so
    // clips butt straight up against each other (same as the video). A non-zero SEAM_AUDIO_FADE_SEC
    // would restore the old edge fades (fade-in on every head but the first, fade-out on every tail
    // but the last, starting `fade` seconds before the trimmed end).
    const fadeIn = fade > 0 && i > 0 ? `afade=t=in:st=0:d=${fade.toFixed(3)},` : "";
    const fadeOut = fade > 0 && i < n - 1 && dur > fade
      ? `afade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade.toFixed(3)},`
      : "";
    parts.push(
      `[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,${aTrim}asetpts=PTS-STARTPTS,${fadeIn}${fadeOut}anull[a${i}]`
    );
  }
  const seamOffsets: number[] = [];
  let elapsed = 0;
  for (let i = 0; i < n - 1; i++) {
    elapsed += clipDurations[i];
    seamOffsets.push(Number(elapsed.toFixed(6)));
  }
  const expectedDuration = Number(clipDurations.reduce((a, d) => a + d, 0).toFixed(6));
  const inputs = infos.map((_, i) => `[v${i}][a${i}]`).join("");
  parts.push(`${inputs}concat=n=${n}:v=1:a=1[vout][aout]`);
  return {
    filter: parts.join(";"),
    blend: 0,
    audioFade: fade,
    tailTrimSec: tailTrim,
    clipDurations,
    expectedDuration,
    seamOffsets,
    width: w,
    height: h,
    fps,
  };
}

/**
 * Join uniform clips with a seamless hard cut (Stage 78): tail-trimmed clips, frame-exact `concat`,
 * edge afades on the audio, constant frame rate on the output. No bridge frames are synthesized.
 */
async function seamlessCutClips(clips: string[], infos: MediaInfo[], outPath: string): Promise<SeamlessCutGraph> {
  const g = buildSeamlessCutGraph(infos);
  await runFfmpeg(
    [
      ...clips.flatMap((c) => ["-i", c]),
      "-filter_complex", g.filter,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(g.fps), "-vsync", "cfr",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart",
      outPath,
    ],
    "seamless hard cut"
  );
  return g;
}

/**
 * Local helper for manual checks on real clips: join a list of mp4 FILES (already on disk)
 * into `outPath` with the default seamless hard cut. Each clip is first normalized (uniform
 * AAC audio; a silent track is added when a clip has none), then joined.
 * Example: npx tsx --tsconfig tsconfig.json -e 'import("./lib/ffmpeg").then(m => m.stitchLocalClipsSeamless(["a.mp4","b.mp4","c.mp4"], "out.mp4").then(r => console.log(r)))'
 */
export async function stitchLocalClipsSeamless(
  files: string[],
  outPath: string
): Promise<{ outputPath: string; info: MediaInfo; blend: number; expectedDuration: number; seamOffsets: number[] }> {
  if (files.length === 0) throw new Error("No clips to stitch");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "stitch-"));
  try {
    const normalized: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const out = path.join(workDir, `clip_${String(i + 1).padStart(3, "0")}.mp4`);
      await normalizeClip(path.resolve(files[i]), null, out);
      normalized.push(out);
    }
    const infos = await Promise.all(normalized.map((c) => probeMedia(c)));
    let blend = 0;
    let expectedDuration = infos.reduce((a, i) => a + (i.videoDuration > 0 ? i.videoDuration : i.duration), 0);
    let seamOffsets: number[] = [];
    if (normalized.length === 1) {
      await fs.copyFile(normalized[0], outPath);
    } else {
      const g = await seamlessCutClips(normalized, infos, outPath);
      blend = g.blend;
      expectedDuration = g.expectedDuration;
      seamOffsets = g.seamOffsets;
    }
    const info = await probeMedia(outPath);
    return { outputPath: outPath, info, blend, expectedDuration, seamOffsets };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/*  Assembly options                                                   */
/* ------------------------------------------------------------------ */

export interface AssembleOptions {
  /**
   * Join mode. Default "seamless-cut" (Stage 43): a frame-exact hard cut on video and audio, no AI
   * bridges, no visible dissolves. "crossfade" = visible 0.2s dissolves, "concat" = raw hard cut.
   */
  mode?: StitchMode;
  /** Stage 46B: production quality of the FINAL episode file (scenes themselves are always 480p). Default "480p". */
  quality?: AssembleQuality;
  /** Stage 46B: frame rate of the final file. Default 30. */
  fps?: AssembleFps;
  /** Stage 46B: how many clips download in parallel. Default DOWNLOAD_CONCURRENCY. */
  downloadConcurrency?: number;
  /**
   * Stage 46B: called after the clips are on disk — returns a local path to a background music
   * file (any ffmpeg-readable format; it is looped and trimmed to the episode) or null for no music.
   * Throwing is treated as "no music".
   */
  resolveMusic?: (workDir: string) => Promise<string | null>;
  /**
   * Stage 79: per-moment thematic soundtrack. Called AFTER the clips are joined, with the seam
   * positions in the OUTPUT timeline and the total duration; returns one entry per timeline segment
   * ({ local music path, startSec, endSec, intensity }) or null. When it returns a non-empty array
   * the SEGMENTED, ducked mix is used; otherwise the single `resolveMusic` path applies. Throwing is
   * treated as "no music". Backward compatible: absent → nothing changes.
   */
  resolveMusicSegments?: (
    workDir: string,
    seamOffsets: number[],
    totalDuration: number
  ) => Promise<Array<{ path: string; startSec: number; endSec: number; intensity: number }> | null>;
  /** Stage 46B: real progress events for the job bar. */
  onProgress?: (event: AssembleProgressEvent) => void;
}

/* ------------------------------------------------------------------ */
/*  Stage 46B — final render (quality / fps / background music)         */
/* ------------------------------------------------------------------ */

// Quality / fps option lists live in the pure, client-safe `lib/assemble-options.ts`.
export {
  ASSEMBLE_QUALITIES, ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY, DEFAULT_ASSEMBLE_FPS, ASSEMBLE_DIMENSIONS,
  isAssembleQuality, isAssembleFps, type AssembleQuality, type AssembleFps,
} from "./assemble-options";
export const DOWNLOAD_CONCURRENCY = 4;

export type AssembleProgressEvent =
  | { stage: "download"; done: number; total: number }
  | { stage: "music" }
  | { stage: "join"; pct: number }
  | { stage: "render"; pct: number };

/**
 * Stage 117 — the single continuous track no longer fades IN (it starts hard together with the first
 * cut); a short fade-out remains ONLY at the very END of the episode (the finale, not a scene seam) so
 * the loop doesn't click off. This finale fade is a global start/end trim, never a clip-to-clip fade.
 */
export const MUSIC_FINAL_FADEOUT_SEC = 1.5;

/**
 * Stage 145 — background-music level under the clip audio for the single continuous track.
 * Lowered from the historical 0.18 so the music sits as a quiet bed and the English dialogue stays
 * clearly audible. Linear ffmpeg `volume` multiplier (≈ -20 dB).
 */
export const MUSIC_BED_VOLUME = 0.09;

/**
 * Stage 145 — sidechain ducking of the music bed under the clip's speech (single-track path). The
 * music signal is pushed further down whenever the voice (sidechain key) is present and released back
 * up in the speech gaps. Mirrors the segmented soundtrack ducking (buildMusicSegmentsMixFilter) so
 * both assembly paths behave the same. Policy unchanged: still ONE music track, hard cuts — only the
 * LEVEL and the ducking change, never the track composition.
 */
export const MUSIC_DUCK_THRESHOLD = 0.03; // voice level (linear) above which the music starts ducking
export const MUSIC_DUCK_RATIO = 8;        // how hard the music is pushed down while speech is present
export const MUSIC_DUCK_ATTACK = 20;      // ms — how fast the music dips when speech starts
export const MUSIC_DUCK_RELEASE = 300;    // ms — how fast the music recovers in speech gaps

export interface MusicMixOptions {
  /** Episode length in seconds — music is trimmed to it. */
  durationSec: number;
  /** Music gain under the clip audio. Default MUSIC_BED_VOLUME (a quiet bed). */
  volume?: number;
  /** Seconds. Stage 117 default 0 (hard music start, no fade-in). */
  fadeIn?: number;
  /** Seconds. Stage 117 default MUSIC_FINAL_FADEOUT_SEC (a minimal fade only at the episode finale). */
  fadeOut?: number;
}

/**
 * Pure: filtergraph mixing looped background music (input 1) under the clip audio (input 0).
 * Music: trimmed to the episode, gain `volume` (Stage 145: MUSIC_BED_VOLUME — a quiet bed); clip
 * audio stays primary (`duration=first`, no normalisation). Stage 145: the music bed is additionally
 * ducked under the clip's speech with `sidechaincompress` — the clip audio is split into a main copy
 * and a sidechain key, the music is compressed whenever the voice is present, then the main clip audio
 * is mixed back on top so dialogue is always clearly audible and the music dips only under speech.
 * Output label `[aout]`. Stage 117: NO fade-in on the seams or the start — the one continuous track
 * begins hard; a short fade-out is applied ONLY at the very finale (0-safe: afade is omitted entirely
 * when a fade value is 0, so the music can also start/stop as a pure hard cut). Policy unchanged: one
 * music track, hard cuts — only the level and the ducking differ from earlier stages.
 */
export function buildMusicMixFilter(opts: MusicMixOptions): string {
  const dur = Math.max(0.1, opts.durationSec);
  const volume = opts.volume ?? MUSIC_BED_VOLUME;
  const fadeIn = Math.min(Math.max(0, opts.fadeIn ?? 0), dur / 2);
  const fadeOut = Math.min(Math.max(0, opts.fadeOut ?? MUSIC_FINAL_FADEOUT_SEC), dur / 2);
  const fadeOutStart = Math.max(0, dur - fadeOut);
  const fades =
    (fadeIn > 0 ? `,afade=t=in:st=0:d=${fadeIn.toFixed(2)}` : "") +
    (fadeOut > 0 ? `,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(2)}` : "");
  const aformat = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
  return (
    `[1:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,${aformat},` +
    `volume=${volume}${fades}[m];` +
    `[0:a]${aformat},asplit=2[c][ckey];` +
    `[m][ckey]sidechaincompress=threshold=${MUSIC_DUCK_THRESHOLD}:ratio=${MUSIC_DUCK_RATIO}:` +
    `attack=${MUSIC_DUCK_ATTACK}:release=${MUSIC_DUCK_RELEASE}[ducked];` +
    `[c][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
  );
}

/** Stage 79 — one music segment placed on the output timeline. */
export interface MusicSegmentInput {
  /** Local music file for this segment's mood (looped by ffmpeg). */
  path: string;
  /** Segment window in the output timeline (seconds). */
  startSec: number;
  endSec: number;
  /** 0..1 — scales the music level (see buildMusicSegmentsMixFilter). */
  intensity: number;
}

/** Convert a dB gain to a linear ffmpeg `volume` multiplier. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Stage 79 — nominal music level (dB) at full intensity, scaled DOWN by (1 - intensity) is NOT used;
 *  the level in dB is `MUSIC_SEGMENT_DB * intensity` (see spec: linear value of -18 dB * intensity). */
export const MUSIC_SEGMENT_DB = -18;

export interface MusicSegmentsMixOptions {
  segments: MusicSegmentInput[];
  /** True when input 0 carries dialogue/native audio to duck under (and preserve). */
  hasVoice: boolean;
  /** Episode length in seconds. */
  totalDuration: number;
}

/**
 * PURE (Stage 79) — filtergraph for the per-moment SEGMENTED soundtrack. Input 0 is the joined
 * episode (its audio = the voice/dialogue track). Music segment i is ffmpeg input i+1 (each fed with
 * `-stream_loop -1` so it repeats). Per segment: `atrim` to the window length, `afade` in/out 1 s,
 * `volume` = the LINEAR value of (MUSIC_SEGMENT_DB × intensity) dB, `adelay` startSec×1000 on both
 * channels. All segments are `amix`-ed into one bed; when `hasVoice` the bed is ducked under the
 * voice with `sidechaincompress` and the voice is mixed back on top; otherwise the bed is the output.
 * Output label: `[aout]`.
 */
export function buildMusicSegmentsMixFilter(opts: MusicSegmentsMixOptions): string {
  const total = Math.max(0.1, opts.totalDuration);
  const segs = opts.segments;
  const parts: string[] = [];
  const aformat = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
  segs.forEach((seg, i) => {
    const inputIdx = i + 1;
    const len = Math.max(0.1, Math.min(seg.endSec, total) - Math.max(0, seg.startSec));
    const fadeIn = Math.min(1, len / 2);
    const fadeOut = Math.min(1, len / 2);
    const fadeOutStart = Math.max(0, len - fadeOut);
    const lin = dbToLinear(MUSIC_SEGMENT_DB * Math.max(0, Math.min(1, seg.intensity)));
    const delayMs = Math.round(Math.max(0, seg.startSec) * 1000);
    parts.push(
      `[${inputIdx}:a]${aformat},atrim=0:${len.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)},` +
        `volume=${lin.toFixed(4)},adelay=${delayMs}|${delayMs}[m${i}]`
    );
  });
  const musicLabels = segs.map((_, i) => `[m${i}]`).join("");
  parts.push(`${musicLabels}amix=inputs=${segs.length}:duration=longest:dropout_transition=0:normalize=0[musicMixed]`);

  if (opts.hasVoice) {
    parts.push(`[0:a]${aformat},asplit=2[vmain][vkey]`);
    parts.push(
      `[musicMixed][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked]`
    );
    parts.push(`[vmain][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    parts.push(`[musicMixed]anull[aout]`);
  }
  return parts.join(";");
}

export interface FinalRenderOptions {
  input: string;
  output: string;
  quality: AssembleQuality;
  fps: AssembleFps;
  /** Local music file (looped) or null. */
  musicPath?: string | null;
  /** Stage 79: per-moment segmented soundtrack; takes precedence over `musicPath` when non-empty. */
  musicSegments?: MusicSegmentInput[] | null;
  /** Stage 79: whether the joined episode has a voice/native audio track to duck + preserve. Default true. */
  hasVoice?: boolean;
  /** Episode length (needed for the music trim / fades). */
  durationSec: number;
}

/**
 * Pure: ffmpeg args for the FINAL episode render.
 *   480p/30 without music → `-c copy` (no re-encode at all);
 *   480p/30 with music    → `-c:v copy` + audio mix (`-c:a aac`), video untouched;
 *   any other quality/fps → scale/pad to the 9:16 geometry, `fps=` filter + `-r`, libx264.
 * `reencodesVideo` tells the caller (and tests) which path was taken.
 */
export function buildFinalRenderArgs(o: FinalRenderOptions): { args: string[]; reencodesVideo: boolean; reencodesAudio: boolean } {
  const isNative = o.quality === "480p" && o.fps === 30;
  // Stage 79: segmented soundtrack takes precedence over the single-track path when non-empty.
  const segments = o.musicSegments && o.musicSegments.length > 0 ? o.musicSegments : null;
  const hasMusic = !segments && Boolean(o.musicPath);
  const hasVoice = o.hasVoice !== false;
  const { width, height } = ASSEMBLE_DIMENSIONS[o.quality];
  const musicInputs = segments
    ? segments.flatMap((s) => ["-stream_loop", "-1", "-i", s.path])
    : hasMusic
      ? ["-stream_loop", "-1", "-i", o.musicPath as string]
      : [];
  const inputs = ["-i", o.input, ...musicInputs];
  const audioEnc = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"];
  const tail = ["-movflags", "+faststart", o.output];

  if (isNative && !hasMusic && !segments) {
    return { args: [...inputs, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", ...tail], reencodesVideo: false, reencodesAudio: false };
  }
  const anyMusic = hasMusic || Boolean(segments);
  const filters: string[] = [];
  if (!isNative) {
    filters.push(
      `[0:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${o.fps},format=yuv420p[vout]`
    );
  }
  if (segments) filters.push(buildMusicSegmentsMixFilter({ segments, hasVoice, totalDuration: o.durationSec }));
  else if (hasMusic) filters.push(buildMusicMixFilter({ durationSec: o.durationSec }));
  const videoMap = isNative ? ["-map", "0:v:0", "-c:v", "copy"] : ["-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(o.fps)];
  const audioMap = anyMusic ? ["-map", "[aout]", ...audioEnc] : ["-map", "0:a:0", ...(isNative ? ["-c:a", "copy"] : audioEnc)];
  const args = [
    ...inputs,
    ...(filters.length ? ["-filter_complex", filters.join(";")] : []),
    ...videoMap,
    ...audioMap,
    "-t", Math.max(0.1, o.durationSec).toFixed(3),
    ...tail,
  ];
  return { args, reencodesVideo: !isNative, reencodesAudio: anyMusic || !isNative };
}

/**
 * Download all scene clips (+ voiceovers), give every clip a uniform audio track and join
 * them into one episode. Default mode (Stage 43) is the seamless hard cut — a frame-exact hard
 * cut on both video and audio at every seam (no blend, no edge fades), no AI bridges. Legacy modes
 * ("crossfade", "concat") are selectable via `opts.mode`.
 * Caller must `fs.rm(result.workDir, { recursive: true })`.
 */
export async function assembleEpisodeLocally(scenes: SceneClipInput[], opts: AssembleOptions = {}): Promise<AssembleResult> {
  if (scenes.length === 0) throw new Error("No scenes to assemble");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "episode-"));

  // Stage 46B: clips are downloaded + normalized in parallel (cap `downloadConcurrency`), with a
  // real «k/N» progress event after each one.
  let downloaded = 0;
  opts.onProgress?.({ stage: "download", done: 0, total: scenes.length });
  const concurrency = opts.downloadConcurrency ?? DOWNLOAD_CONCURRENCY;
  // Stage 78: download first, then normalize every clip to ONE constant frame rate (the first clip's,
  // fallback 24) — the seam math needs frame-aligned, identical-rate inputs.
  const downloadedFiles = await mapWithConcurrency(scenes, concurrency, async (s, i) => {
    const idx = String(i + 1).padStart(3, "0");
    const videoPath = path.join(workDir, `scene_${idx}.mp4`);
    await downloadToFile(s.videoUrl, videoPath);
    let audioPath: string | null = null;
    if (s.audioUrl) {
      audioPath = path.join(workDir, `scene_${idx}_voice.audio`);
      await downloadToFile(s.audioUrl, audioPath);
    }
    return { idx, videoPath, audioPath };
  });
  const firstInfo = await probeMedia(downloadedFiles[0].videoPath);
  const targetFps = firstInfo.fps > 0 ? Math.round(firstInfo.fps) : NORMALIZE_DEFAULT_FPS;
  const prepared = await mapWithConcurrency(downloadedFiles, concurrency, async ({ idx, videoPath, audioPath }) => {
    const outPath = path.join(workDir, `clip_${idx}.mp4`);
    const source = await normalizeClip(videoPath, audioPath, outPath, targetFps);

    // Free disk early — /tmp on serverless is limited.
    await fs.rm(videoPath, { force: true });
    if (audioPath) await fs.rm(audioPath, { force: true });
    downloaded += 1;
    opts.onProgress?.({ stage: "download", done: downloaded, total: scenes.length });
    return { outPath, source };
  });
  const audioSources: AssembleResult["audioSources"] = prepared.map((p) => p.source);
  const normalized: string[] = prepared.map((p) => p.outPath);

  // Stage 46B: background music is resolved once the clips are local (mood → generate / cached track).
  let musicPath: string | null = null;
  if (opts.resolveMusic) {
    opts.onProgress?.({ stage: "music" });
    try {
      musicPath = await opts.resolveMusic(workDir);
    } catch (err) {
      console.warn("[ffmpeg] background music unavailable — assembling without music:", (err as Error).message);
      musicPath = null;
    }
  }

  // Probe every normalized clip up-front — needed for the crossfade math.
  const infos = await Promise.all(normalized.map((c) => probeMedia(c)));

  const joinedPath = path.join(workDir, "joined.mp4");
  const mode: StitchMode = opts.mode ?? DEFAULT_STITCH_MODE;
  // Stage 79: seam positions in the OUTPUT timeline (scene boundaries) — needed to map the
  // per-moment music plan onto the assembled episode. Populated by the seamless-cut graph; for the
  // other join modes it is approximated below from the clip durations.
  let seamOffsets: number[] = [];
  opts.onProgress?.({ stage: "join", pct: 0 });
  if (normalized.length === 1) {
    await fs.copyFile(normalized[0], joinedPath);
  } else if (mode === "seamless-cut") {
    // DEFAULT (Stage 43): a frame-exact hard cut on both video and audio at the seam (no blend,
    // no edge fades). No FILM call, no visible dissolve. If it fails for any reason → hard concat.
    try {
      const g = await seamlessCutClips(normalized, infos, joinedPath);
      seamOffsets = g.seamOffsets;
      console.log(`[ffmpeg] seamless cut: ${normalized.length} clips, hard cut (blend=0), tailTrim=${g.tailTrimSec.toFixed(2)}s, audioFade=${g.audioFade.toFixed(3)}s, expected=${g.expectedDuration.toFixed(2)}s`);
    } catch (err) {
      console.warn("[ffmpeg] seamless cut failed — falling back to hard concat:", (err as Error).message);
      await fs.rm(joinedPath, { force: true });
      await concatClips(normalized, workDir, joinedPath);
    }
  } else if (mode === "concat") {
    await concatClips(normalized, workDir, joinedPath);
  } else {
    // Legacy mode "crossfade": visible 0.2s dissolves, best-effort. Assembly ALWAYS completes.
    try {
      await crossfadeClips(normalized, infos, joinedPath, TRANSITION_SEC);
    } catch (err) {
      // Crossfade is best-effort: never fail the whole assembly because of a transition.
      console.warn("[ffmpeg] xfade failed — falling back to hard cuts:", (err as Error).message);
      await fs.rm(joinedPath, { force: true });
      await concatClips(normalized, workDir, joinedPath);
    }
  }

  // No subtitles are burned in: the clips carry Seedance native speech.
  // Stage 46B — FINAL render: only here the episode is scaled to the chosen quality / fps and the
  // background music is mixed in. 480p/30 without music is a pure stream copy.
  const joinedInfo = await probeMedia(joinedPath);
  const quality = opts.quality ?? DEFAULT_ASSEMBLE_QUALITY;
  const fps = opts.fps ?? DEFAULT_ASSEMBLE_FPS;
  const outputPath = path.join(workDir, "episode.mp4");

  // Stage 79: per-moment thematic soundtrack. Resolve the timeline segments AFTER the join, once the
  // seam offsets and the real total duration are known. A non-empty result takes precedence over the
  // single-track `musicPath`; any failure falls through to the single track (then to no music).
  let musicSegments: MusicSegmentInput[] | null = null;
  if (opts.resolveMusicSegments) {
    // For join modes that don't fill seamOffsets (concat / crossfade), approximate the scene
    // boundaries from the normalized clip durations so the plan still maps onto the timeline.
    let offsets = seamOffsets;
    if (offsets.length === 0 && infos.length > 1) {
      offsets = [];
      let acc = 0;
      for (let i = 0; i < infos.length - 1; i++) {
        acc += seamClipDuration(infos[i]);
        offsets.push(Number(acc.toFixed(6)));
      }
    }
    opts.onProgress?.({ stage: "music" });
    try {
      const resolved = await opts.resolveMusicSegments(workDir, offsets, joinedInfo.duration);
      if (resolved && resolved.length > 0) musicSegments = resolved;
    } catch (err) {
      console.warn("[ffmpeg] per-moment soundtrack unavailable — falling back:", (err as Error).message);
      musicSegments = null;
    }
  }

  const render = buildFinalRenderArgs({
    input: joinedPath,
    output: outputPath,
    quality,
    fps,
    musicPath,
    musicSegments,
    hasVoice: joinedInfo.hasAudio,
    durationSec: joinedInfo.duration,
  });
  let musicApplied = false;
  try {
    opts.onProgress?.({ stage: "render", pct: 0 });
    await runFfmpegWithProgress(render.args, "final render", joinedInfo.duration, (pct) => opts.onProgress?.({ stage: "render", pct }));
    musicApplied = Boolean(musicSegments) || Boolean(musicPath);
  } catch (err) {
    if (!musicSegments && !musicPath) throw err;
    // Music mix failed → render the same quality/fps WITHOUT any music; assembly always completes.
    console.warn("[ffmpeg] music mix failed — rendering without music:", (err as Error).message);
    await fs.rm(outputPath, { force: true });
    const plain = buildFinalRenderArgs({ input: joinedPath, output: outputPath, quality, fps, musicPath: null, musicSegments: null, durationSec: joinedInfo.duration });
    await runFfmpegWithProgress(plain.args, "final render (no music)", joinedInfo.duration, (pct) => opts.onProgress?.({ stage: "render", pct }));
    musicApplied = false;
  }
  await fs.rm(joinedPath, { force: true }).catch(() => {});

  const info = await probeMedia(outputPath);
  if (!info.hasVideo) throw new Error("Assembled episode has no video stream");
  if (!info.hasAudio) throw new Error("Assembled episode has no audio stream");

  return { outputPath, workDir, audioSources, info, quality, fps, musicApplied };
}

// Subtitles were REMOVED from the product/pipeline: the former `burnSubtitlesFile` helper (an ffmpeg
// `-vf subtitles=` burn re-encode) lived here and has been deleted. The assembled episode is the joined
// clips (native speech) + music only, with no burned-in captions of any kind.
