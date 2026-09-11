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
 * editorial cut with an invisible micro-blend on the seam itself (video xfade of
 * SEAMLESS_BLEND_SEC ≈ 2–3 frames, audio acrossfade of the same length so there is no click
 * and no gap). The older FILM-bridge (`stitchWithAiBridges`) and visible-dissolve
 * (`crossfadeClips`) paths are kept but are only used when explicitly requested via
 * `AssembleOptions.mode`.
 */
import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { runFrameInterpolation } from "./replicate";
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
 * Counterpart of extractLastFrameBuffer: the last frame of scene N and the first frame
 * of scene N+1 are fed to FILM to synthesize the invisible bridge between them.
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

/** Extract the LAST frame of a LOCAL video file as a JPEG buffer (no download). */
async function extractLastFrameLocal(videoPath: string, outPath: string): Promise<Buffer> {
  try {
    await runFfmpeg(
      ["-sseof", "-1", "-i", videoPath, "-update", "1", "-q:v", "2", "-frames:v", "1", outPath],
      "local last frame (sseof)"
    );
  } catch {
    await runFfmpeg(["-i", videoPath, "-vf", "reverse", "-q:v", "2", "-frames:v", "1", outPath], "local last frame (reverse)");
  }
  return fs.readFile(outPath);
}

/** Extract the FIRST frame of a LOCAL video file as a JPEG buffer (no download). */
async function extractFirstFrameLocal(videoPath: string, outPath: string): Promise<Buffer> {
  await runFfmpeg(["-i", videoPath, "-frames:v", "1", "-q:v", "2", outPath], "local first frame");
  return fs.readFile(outPath);
}

