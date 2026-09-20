/**
 * Stage 184 — subtitles are COMPLETELY REMOVED from the product + generation pipeline.
 *
 * This suite proves, offline and synthetically, the two things the subtitle-removal change must hold:
 *
 *   #10  The subtitle machinery is gone and the assembly path never calls it:
 *          - lib/shot-pipeline.ts no longer exports buildSubtitleSpec / subtitleSpecToAss (and the
 *            SubtitleCue / SubtitleSpec types are gone), while the surviving pure helpers still work;
 *          - lib/ffmpeg.ts no longer exports burnSubtitlesFile;
 *          - the assembly worker source (lib/workers/assembly-job.ts) contains NO reference to any
 *            subtitle symbol, .ass authoring, or a subtitle burn — the output is joined clips + music.
 *
 *   #11  The assembly TIMELINE is derived from the ACTUAL clip durations, not a planned per-shot value,
 *        so no dialogue line is silently truncated to a plan:
 *          - buildConcatPlan preserves each shot's own duration and orders by the chain index;
 *          - buildSeamlessCutGraph's expected output duration = sum of the real clip durations minus
 *            only the uniform seam tail-trim (bounded, never below the min-clip floor) — it never
 *            clamps a clip to an external "planned" number;
 *          - buildFinalRenderArgs binds the final `-t` to the duration it is GIVEN (the probed joined
 *            duration in production), never to a shorter planned value.
 *
 *   #12  Provider-timing note (documented, not asserted): the ACTUAL returned-file duration of each
 *        generated clip is a real-provider fact that is NOT persisted anywhere today. Verifying that a
 *        generated clip fully contains its spoken line requires a real (non-paid-here) re-assembly and
 *        an ffprobe of the returned file; it CANNOT be checked in this offline suite and is called out
 *        rather than faked. See section 12 below.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations, NO ffmpeg run.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage184.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import * as shotPipeline from "../lib/shot-pipeline";
import * as ffmpeg from "../lib/ffmpeg";
import { buildConcatPlan } from "../lib/shot-pipeline";
import { buildSeamlessCutGraph, buildFinalRenderArgs, SEAM_TAIL_TRIM_SEC, SEAM_TAIL_TRIM_MIN_CLIP_SEC, type MediaInfo } from "../lib/ffmpeg";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

const REPO_ROOT = join(__dirname, "..");
function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/* ───────────── 10) the subtitle machinery is gone and nothing calls it ───────────── */
{
  // The removed subtitle helpers must NOT be exported by the modules that used to own them.
  ok(typeof (shotPipeline as Record<string, unknown>).buildSubtitleSpec === "undefined", "shot-pipeline no longer exports buildSubtitleSpec");
  ok(typeof (shotPipeline as Record<string, unknown>).subtitleSpecToAss === "undefined", "shot-pipeline no longer exports subtitleSpecToAss");
  ok(typeof (ffmpeg as Record<string, unknown>).burnSubtitlesFile === "undefined", "ffmpeg no longer exports burnSubtitlesFile");

  // The surviving pure helpers still work (removal did not break the assembly plan builder).
  ok(typeof shotPipeline.buildConcatPlan === "function", "shot-pipeline still exports buildConcatPlan");
  ok(typeof shotPipeline.musicForBeat === "function", "shot-pipeline still exports musicForBeat");
  ok(typeof ffmpeg.assembleEpisodeLocally === "function", "ffmpeg still exports assembleEpisodeLocally");

  // The assembly worker source must reference no subtitle machinery of any kind. We scan the raw
  // source (not just the runtime exports) so a stray import / .ass authoring / burn call is caught.
  const assemblySrc = readSource("lib/workers/assembly-job.ts");
  for (const needle of ["buildSubtitleSpec", "subtitleSpecToAss", "burnSubtitlesFile", "SubtitleSpec", "SubtitleCue", ".ass", "subs.ass"]) {
    ok(!assemblySrc.includes(needle), `assembly-job.ts contains no reference to \`${needle}\``);
  }
  // A defensive check on the intent, too: no "burn subtitle" phrasing survives as live code.
  ok(!/burnSubtitle/i.test(assemblySrc), "assembly-job.ts has no burnSubtitle* call");
}

