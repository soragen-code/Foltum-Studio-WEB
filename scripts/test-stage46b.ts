/**
 * Stage 46B — unit tests (no network, no DB).
 *   npx tsx --tsconfig tsconfig.json scripts/test-stage46b.ts
 *
 * Covers: final render arg builder (480/720/1080 × 30/60: dimensions, -r, copy vs re-encode),
 * music mix filter (volume / fades / trim), mood schema, scenes forced to 480p (+ LOW pricing),
 * scene progress stage mapping, assembly stage progress, ffmpeg -progress parsing and the
 * concurrency helper. The last block runs REAL ffmpeg (ffmpeg-static) on synthetic clips to prove
 * the 480p/30 copy path and the music mix / scale paths produce a playable file.
 */
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildFinalRenderArgs, buildMusicMixFilter, parseProgressLine, mapWithConcurrency, runFfmpegWithProgress, probeMedia,
} from "../lib/ffmpeg";
import { ASSEMBLE_DIMENSIONS, DEFAULT_ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY, isAssembleFps, isAssembleQuality } from "../lib/assemble-options";
import { MOODS, moodSchema, parseMood, DEFAULT_MOOD, MOOD_PROMPTS } from "../lib/music";
import { POWER_TIER_CONFIG, SCENE_RESOLUTION, resolvePowerTier, sceneTierConfig } from "../lib/power-tier";
import { sceneClipCost, sceneClipSeconds } from "../lib/season";
import { sceneProgressStage, formatElapsed, parseLogPercent, SCENE_STAGE_PROGRESS } from "../lib/scene-progress";
import { assembleStageProgress } from "../lib/assemble";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const has = (args: string[], ...seq: string[]) => {
  for (let i = 0; i + seq.length <= args.length; i++) if (seq.every((s, k) => args[i + k] === s)) return true;
  return false;
};

/* ── 1. Final render builder ─────────────────────────────────────────────── */
{
  const base = { input: "in.mp4", output: "out.mp4", durationSec: 42 };
  const native = buildFinalRenderArgs({ ...base, quality: "480p", fps: 30, musicPath: null });
  ok(!native.reencodesVideo && !native.reencodesAudio && has(native.args, "-c", "copy"), "480p/30 no music → -c copy (no re-encode)");
  ok(!native.args.includes("-filter_complex") && !native.args.includes("-r"), "480p/30 no music → no filter, no -r");

  const nativeMusic = buildFinalRenderArgs({ ...base, quality: "480p", fps: 30, musicPath: "m.mp3" });
  ok(!nativeMusic.reencodesVideo && nativeMusic.reencodesAudio, "480p/30 + music → video copy, audio re-encode");
  ok(has(nativeMusic.args, "-c:v", "copy") && has(nativeMusic.args, "-c:a", "aac") && has(nativeMusic.args, "-stream_loop", "-1", "-i", "m.mp3"), "480p/30 + music → -c:v copy, -c:a aac, looped music input");
  ok(nativeMusic.args.join(" ").includes("amix=inputs=2:duration=first"), "480p/30 + music → amix filter present");

  for (const quality of ["480p", "720p", "1080p"] as const) {
    for (const fps of [30, 60] as const) {
      if (quality === "480p" && fps === 30) continue;
      const r = buildFinalRenderArgs({ ...base, quality, fps, musicPath: null });
      const { width, height } = ASSEMBLE_DIMENSIONS[quality];
      const fc = r.args[r.args.indexOf("-filter_complex") + 1];
      ok(r.reencodesVideo && has(r.args, "-c:v", "libx264") && has(r.args, "-r", String(fps)), `${quality}/${fps} → libx264 + -r ${fps}`);
      ok(fc.includes(`scale=${width}:${height}`) && fc.includes(`pad=${width}:${height}`) && fc.includes(`fps=${fps}`), `${quality}/${fps} → scale/pad ${width}x${height}, fps=${fps}`);
    }
  }
  ok(ASSEMBLE_DIMENSIONS["480p"].width === 480 && ASSEMBLE_DIMENSIONS["480p"].height === 854, "480p = 480x854");
  ok(ASSEMBLE_DIMENSIONS["720p"].height === 1280 && ASSEMBLE_DIMENSIONS["1080p"].height === 1920, "720p = 720x1280, 1080p = 1080x1920");
  ok(DEFAULT_ASSEMBLE_QUALITY === "480p" && DEFAULT_ASSEMBLE_FPS === 30, "defaults 480p / 30");
  ok(isAssembleQuality("720p") && !isAssembleQuality("4k") && isAssembleFps(60) && !isAssembleFps(24), "quality / fps guards");
}

