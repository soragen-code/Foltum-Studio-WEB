/**
 * Real-ffmpeg check of the v2 dialogue-clip silence trimming (detectSilence → computeClipTrim →
 * normalizeClipArgs with trim) plus unit checks of sceneHasDialogueV2 / sceneDurationSecV2.
 * Synthetic clip: 6 s video, audio = 0.8 s silence + 3.2 s tone + 2 s silence.
 * Run: npx tsx scripts/test-assemble-v2-trim.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeClipArgs } from "../lib/workers/episode-assemble-v2-job";
import { computeClipTrim, detectSilence, probeMedia, runFfmpegPlain } from "../lib/ffmpeg";
import { sceneDurationSecV2, sceneHasDialogueV2 } from "../lib/idea-v2";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FF: string = process.env.FFMPEG_PATH || require("ffmpeg-static");
const gen = (args: string[]) => execFileSync(FF, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a}, expected ${b} ±${tol}`);

async function main() {
  // --- pure logic -------------------------------------------------------------------------
  assert.equal(sceneHasDialogueV2({ action: 'He turns to her and says "Go now."' }), true);
  assert.equal(sceneHasDialogueV2({ action: "Wind moves the curtains. The lamp flickers." }), false);
  assert.equal(sceneHasDialogueV2({ action: "Она говорит: «Уходи»." }), true);
  assert.equal(sceneDurationSecV2({ action: 'She says "Yes."', durationSec: 5 }), 4, "short line → min 4 s");
  assert.equal(sceneDurationSecV2({ action: "Rain hammers the roof.", durationSec: 7 }), 7, "no dialogue → untouched");
  const long = 'He says "' + Array.from({ length: 20 }, () => "word").join(" ") + '."';
  assert.equal(sceneDurationSecV2({ action: long, durationSec: 5 }), 5, "never lengthen");
  assert.equal(sceneDurationSecV2({ action: 'A: "Hi." B: "Hi."', durationSec: 10 }), 4, "two tiny lines → 4 s");
  console.log("logic OK");

  // --- ffmpeg -----------------------------------------------------------------------------
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm2trim-"));
  const clip = path.join(dir, "clip.mp4");
  gen([
    "-f", "lavfi", "-i", "testsrc=s=720x1280:r=24:d=6",
    "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,0.8\\,4.0)\\,0.5*sin(2*PI*440*t)\\,0):s=44100:c=stereo:d=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "6", clip,
  ]);
  const inf = await probeMedia(clip);
  assert.ok(inf.hasAudio, "clip has audio");
  const sil = await detectSilence(clip, { noiseDb: -35, minSec: 0.3, totalSec: inf.videoDuration || inf.duration });
  console.log("silences", sil);
  assert.ok(sil.length >= 2, "expected lead + tail silence");
  const trim = computeClipTrim(inf, sil, { dialogue: true, trimLead: true });
  console.log("trim", trim);
  near(trim.start, 0.65, 0.12, "trim.start");
  near(trim.end, 4.2, 0.12, "trim.end");
  const noLead = computeClipTrim(inf, sil, { dialogue: true, trimLead: false });
  assert.equal(noLead.start, 0, "trimLead=false keeps the lead");
  const nonDialogue = computeClipTrim(inf, sil, { dialogue: false, trimLead: true });
  assert.equal(nonDialogue.start, 0); near(nonDialogue.end, 6, 0.1, "non-dialogue untouched");

  const dest = path.join(dir, "norm.mp4");
  await runFfmpegPlain(normalizeClipArgs(clip, inf, dest, trim), "trim normalize");
  const out = await probeMedia(dest);
  console.log("normalized", { duration: out.duration, videoDuration: out.videoDuration, hasAudio: out.hasAudio });
  near(out.videoDuration || out.duration, trim.end - trim.start, 0.15, "normalized length");
  assert.ok(out.hasAudio, "normalized keeps audio");

  // untrimmed path still works (backward compat)
  const dest2 = path.join(dir, "norm-full.mp4");
  await runFfmpegPlain(normalizeClipArgs(clip, inf, dest2), "full normalize");
  const out2 = await probeMedia(dest2);
  near(out2.videoDuration || out2.duration, 6, 0.15, "full length");

  await fs.rm(dir, { recursive: true, force: true });
  console.log("ALL OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