/* ───────────── 11) the timeline is built from ACTUAL clip durations, never a plan ───────────── */
{
  // buildConcatPlan keeps each shot's own duration and orders by the sequential chain index.
  const plan = buildConcatPlan([
    { index: 2, duration: 3.0, postFx: "none", videoUrl: "https://x/c3.mp4" },
    { index: 0, duration: 2.5, postFx: "none", videoUrl: "https://x/c1.mp4" },
    { index: 1, duration: 4.0, postFx: "none", videoUrl: "https://x/c2.mp4" },
  ]);
  ok(plan.clips.map((c) => c.index).join(",") === "0,1,2", "buildConcatPlan orders clips by the chain index");
  ok(plan.clips.map((c) => c.duration).join(",") === "2.5,4,3", "buildConcatPlan preserves each shot's own planned duration (no clamping)");
  ok(Math.abs(plan.totalDuration - 9.5) < 1e-9, "buildConcatPlan.totalDuration is the exact sum of the clip durations");
  ok(plan.ready === true, "buildConcatPlan is ready when every shot has a videoUrl");

  const notReady = buildConcatPlan([
    { index: 0, duration: 2.5, postFx: "none", videoUrl: "https://x/c1.mp4" },
    { index: 1, duration: 4.0, postFx: "none", videoUrl: null },
  ]);
  ok(notReady.ready === false, "buildConcatPlan is NOT ready while any shot is still ungenerated");

  // buildSeamlessCutGraph's expected duration = sum(actual clip durations) minus only the uniform
  // seam tail-trim on the non-last clips (and only while the remainder stays >= the min-clip floor).
  // It NEVER clamps a clip to an external planned number — a clip that runs long stays long.
  const mk = (videoDuration: number): MediaInfo => ({ hasVideo: true, hasAudio: true, duration: videoDuration, videoDuration, width: 720, height: 1280, fps: 24 });
  const infos = [mk(4.0), mk(6.0), mk(3.0)]; // e.g. a middle clip that ran LONGER than any plan
  const graph = buildSeamlessCutGraph(infos);
  const trim = SEAM_TAIL_TRIM_SEC;
  // clip0 & clip1 lose `trim` at the tail (both stay >= the floor); clip2 (last) is untouched.
  const expected = (4.0 - trim) + (6.0 - trim) + 3.0;
  ok(Math.abs(graph.expectedDuration - expected) < 1e-6, "seamless-cut expected duration = sum(actual clip durations) - uniform seam trim (long clip kept full-length, not clamped to a plan)");
  ok(graph.clipDurations[1] > 4.0, "a clip that ran longer than its neighbours keeps its extra length in the timeline");
  ok(graph.clipDurations[2] === 3.0, "the LAST clip is never tail-trimmed");

  // The seam trim is bounded: a clip at the min-clip floor is left FULL rather than shrunk below it.
  const shortInfos = [mk(SEAM_TAIL_TRIM_MIN_CLIP_SEC + SEAM_TAIL_TRIM_SEC - 0.01), mk(3.0)];
  const shortGraph = buildSeamlessCutGraph(shortInfos);
  ok(shortGraph.clipDurations[0] === shortInfos[0].videoDuration, "a clip that would fall below the min-clip floor is kept full (seam trim is bounded, never silent over-trim)");

  // buildFinalRenderArgs binds the final `-t` to the duration it is GIVEN (the probed joined length in
  // production), never to a shorter planned value — with music the whole joined timeline is kept.
  const withMusic = buildFinalRenderArgs({ input: "/w/joined.mp4", output: "/w/ep.mp4", quality: "480p", fps: 30, musicPath: "/w/music.mp3", durationSec: 42.5 });
  const tIdx = withMusic.args.indexOf("-t");
  ok(tIdx !== -1 && withMusic.args[tIdx + 1] === "42.500", "final render `-t` equals the given (probed joined) duration, not a planned value");
  // 480p/30 with no music is a pure stream copy — no `-t` clamp is imposed at all.
  const noMusic = buildFinalRenderArgs({ input: "/w/joined.mp4", output: "/w/ep.mp4", quality: "480p", fps: 30, durationSec: 42.5 });
  ok(!noMusic.args.includes("-t") && noMusic.reencodesVideo === false, "native-quality no-music render is a pure stream copy (no `-t` truncation)");
}

/* ───────────── 12) provider-timing fact that CANNOT be checked offline (documented) ───────────── */
{
  // The ACTUAL returned-file duration of a generated clip is a real-provider fact that is not stored
  // anywhere today, so this suite deliberately does not (and cannot) assert it. We keep this as an
  // explicit, honest note instead of faking a provider result.
  console.log("NOTE (stage 184 #12): the actual returned-file duration of each generated clip is NOT persisted; verifying a clip fully contains its spoken line needs a real (non-paid-here) re-assembly + ffprobe, so it is out of scope for this offline suite.");
  ok(true, "provider-timing verification is documented as requiring a real re-assembly (not faked here)");
}

console.log(`\nStage 184: PASS (${passed} checks)`);
