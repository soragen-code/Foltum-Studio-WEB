/**
 * Stage 43 checks — seamless hard-cut episode assembly (default): no FILM bridges, no visible
 * dissolves; Stage 78: pure hard cut with a 0.35s tail trim per clip (except the last), 0.03s audio edge fades.
 * Runs REAL ffmpeg on 3 synthetic 9:16 clips (testsrc + sine, 2s each) served over a local HTTP
 * server. Run: npx tsx --tsconfig tsconfig.json scripts/test-stage43.ts
 */
import assert from "node:assert";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import {
  assembleEpisodeLocally, buildSeamlessCutGraph, stitchLocalClipsSeamless, probeMedia,
  DEFAULT_STITCH_MODE, SEAMLESS_BLEND_SEC, SEAMLESS_BLEND_MAX_VIDEO_SEC, SEAMLESS_BLEND_MAX_AUDIO_SEC, SEAM_TAIL_TRIM_SEC,
  type MediaInfo,
} from "../lib/ffmpeg";

const execFileAsync = promisify(execFile);
let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

// ── A. pure filtergraph builder ───────────────────────────────────────────────────────────────────
function graphChecks() {
  ok(DEFAULT_STITCH_MODE === "seamless-cut", "A: default stitch mode is seamless-cut");
  ok(SEAMLESS_BLEND_SEC <= SEAMLESS_BLEND_MAX_VIDEO_SEC && SEAMLESS_BLEND_SEC <= SEAMLESS_BLEND_MAX_AUDIO_SEC, "A: blend constant within hard limits (<=0.12 video, <=0.08 audio)");
  const infos: MediaInfo[] = [2, 3, 2.5].map((d) => ({ duration: d, hasVideo: true, hasAudio: true, width: 720, height: 1280, fps: 30 } as MediaInfo));
  const g = buildSeamlessCutGraph(infos);
  // Stage 78: pure hard cut — no xfade/acrossfade, tail trim on every clip except the last.
  ok(!g.filter.includes("xfade=") && !g.filter.includes("acrossfade="), "A: no xfade / acrossfade in the seamless graph (Stage 78 hard cut)");
  ok(g.filter.includes("concat=n=3:v=1:a=1"), "A: single concat=n=3:v=1:a=1 joins the clips");
  ok(g.blend === 0, "A: video blend is 0 (hard cut)");
  const trimmed = [2 - SEAM_TAIL_TRIM_SEC, 3 - SEAM_TAIL_TRIM_SEC, 2.5];
  ok(g.clipDurations.every((d, i) => Math.abs(d - trimmed[i]) < 1e-9), "A: clipDurations = duration − 0.35 for all but the last clip");
  ok(Math.abs(g.expectedDuration - trimmed.reduce((a, b) => a + b, 0)) < 1e-9, "A: expectedDuration = sum of trimmed clip durations");
  ok(Math.abs(g.seamOffsets[0] - trimmed[0]) < 1e-9 && Math.abs(g.seamOffsets[1] - (trimmed[0] + trimmed[1])) < 1e-9, "A: seam offsets are cumulative trimmed durations");
  ok(g.filter.includes("scale=720:1280") && g.filter.includes("fps=30") && g.filter.includes("settb=AVTB"), "A: inputs normalized to 9:16 geometry / fps / timebase");
  // Very short clips are never trimmed (below SEAM_TAIL_TRIM_MIN_CLIP_SEC the whole clip is kept).
  const short = buildSeamlessCutGraph([{ ...infos[0], duration: 0.2 }, infos[1]]);
  ok(Math.abs(short.clipDurations[0] - 0.2) < 1e-9 && short.blend === 0, "A: very short clip keeps its full length, blend stays 0");
}

// ── B/C. real ffmpeg on synthetic clips ──────────────────────────────────────────────────────────
async function makeClips(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < 3; i++) {
    const f = path.join(dir, `clip${i + 1}.mp4`);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", `testsrc=size=720x1280:rate=30:duration=2`,
      "-f", "lavfi", "-i", `sine=frequency=${440 * (i + 1)}:sample_rate=44100:duration=2`,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ac", "2", "-shortest", f,
    ]);
    files.push(f);
  }
  return files;
}

function serve(dir: string): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      try {
        const buf = await fs.readFile(path.join(dir, path.basename(req.url ?? "")));
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(buf);
      } catch {
        res.writeHead(404); res.end();
      }
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

async function ffmpegChecks() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage43-"));
  const files = await makeClips(dir);
  const srv = await serve(dir);
  try {
    // (a) default mode with a THROWING interpolate mock: FILM is never called, assembly succeeds.
    let filmCalls = 0;
    const throwing = async () => { filmCalls++; throw new Error("FILM must not be called in seamless-cut mode"); };
    const res = await assembleEpisodeLocally(
      files.map((f) => ({ videoUrl: `${srv.base}/${path.basename(f)}` })),
      { interpolate: throwing }
    );
    try {
      ok(filmCalls === 0, "B: interpolate (FILM) was never called by the default mode");
      ok(res.info.hasVideo && res.info.hasAudio, "B: assembled episode has one video + one audio stream");
      const expected = 6 - 2 * SEAM_TAIL_TRIM_SEC; // Stage 78: two trimmed tails, no overlap
      ok(Math.abs(res.info.duration - expected) < 0.15, `B: duration ${res.info.duration.toFixed(3)}s ≈ expected ${expected.toFixed(3)}s (sum − 2·tail trim)`);
      ok(res.info.width === 720 && res.info.height === 1280, "B: output keeps 9:16 720x1280");
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", res.outputPath]);
      const types = stdout.trim().split("\n").filter(Boolean);
      ok(types.filter((t) => t === "video").length === 1 && types.filter((t) => t === "audio").length === 1, "B: ffprobe reports exactly one video and one audio stream");
    } finally {
      await fs.rm(res.workDir, { recursive: true, force: true });
    }

    // (c) exported local helper works on plain files and reports the plan.
    const out = path.join(dir, "joined.mp4");
    const r = await stitchLocalClipsSeamless(files, out);
    ok(r.blend === 0, "C: stitchLocalClipsSeamless reports blend 0 (hard cut)");
    ok(Math.abs(r.info.duration - r.expectedDuration) < 0.15, `C: local stitch duration ${r.info.duration.toFixed(3)} ≈ expected ${r.expectedDuration.toFixed(3)}`);
    ok(r.seamOffsets.length === 2 && r.info.hasAudio && r.info.hasVideo, "C: two seams, A+V present");
    const info = await probeMedia(out);
    ok(info.fps > 29 && info.fps < 31, "C: output fps preserved (30)");

    // legacy "concat" mode still works on request
    const rc = await assembleEpisodeLocally(files.map((f) => ({ videoUrl: `${srv.base}/${path.basename(f)}` })), { mode: "concat" });
    try {
      ok(Math.abs(rc.info.duration - 6) < 0.15, "C: explicit concat mode keeps full length (no overlap)");
    } finally {
      await fs.rm(rc.workDir, { recursive: true, force: true });
    }
  } finally {
    srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

(async () => {
  graphChecks();
  await ffmpegChecks();
  console.log(`\nStage 43: ${pass} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