/* ── 2. Music mix filter ─────────────────────────────────────────────────── */
{
  const f = buildMusicMixFilter({ durationSec: 60 });
  ok(f.includes("volume=0.18"), "music volume 0.18 by default");
  ok(f.includes("afade=t=in:st=0:d=2.00"), "2 s fade-in");
  ok(f.includes("afade=t=out:st=57.000:d=3.00"), "3 s fade-out ends at the episode end");
  ok(f.startsWith("[1:a]atrim=0:60.000"), "music trimmed to the episode length");
  ok(f.includes("[c][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"), "clip audio primary (duration=first, no normalisation)");
  const short = buildMusicMixFilter({ durationSec: 3, volume: 0.15 });
  ok(short.includes("volume=0.15") && short.includes("afade=t=in:st=0:d=1.50"), "fades clamp to half of a very short episode");
}

/* ── 3. Mood schema ──────────────────────────────────────────────────────── */
{
  ok(MOODS.length === 7 && MOODS.includes("tense") && MOODS.includes("action"), "7 fixed moods");
  ok(moodSchema.safeParse({ mood: "romantic" }).success, "schema accepts a listed mood");
  ok(!moodSchema.safeParse({ mood: "happy" }).success, "schema rejects an unknown mood");
  ok(parseMood({ mood: "dark" }) === "dark" && parseMood("garbage") === DEFAULT_MOOD && parseMood(null) === DEFAULT_MOOD, "parseMood → mood or default");
  ok(MOODS.every((m) => /no vocals/.test(MOOD_PROMPTS[m])), "every mood prompt is instrumental");
}

/* ── 4. Scenes forced to 480p + LOW pricing ──────────────────────────────── */
{
  ok(SCENE_RESOLUTION === "480p", "SCENE_RESOLUTION = 480p");
  for (const tier of ["LOW", "MEDIUM", "HIGH"] as const) {
    const cfg = resolvePowerTier({ powerTier: tier });
    ok(cfg.resolution === "480p" && cfg.costPerScene === 1 && cfg.baseDuration === 5 && cfg.id === tier, `resolvePowerTier(${tier}) → 480p, cost 1 / 5 s, id kept`);
    ok(sceneClipCost(tier, 30) === 6 && sceneClipCost(tier, 5) === 1, `sceneClipCost(${tier}) = 480p price`);
    ok(sceneClipSeconds(tier, 20) === 20 && sceneClipSeconds(tier, 8) === 15, `sceneClipSeconds(${tier}) unchanged (min 15, planned kept)`);
  }
  ok(resolvePowerTier({ tier: "maximum" }).resolution === "480p", "legacy maximum → 480p");
  ok(sceneTierConfig(POWER_TIER_CONFIG.HIGH).label === "720p+", "label of the stored tier is kept");
}

/* ── 5. Scene progress stage mapping ─────────────────────────────────────── */
{
  const q = sceneProgressStage("starting", 12_000);
  ok(q.stage === "queued" && q.progress === 5 && q.message === "Queued", "starting → «Queued» 5 %");
  const r = sceneProgressStage("processing", 83_000);
  ok(r.stage === "rendering" && r.progress === 40 && r.message === "Rendering video (Seedance)… 01:23", "processing → «Rendering video (Seedance)… mm:ss» 40 %");
  const withPct = sceneProgressStage("processing", 5_000, "step 12/20\n 60%|██████    |");
  ok(withPct.progress === Math.round(5 + 0.6 * 79) && withPct.message.endsWith("· 60%"), "model percent from logs drives the bar");
  ok(parseLogPercent(null) === null && parseLogPercent("no numbers here") === null && parseLogPercent("progress: 0.25") === 25, "parseLogPercent");
  ok(formatElapsed(0) === "00:00" && formatElapsed(3_599_000) === "59:59" && formatElapsed(-5) === "00:00", "formatElapsed mm:ss");
  ok(SCENE_STAGE_PROGRESS.uploading === 85 && SCENE_STAGE_PROGRESS.verifying === 95 && SCENE_STAGE_PROGRESS.done === 100, "upload 85 / verify 95 / done 100");
}

