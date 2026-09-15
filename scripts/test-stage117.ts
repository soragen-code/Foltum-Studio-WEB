/**
 * Stage 117 checks (pure, no ffmpeg / network / credits):
 *  A. seam is a frame-exact HARD cut on BOTH video and audio — no blend, no afade, no xfade;
 *  B. background music is ONE continuous looped track — hard start (no fade-in), a single minimal
 *     fade-out only at the very finale, no per-scene/seam fades;
 *  C. the default join mode stays the seamless hard cut; the final render loops one music input.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage117.ts
 */
import {
  buildSeamlessCutGraph,
  SEAM_AUDIO_FADE_SEC,
  SEAM_TAIL_TRIM_SEC,
  buildMusicMixFilter,
  MUSIC_FINAL_FADEOUT_SEC,
  buildFinalRenderArgs,
  DEFAULT_STITCH_MODE,
  type MediaInfo,
} from "../lib/ffmpeg";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const info = (d: number): MediaInfo =>
  ({ duration: d, videoDuration: d, hasVideo: true, hasAudio: true, width: 720, height: 1280, fps: 24 } as MediaInfo);

// ── A. seam = hard cut on video AND audio ───────────────────────────────────────────────────────
{
  ok(SEAM_AUDIO_FADE_SEC === 0, "A: SEAM_AUDIO_FADE_SEC === 0 (no seam audio fade)");
  const g = buildSeamlessCutGraph([info(5), info(5), info(5)]);
  ok(g.blend === 0, "A: video blend === 0 (hard visual cut)");
  ok(g.audioFade === 0, "A: audioFade === 0 (hard audio cut)");
  ok(!g.filter.includes("afade"), "A: no afade anywhere in the graph");
  ok(!g.filter.includes("xfade") && !g.filter.includes("acrossfade"), "A: no xfade / acrossfade");
  ok(g.filter.includes("concat=n=3:v=1:a=1"), "A: clips joined with concat=n=3:v=1:a=1");
  // Tail trim still applies (0.35 s off every clip but the last).
  ok(SEAM_TAIL_TRIM_SEC === 0.35, "A: SEAM_TAIL_TRIM_SEC === 0.35 (tail trim kept — it is a trim, not a fade)");
  ok(
    near(g.clipDurations[0], 4.65) && near(g.clipDurations[1], 4.65) && near(g.clipDurations[2], 5.0),
    "A: clipDurations (4.65, 4.65, 5.0) — tail trim still active"
  );
}

// ── B. one continuous music track, hard start, single finale fade-out ────────────────────────────
{
  ok(MUSIC_FINAL_FADEOUT_SEC === 1.5, "B: MUSIC_FINAL_FADEOUT_SEC === 1.5");
  const f = buildMusicMixFilter({ durationSec: 60 });
  ok(f.includes("volume=0.18"), "B: default music volume 0.18");
  ok(!f.includes("afade=t=in"), "B: no fade-in — hard music start");
  ok(f.includes("afade=t=out:st=58.500:d=1.50"), "B: single 1.5 s fade-out at the finale (60 s)");
  ok((f.match(/afade/g) || []).length === 1, "B: exactly ONE afade — the finale only, no seam fades");
  ok(f.startsWith("[1:a]atrim=0:60.000"), "B: one input trimmed to the whole episode (single continuous track)");
  ok(!f.includes("adelay"), "B: no adelay — no segmented/staggered music inputs");
  ok(
    f.includes("[c][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"),
    "B: clip audio primary (duration=first, no normalisation), one music input mixed"
  );
  // Fully hard-cut music (both fades disabled) emits no afade at all.
  const hard = buildMusicMixFilter({ durationSec: 60, fadeIn: 0, fadeOut: 0 });
  ok(!hard.includes("afade"), "B: fadeIn=0 & fadeOut=0 → no afade (pure hard cut music)");
}

// ── C. default join mode + final render loops one music track ────────────────────────────────────
{
  ok(DEFAULT_STITCH_MODE === "seamless-cut", "C: DEFAULT_STITCH_MODE === 'seamless-cut'");
  const render = buildFinalRenderArgs({
    input: "/tmp/joined.mp4",
    output: "/tmp/out.mp4",
    quality: "480p",
    fps: 30,
    musicPath: "/tmp/music.mp3",
    hasVoice: true,
    durationSec: 60,
  });
  const a = render.args.join(" ");
  ok(a.includes("-stream_loop -1 -i /tmp/music.mp3"), "C: single music input looped with -stream_loop -1");
  ok((a.match(/-stream_loop/g) || []).length === 1, "C: exactly one looped music input (one continuous track)");
  ok(a.includes("amix=inputs=2:duration=first"), "C: music mixed under the clip audio (duration=first)");
  ok(a.includes("-c:v copy") || a.includes("-c copy"), "C: 480p/30 video is stream-copied (not re-encoded)");
  ok(!a.includes("xfade"), "C: final render has no xfade");
}

console.log(`\nStage 117: PASS (${passed} checks)`);
