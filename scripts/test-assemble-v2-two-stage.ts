/**
 * Real-ffmpeg check of the v2 episode assemble two-stage pipeline (normalizeClipArgs per clip →
 * concat demuxer -c copy → audio-only music pass). Generates synthetic clips (mixed resolution/fps,
 * one silent) in a temp dir. Run: npx tsx scripts/test-assemble-v2-two-stage.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeClipArgs } from "../lib/workers/episode-assemble-v2-job";
import { probeMedia, runFfmpegPlain, runFfmpegWithProgress } from "../lib/ffmpeg";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FF: string = process.env.FFMPEG_PATH || require("ffmpeg-static");
const gen = (args: string[]) => execFileSync(FF, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm2-"));
  const a = path.join(dir, "a.mp4"), b = path.join(dir, "b.mp4"), c = path.join(dir, "c's.mp4"), m = path.join(dir, "music.audio");
  gen(["-f", "lavfi", "-i", "testsrc=s=720x1280:r=30:d=5", "-f", "lavfi", "-i", "sine=f=440:d=4.6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", a]);
  gen(["-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=24:d=4", "-c:v", "libx264", "-preset", "ultrafast", b]); // silent
  gen(["-f", "lavfi", "-i", "testsrc=s=1280x720:r=25:d=3.5", "-f", "lavfi", "-i", "sine=f=660:d=5", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "3.5", c]);
  gen(["-f", "lavfi", "-i", "sine=f=220:d=6", "-f", "mp3", m]);

  const files = [a, b, c];
  const infos = await Promise.all(files.map((f) => probeMedia(f)));
  assert.equal(infos[1].hasAudio, false);
  const totalSec = infos.reduce((s, i) => s + (i.videoDuration || i.duration || 0), 0);

  const norm: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const dest = path.join(dir, `clip_norm_${i}.mp4`);
    const args = normalizeClipArgs(files[i], infos[i], dest);
    if (!infos[i].hasAudio) assert.ok(!args.join(" ").includes("afade"), "silent clip has no fades");
    else assert.ok(args.join(" ").includes("curve=qsin"), "voiced clip has qsin fades");
    await runFfmpegPlain(args, `normalize ${i}`);
    const ni = await probeMedia(dest);
    assert.ok(ni.hasVideo && ni.hasAudio, `norm ${i} has A+V`);
    norm.push(dest);
  }

  const list = path.join(dir, "concat.txt");
  await fs.writeFile(list, norm.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const joined = path.join(dir, "joined.mp4");
  await runFfmpegPlain(["-f", "concat", "-safe", "0", "-i", list, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", joined], "concat");
  const ji = await probeMedia(joined);
  console.log("joined:", ji, "expected ≈", totalSec.toFixed(3));
  assert.ok(Math.abs((ji.videoDuration || ji.duration) - totalSec) < 0.15, "joined duration ≈ sum of clips");

  const T = totalSec.toFixed(3);
  const graph = [
    `[0:a]asplit=2[acat1][acat2]`,
    `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${T},asetpts=PTS-STARTPTS,volume=0.25,afade=t=in:st=0:d=1.5:curve=qsin,afade=t=out:st=${(totalSec - 2.5).toFixed(3)}:d=2.5:curve=qsin[mus]`,
    `[mus][acat1]sidechaincompress=threshold=0.04:ratio=4:attack=120:release=600:makeup=1[musd]`,
    `[acat2][musd]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
  ].join(";");
  const out = path.join(dir, "episode.mp4");
  let last = 0;
  await runFfmpegWithProgress(["-i", joined, "-stream_loop", "-1", "-i", m, "-filter_complex", graph, "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", out], "mix", totalSec, (p) => { last = p; });
  const oi = await probeMedia(out);
  console.log("final:", oi, "progress", last);
  assert.ok(oi.hasVideo && oi.hasAudio, "final has A+V");
  assert.ok(Math.abs((oi.duration || 0) - totalSec) < 0.2, "final duration ≈ sum (music looped/trimmed to episode)");
  await fs.rm(dir, { recursive: true, force: true });
  console.log("PASS two-stage assemble v2");
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
