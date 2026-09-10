/**
 * Local ffmpeg helpers (server-side, via the `ffmpeg-static` binary).
 *
 * Used by episode assembly: every scene clip gets a UNIFORM audio track
 * (legacy separate audio if present, otherwise the clip's own audio, otherwise
 * silence), then all clips are concatenated. Doing this locally — instead of
 * through a remote ffmpeg model — guarantees the final file keeps its audio
 * stream; the previous remote concatenation silently dropped it.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { runFrameInterpolation } from "./replicate";

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
  /** Override the frame-interpolation backend (tests inject a mock / throwing fn). */
  interpolate?: InterpolateFn;
  /** FILM depth: 2^t + 1 frames @ 30fps. Default 3 (≈0.3s bridge). */
  timesToInterpolate?: number;
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
 * them into one seamless episode. Each seam is smoothed with an AI-synthesized FILM bridge
 * (invisible transition); any seam the model can't bridge degrades to a plain cut, and if the
 * whole AI pass yields no bridge the join falls back to the classic crossfade/hard-cut path.
 * Caller must `fs.rm(result.workDir, { recursive: true })`.
 */
export async function assembleEpisodeLocally(scenes: SceneClipInput[], opts: AssembleOptions = {}): Promise<AssembleResult> {
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

  // Probe every normalized clip up-front — needed for the crossfade math.
  const infos = await Promise.all(normalized.map((c) => probeMedia(c)));

  const joinedPath = path.join(workDir, "joined.mp4");
  if (normalized.length === 1) {
    await fs.copyFile(normalized[0], joinedPath);
  } else {
    // Primary: AI-seamless join (FILM bridge at every seam). Best-effort — any failure
    // (whole pass or "no seam bridged") drops through to the classic crossfade/hard-cut path,
    // so the assembly ALWAYS completes.
    let bridged = false;
    try {
      bridged = await stitchWithAiBridges(normalized, infos, workDir, joinedPath, opts);
    } catch (err) {
      console.warn("[ffmpeg] AI-seamless stitch failed — falling back:", (err as Error).message);
      bridged = false;
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

  // No subtitles are burned in: the clips carry Seedance native speech; the episode is the clean joined video.
  const outputPath = path.join(workDir, "episode.mp4");
  await fs.copyFile(joinedPath, outputPath);
  await fs.rm(joinedPath, { force: true }).catch(() => {});

  const info = await probeMedia(outputPath);
  if (!info.hasVideo) throw new Error("Assembled episode has no video stream");
  if (!info.hasAudio) throw new Error("Assembled episode has no audio stream");

  return { outputPath, workDir, audioSources, info };
}