export interface MediaInfo {
  hasVideo: boolean;
  hasAudio: boolean;
  /** Container duration in seconds (0 if unknown). */
  duration: number;
  /** Video geometry / frame rate (0 if unknown). */
  width: number;
  height: number;
  fps: number;
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
  return {
    hasVideo: videoLine.length > 0,
    hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(out),
    duration,
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
export type StitchMode = "seamless-cut" | "film" | "crossfade" | "concat";
/** Default: a straight editorial cut with an invisible micro-blend on the seam. */
export const DEFAULT_STITCH_MODE: StitchMode = "seamless-cut";

/**
 * Length of the micro-blend on every seam, in seconds — used for BOTH the video `xfade`
 * and the audio `acrossfade` so the two streams overlap identically and stay in sync.
 * 0.08s ≈ 2 frames @ 24fps / 2.4 frames @ 30fps: far too short to read as a dissolve, but
 * enough to soften the single-frame "jerk" of a hard cut and to kill the audio click / gap.
 * HARD LIMIT: must stay ≤ 0.12s (video) and ≤ 0.08s (audio) — see scripts/test-stage43.ts.
 */
export const SEAMLESS_BLEND_SEC = 0.08;
export const SEAMLESS_BLEND_MAX_VIDEO_SEC = 0.12;
export const SEAMLESS_BLEND_MAX_AUDIO_SEC = 0.08;

export interface SeamlessCutGraph {
  /** ffmpeg `-filter_complex` string; outputs are `[vout]` and `[aout]`. */
  filter: string;
  /** Blend actually used on every seam (s). */
  blend: number;
  /** Expected output duration: sum(clip durations) − (N−1)·blend. */
  expectedDuration: number;
  /** Seam positions in the OUTPUT timeline (start of each blend), for markers / music offsets. */
  seamOffsets: number[];
  width: number;
  height: number;
  fps: number;
}

/**
 * Pure builder for the seamless-cut filtergraph (unit-testable, no ffmpeg run).
 * Every input is normalized to the geometry / fps / timebase of the first clip (xfade needs
 * identical size, fps and timebase), then N−1 chained `xfade=transition=fade` + `acrossfade`
 * filters join them with a `blend`-second overlap each. The k-th seam starts at
 * `sum(d_0..d_{k-1}) − k·blend` in the output.
 */
export function buildSeamlessCutGraph(infos: MediaInfo[], blend: number = SEAMLESS_BLEND_SEC): SeamlessCutGraph {
  const n = infos.length;
  if (n < 2) throw new Error("buildSeamlessCutGraph needs at least 2 clips");
  const ref = infos[0];
  const w = ref.width || 720;
  const h = ref.height || 1280;
  const fps = ref.fps > 0 ? Math.round(ref.fps) : 24;
  // Clamp: never longer than the hard limits, never more than 1/4 of the shortest clip.
  const minDur = Math.min(...infos.map((i) => i.duration).filter((d) => d > 0));
  const d = Math.max(
    0.01,
    Math.min(blend, SEAMLESS_BLEND_MAX_AUDIO_SEC, SEAMLESS_BLEND_MAX_VIDEO_SEC, (Number.isFinite(minDur) ? minDur : blend) / 4)
  );

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,settb=AVTB[v${i}]`
    );
    parts.push(`[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
  }

  let vPrev = "v0";
  let aPrev = "a0";
  let elapsed = infos[0].duration;
  const seamOffsets: number[] = [];
  for (let i = 1; i < n; i++) {
    const offset = Math.max(0, elapsed - d);
    seamOffsets.push(offset);
    const vOut = i === n - 1 ? "vout" : `vx${i}`;
    const aOut = i === n - 1 ? "aout" : `ax${i}`;
    parts.push(`[${vPrev}][v${i}]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`);
    parts.push(`[${aPrev}][a${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${aOut}]`);
    vPrev = vOut;
    aPrev = aOut;
    elapsed = elapsed + infos[i].duration - d;
  }
  return { filter: parts.join(";"), blend: d, expectedDuration: elapsed, seamOffsets, width: w, height: h, fps };
}

/**
 * Join uniform clips with a seamless hard cut (see SEAMLESS_BLEND_SEC). Clips keep their full
 * length except for the `blend` overlap on each seam; no edge afades are applied (the
 * acrossfade alone removes the click), no bridge frames are synthesized.
 */
async function seamlessCutClips(clips: string[], infos: MediaInfo[], outPath: string): Promise<SeamlessCutGraph> {
  const g = buildSeamlessCutGraph(infos);
  await runFfmpeg(
    [
      ...clips.flatMap((c) => ["-i", c]),
      "-filter_complex", g.filter,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(g.fps),
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
    let expectedDuration = infos.reduce((a, i) => a + i.duration, 0);
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
/*  AI-seamless stitching (FILM frame interpolation at every seam)     */
/* ------------------------------------------------------------------ */

/** How a single seam is smoothed: an FILM-synthesized bridge, or a plain cut. */
interface SeamBridge {
  bridgePath: string;
  /** Final bridge duration (s); `duration/2` is trimmed from each adjacent clip. */
  duration: number;
}

/** Injectable interpolation fn (default wraps FILM); mockable in tests. */
export type InterpolateFn = (frame1: Buffer, frame2: Buffer) => Promise<string>;

export interface AssembleOptions {
  /**
   * Join mode. Default "seamless-cut" (Stage 43): straight cut + invisible micro-blend, no AI
   * bridges, no visible dissolves. "film" = legacy FILM bridges (falls back to crossfade/concat),
   * "crossfade" = visible 0.2s dissolves, "concat" = raw hard cut.
   */
  mode?: StitchMode;
  /** Override the frame-interpolation backend (tests inject a mock / throwing fn). Only used in mode "film". */
  interpolate?: InterpolateFn;
  /** FILM depth: 2^t + 1 frames @ 30fps. Default 3 (≈0.3s bridge). */
  timesToInterpolate?: number;
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

export interface MusicMixOptions {
  /** Episode length in seconds — music is trimmed to it. */
  durationSec: number;
  /** Music gain under the clip audio (0.15–0.2 recommended). Default 0.18. */
  volume?: number;
  /** Seconds. Default 2. */
  fadeIn?: number;
  /** Seconds. Default 3. */
  fadeOut?: number;
}

/**
 * Pure: filtergraph mixing looped background music (input 1) under the clip audio (input 0).
 * Music: trimmed to the episode, gain `volume`, fade-in / fade-out; clip audio stays primary
 * (`duration=first`, no normalisation). Output label `[aout]`.
 */
export function buildMusicMixFilter(opts: MusicMixOptions): string {
  const dur = Math.max(0.1, opts.durationSec);
  const volume = opts.volume ?? 0.18;
  const fadeIn = Math.min(opts.fadeIn ?? 2, dur / 2);
  const fadeOut = Math.min(opts.fadeOut ?? 3, dur / 2);
  const fadeOutStart = Math.max(0, dur - fadeOut);
  return (
    `[1:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
    `volume=${volume},afade=t=in:st=0:d=${fadeIn.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(2)}[m];` +
    `[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[c];` +
    `[c][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
  );
}

export interface FinalRenderOptions {
  input: string;
  output: string;
  quality: AssembleQuality;
  fps: AssembleFps;
  /** Local music file (looped) or null. */
  musicPath?: string | null;
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
  const hasMusic = Boolean(o.musicPath);
  const { width, height } = ASSEMBLE_DIMENSIONS[o.quality];
  const inputs = ["-i", o.input, ...(hasMusic ? ["-stream_loop", "-1", "-i", o.musicPath as string] : [])];
  const audioEnc = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"];
  const tail = ["-movflags", "+faststart", o.output];

  if (isNative && !hasMusic) {
    return { args: [...inputs, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", ...tail], reencodesVideo: false, reencodesAudio: false };
  }
  const filters: string[] = [];
  if (!isNative) {
    filters.push(
      `[0:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${o.fps},format=yuv420p[vout]`
    );
  }
  if (hasMusic) filters.push(buildMusicMixFilter({ durationSec: o.durationSec }));
  const videoMap = isNative ? ["-map", "0:v:0", "-c:v", "copy"] : ["-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(o.fps)];
  const audioMap = hasMusic ? ["-map", "[aout]", ...audioEnc] : ["-map", "0:a:0", ...(isNative ? ["-c:a", "copy"] : audioEnc)];
  const args = [
    ...inputs,
    ...(filters.length ? ["-filter_complex", filters.join(";")] : []),
    ...videoMap,
    ...audioMap,
    "-t", Math.max(0.1, o.durationSec).toFixed(3),
    ...tail,
  ];
  return { args, reencodesVideo: !isNative, reencodesAudio: hasMusic || !isNative };
}

/**
 * Decide the bridge length for one seam so the TOTAL episode duration is preserved
 * (the bridge replaces `duration` seconds trimmed evenly from the two adjacent clips).
 * Returns null when the seam must NOT be bridged (a neighbouring clip too short, or an
 * unusable bridge) — the caller then leaves that seam as a plain cut.
 *   - `bridge`: final bridge duration inserted at the seam.
 *   - `half`:   trimmed from the tail of clip A and the head of clip B (bridge/2 each).
 */
export function planSeamBridge(
  rawBridgeDuration: number,
  durationA: number,
  durationB: number
): { bridge: number; half: number } | null {
  if (!(durationA > 0.4) || !(durationB > 0.4)) return null;
  if (!(rawBridgeDuration > 0.05)) return null;
  // Never let a bridge eat more than 30% of the shorter neighbour (keeps bodies positive
  // even when a clip is flanked by a bridge on each side).
  const maxBridge = Math.min(durationA, durationB) * 0.3;
  const bridge = Math.min(rawBridgeDuration, maxBridge);
  if (!(bridge > 0.05)) return null;
  return { bridge, half: bridge / 2 };
}

/** Re-encode one clip body [start, start+dur] to uniform params, with tiny edge afades. */
async function encodeBody(
  clip: string,
  start: number,
  dur: number,
  outPath: string,
  w: number,
  h: number,
  fps: number
): Promise<void> {
  const trimArgs: string[] = [];
  if (start > 0.001) trimArgs.push("-ss", start.toFixed(3));
  if (dur > 0.001) trimArgs.push("-t", dur.toFixed(3));
  const fd = 0.02;
  const afade =
    dur > 0.05
      ? `afade=t=in:st=0:d=${fd},afade=t=out:st=${Math.max(0, dur - fd).toFixed(3)}:d=${fd}`
      : "anull";
  await runFfmpeg(
    [
      "-i", clip,
      ...trimArgs,
      "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`,
      "-af", afade,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      "-movflags", "+faststart",
      outPath,
    ],
    "body segment"
  );
}

/**
 * Build the bridge segment for one seam: FILM's interpolated video scaled to the episode
 * geometry, with an audio track stitched from the SAME slices trimmed off the neighbours
 * (tail of clip A + head of clip B) so sound stays continuous and in sync under the bridge.
 * Inputs: 0 = bridge mp4, 1 = clip A, 2 = clip B.
 */
async function encodeBridge(
  bridgePath: string,
  clipA: string,
  clipB: string,
  durationA: number,
  half: number,
  bridge: number,
  outPath: string,
  w: number,
  h: number,
  fps: number
): Promise<void> {
  const xf = Math.min(0.02, half / 2);
  const filter =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[vb];` +
    `[1:a]atrim=start=${Math.max(0, durationA - half).toFixed(3)}:end=${durationA.toFixed(3)},asetpts=PTS-STARTPTS[a1];` +
    `[2:a]atrim=start=0:end=${half.toFixed(3)},asetpts=PTS-STARTPTS[a2];` +
    `[a1][a2]acrossfade=d=${xf.toFixed(3)}:c1=tri:c2=tri[axf];` +
    `[axf]apad,atrim=end=${bridge.toFixed(3)},asetpts=PTS-STARTPTS[ab]`;
  await runFfmpeg(
    [
      "-i", bridgePath, "-i", clipA, "-i", clipB,
      "-filter_complex", filter,
      "-map", "[vb]", "-map", "[ab]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
      "-t", bridge.toFixed(3),
      "-movflags", "+faststart",
      outPath,
    ],
    "bridge segment"
  );
}

/**
 * AI-seamless join: on EACH seam, synthesize a FILM bridge between the last frame of clip i
 * and the first frame of clip i+1, then rebuild the episode as [body, bridge, body, bridge, …].
 * Total duration is preserved (each bridge replaces an equal slice trimmed off its neighbours).
 *
 * Robustness contract:
 *   - Every seam's bridge is generated EXACTLY ONCE (single linear pass; ffmpeg download/probe
 *     retries never re-call the paid model).
 *   - A seam whose interpolation fails (or is too short to bridge) degrades to a plain cut —
 *     it never fails the whole assembly.
 *   - If NOT A SINGLE seam produced a bridge, returns false so the caller runs the existing
 *     whole-episode crossfade/concat fallback (identical to pre-Stage-28 behaviour).
 * Returns true when the AI-bridged episode was written to `outPath`.
 */
async function stitchWithAiBridges(
  normalized: string[],
  infos: MediaInfo[],
  workDir: string,
  outPath: string,
  opts: AssembleOptions
): Promise<boolean> {
  const n = normalized.length;
  const ref = infos[0];
  const w = ref.width || 720;
  const h = ref.height || 1280;
  const fps = ref.fps > 0 ? Math.round(ref.fps) : 24;
  const times = opts.timesToInterpolate ?? 3;
  const interpolate: InterpolateFn =
    opts.interpolate ?? ((f1, f2) => runFrameInterpolation({ frame1: f1, frame2: f2, timesToInterpolate: times }));

  // ── Generate the per-seam bridges (ONCE each) ─────────────────────────────────────────────
  const seams: (SeamBridge | null)[] = [];
  for (let i = 0; i < n - 1; i++) {
    const di = infos[i].duration;
    const dj = infos[i + 1].duration;
    // Skip interpolation entirely for unbridgeable (too-short) seams — saves paid credits.
    if (!(di > 0.4) || !(dj > 0.4)) {
      seams.push(null);
      continue;
    }
    try {
      const f1 = await extractLastFrameLocal(normalized[i], path.join(workDir, `lf_${i}.jpg`));
      const f2 = await extractFirstFrameLocal(normalized[i + 1], path.join(workDir, `ff_${i}.jpg`));
      const bridgeUrl = await interpolate(f1, f2);
      const bridgePath = path.join(workDir, `bridge_${String(i).padStart(3, "0")}.mp4`);
      await downloadToFile(bridgeUrl, bridgePath);
      const bInfo = await probeMedia(bridgePath);
      const plan = planSeamBridge(bInfo.duration, di, dj);
      if (!plan) {
        seams.push(null);
        continue;
      }
      seams.push({ bridgePath, duration: plan.bridge });
    } catch (err) {
      console.warn(`[ffmpeg] seam ${i} interpolation failed — plain cut:`, (err as Error).message);
      seams.push(null);
    }
  }

  // Nothing bridged → let the caller use the whole-episode crossfade/concat fallback.
  if (seams.every((s) => s === null)) return false;

  // ── Rebuild ordered segments: [body0, bridge0?, body1, bridge1?, …] ───────────────────────
  const segments: string[] = [];
  for (let i = 0; i < n; i++) {
    const di = infos[i].duration;
    const leftBridge = i > 0 ? seams[i - 1] : null;
    const rightBridge = i < n - 1 ? seams[i] : null;
    const leftTrim = leftBridge ? leftBridge.duration / 2 : 0;
    const rightTrim = rightBridge ? rightBridge.duration / 2 : 0;
    const bodyDur = di > 0 ? Math.max(0, di - leftTrim - rightTrim) : 0;
    const bodyOut = path.join(workDir, `seg_body_${String(i).padStart(3, "0")}.mp4`);
    await encodeBody(normalized[i], leftTrim, bodyDur, bodyOut, w, h, fps);
    segments.push(bodyOut);
    if (rightBridge) {
      const bridgeSeg = path.join(workDir, `seg_bridge_${String(i).padStart(3, "0")}.mp4`);
      await encodeBridge(
        rightBridge.bridgePath, normalized[i], normalized[i + 1],
        di, rightBridge.duration / 2, rightBridge.duration, bridgeSeg, w, h, fps
      );
      segments.push(bridgeSeg);
    }
  }

  await concatClips(segments, workDir, outPath);
  return true;
}

/**
 * Download all scene clips (+ voiceovers), give every clip a uniform audio track and join
 * them into one episode. Default mode (Stage 43) is the seamless hard cut — a straight cut
 * with an invisible ~0.08s video/audio micro-blend on the seam, no AI bridges. Legacy modes
 * ("film", "crossfade", "concat") are selectable via `opts.mode`.
 * Caller must `fs.rm(result.workDir, { recursive: true })`.
 */
export async function assembleEpisodeLocally(scenes: SceneClipInput[], opts: AssembleOptions = {}): Promise<AssembleResult> {
  if (scenes.length === 0) throw new Error("No scenes to assemble");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "episode-"));

  // Stage 46B: clips are downloaded + normalized in parallel (cap `downloadConcurrency`), with a
  // real «k/N» progress event after each one.
  let downloaded = 0;
  opts.onProgress?.({ stage: "download", done: 0, total: scenes.length });
  const prepared = await mapWithConcurrency(scenes, opts.downloadConcurrency ?? DOWNLOAD_CONCURRENCY, async (s, i) => {
    const idx = String(i + 1).padStart(3, "0");
    const videoPath = path.join(workDir, `scene_${idx}.mp4`);
    await downloadToFile(s.videoUrl, videoPath);

    let audioPath: string | null = null;
    if (s.audioUrl) {
      audioPath = path.join(workDir, `scene_${idx}_voice.audio`);
      await downloadToFile(s.audioUrl, audioPath);
    }

    const outPath = path.join(workDir, `clip_${idx}.mp4`);
    const source = await normalizeClip(videoPath, audioPath, outPath);

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
  opts.onProgress?.({ stage: "join", pct: 0 });
  if (normalized.length === 1) {
    await fs.copyFile(normalized[0], joinedPath);
  } else if (mode === "seamless-cut") {
    // DEFAULT (Stage 43): straight cut with an invisible micro-blend on the seam. No FILM call,
    // no visible dissolve. If the ultra-short xfade fails for any reason → frame-exact concat.
    try {
      const g = await seamlessCutClips(normalized, infos, joinedPath);
      console.log(`[ffmpeg] seamless cut: ${normalized.length} clips, blend=${g.blend.toFixed(3)}s, expected=${g.expectedDuration.toFixed(2)}s`);
    } catch (err) {
      console.warn("[ffmpeg] seamless cut failed — falling back to hard concat:", (err as Error).message);
      await fs.rm(joinedPath, { force: true });
      await concatClips(normalized, workDir, joinedPath);
    }
  } else if (mode === "concat") {
    await concatClips(normalized, workDir, joinedPath);
  } else {
    // Legacy modes — "film": AI-seamless join (FILM bridge at every seam), best-effort; any
    // failure (whole pass or "no seam bridged") drops through to the crossfade/hard-cut path.
    // "crossfade": visible 0.2s dissolves. Assembly ALWAYS completes.
    let bridged = false;
    if (mode === "film") {
      try {
        bridged = await stitchWithAiBridges(normalized, infos, workDir, joinedPath, opts);
      } catch (err) {
        console.warn("[ffmpeg] AI-seamless stitch failed — falling back:", (err as Error).message);
        bridged = false;
      }
    }
    if (!bridged) {
      await fs.rm(joinedPath, { force: true });
      try {
        await crossfadeClips(normalized, infos, joinedPath, TRANSITION_SEC);
      } catch (err) {
        // Crossfade is best-effort: never fail the whole assembly because of a transition.
        console.warn("[ffmpeg] xfade failed — falling back to hard cuts:", (err as Error).message);
        await fs.rm(joinedPath, { force: true });
        await concatClips(normalized, workDir, joinedPath);
      }
    }
  }

  // No subtitles are burned in: the clips carry Seedance native speech.
  // Stage 46B — FINAL render: only here the episode is scaled to the chosen quality / fps and the
  // background music is mixed in. 480p/30 without music is a pure stream copy.
  const joinedInfo = await probeMedia(joinedPath);
  const quality = opts.quality ?? DEFAULT_ASSEMBLE_QUALITY;
  const fps = opts.fps ?? DEFAULT_ASSEMBLE_FPS;
  const outputPath = path.join(workDir, "episode.mp4");
  const render = buildFinalRenderArgs({ input: joinedPath, output: outputPath, quality, fps, musicPath, durationSec: joinedInfo.duration });
  let musicApplied = false;
  try {
    opts.onProgress?.({ stage: "render", pct: 0 });
    await runFfmpegWithProgress(render.args, "final render", joinedInfo.duration, (pct) => opts.onProgress?.({ stage: "render", pct }));
    musicApplied = Boolean(musicPath);
  } catch (err) {
    if (!musicPath) throw err;
    // Music mix failed → render the same quality/fps WITHOUT music; assembly always completes.
    console.warn("[ffmpeg] music mix failed — rendering without music:", (err as Error).message);
    await fs.rm(outputPath, { force: true });
    const plain = buildFinalRenderArgs({ input: joinedPath, output: outputPath, quality, fps, musicPath: null, durationSec: joinedInfo.duration });
    await runFfmpegWithProgress(plain.args, "final render (no music)", joinedInfo.duration, (pct) => opts.onProgress?.({ stage: "render", pct }));
  }
  await fs.rm(joinedPath, { force: true }).catch(() => {});

  const info = await probeMedia(outputPath);
  if (!info.hasVideo) throw new Error("Assembled episode has no video stream");
  if (!info.hasAudio) throw new Error("Assembled episode has no audio stream");

  return { outputPath, workDir, audioSources, info, quality, fps, musicApplied };
}