/* ── 6. Assembly stage progress + ffmpeg progress parsing + pool ─────────── */
{
  ok(assembleStageProgress({ stage: "download", done: 2, total: 4 }).message === "Downloading clips 2/4", "download k/N message");
  ok(assembleStageProgress({ stage: "download", done: 4, total: 4 }).progress === 30, "download done → 30 %");
  ok(assembleStageProgress({ stage: "music" }).message === "Selecting music", "music stage");
  ok(assembleStageProgress({ stage: "join", pct: 0 }).message === "Assembly", "join stage");
  const r = assembleStageProgress({ stage: "render", pct: 50 });
  ok(r.progress === 65 && r.message === "Assembly 50%", "render 50 % → 65 % «Assembly 50%»");
  ok(parseProgressLine("out_time_us=1500000") === 1.5 && parseProgressLine("out_time=00:01:30.500") === 90.5 && parseProgressLine("frame=12") === null, "-progress line parsing");
}
async function main() {
  {
    let inFlight = 0, peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 4, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15 + (7 - n) * 3));
      inFlight--; return n * 2;
    });
    ok(out.join(",") === "2,4,6,8,10,12,14" && peak <= 4 && peak >= 2, `mapWithConcurrency keeps order, cap 4 (peak ${peak})`);
  }

  /* ── 7. Real ffmpeg: copy path + music mix + scale ───────────────────────── */
  {
    const bin = (require("ffmpeg-static") as string) || "ffmpeg";
    const run = promisify(execFile);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t46b-"));
    const clip = path.join(dir, "clip.mp4");
    const music = path.join(dir, "music.mp3");
    await run(bin, ["-y", "-f", "lavfi", "-i", "testsrc=size=480x854:rate=24:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    await run(bin, ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=1.5", "-c:a", "libmp3lame", music]);

    const outCopy = path.join(dir, "copy.mp4");
    const copy = buildFinalRenderArgs({ input: clip, output: outCopy, quality: "480p", fps: 30, musicPath: null, durationSec: 4 });
    const pcts: number[] = [];
    await runFfmpegWithProgress(copy.args, "copy", 4, (p) => pcts.push(p));
    const ci = await probeMedia(outCopy);
    ok(ci.hasVideo && ci.hasAudio && ci.width === 480 && Math.round(ci.fps) === 24, "real ffmpeg: 480p/30 copy keeps 480 px and native fps (no re-encode)");
    ok(pcts[pcts.length - 1] === 100, "progress callback reaches 100 %");

    const outMix = path.join(dir, "mix.mp4");
    const mix = buildFinalRenderArgs({ input: clip, output: outMix, quality: "480p", fps: 30, musicPath: music, durationSec: 4 });
    await runFfmpegWithProgress(mix.args, "mix", 4);
    const mi = await probeMedia(outMix);
    ok(mi.hasVideo && mi.hasAudio && Math.abs(mi.duration - 4) < 0.35 && mi.width === 480, "real ffmpeg: looped 1.5 s music mixed under a 4 s clip, length kept");

    const outHd = path.join(dir, "hd.mp4");
    const hd = buildFinalRenderArgs({ input: clip, output: outHd, quality: "720p", fps: 60, musicPath: music, durationSec: 4 });
    const hdPcts: number[] = [];
    await runFfmpegWithProgress(hd.args, "hd", 4, (p) => hdPcts.push(p));
    const hi = await probeMedia(outHd);
    ok(hi.width === 720 && hi.height === 1280 && Math.round(hi.fps) === 60 && hi.hasAudio, "real ffmpeg: 720p/60 + music → 720x1280 @ 60 fps");
    ok(hdPcts.length >= 2 && hdPcts[0] < hdPcts[hdPcts.length - 1], "real render reports increasing progress");
    await fs.rm(dir, { recursive: true, force: true });
  }

}

main().then(() => console.log(`\nStage 46B: ${pass} checks passed`)).catch((e) => { console.error(e); process.exit(1); });
