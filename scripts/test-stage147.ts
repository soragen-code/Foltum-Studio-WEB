/**
 * Stage 147 — every generated REFERENCE image is rendered in 9:16 (vertical), matching the video.
 *
 * Reference generators covered: character references (worker + regenerate + per-shot route), set / location
 * plates (location-image-job, location-extra-image-job, region-plate-job, locations/[id]/shot route),
 * scene / board anchors + board frames (storyboard-job via buildBoardFramePrompt), artifact references.
 *
 * The check is source-level (mock, no network): every reference image-generation call must pass a 9:16
 * aspect ratio — either the shared REFERENCE_ASPECT_RATIO constant or the "9:16" literal — and NO reference
 * generator may pass a non-9:16 ratio (1:1 / 16:9 / 3:4 / 4:3). It also re-asserts the S133–S146 invariants
 * that live near the reference pipeline so this change did not disturb them.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_ASPECT_RATIO, VISUAL_STYLE_ID } from "../lib/visual-style";
import { buildBoardFramePrompt } from "../lib/storyboard-prompt";
import { PACE_DIRECTION, SCALE_DEPTH_RULE } from "../lib/season";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let checks = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  checks++;
  console.log("ok:", msg);
}

/* ── A) the shared reference aspect ratio is vertical 9:16 ────────────────────── */
ok(REFERENCE_ASPECT_RATIO === "9:16", "A: REFERENCE_ASPECT_RATIO is the vertical 9:16 ratio");
ok(typeof VISUAL_STYLE_ID === "string" && VISUAL_STYLE_ID.length > 0, "A: VISUAL_STYLE_ID is defined");

/* ── B) scene/board anchor + board frame prompts render at 9:16 ───────────────── */
const boardResult = buildBoardFramePrompt({
  board: { index: 0, actionOrDialogue: 'ANNA (worried): "Are you sure?"', motion: null, directionJson: null },
  characters: [],
  locationName: "Kitchen",
  locationDesc: "A small kitchen at night.",
});
ok(boardResult.aspectRatio === REFERENCE_ASPECT_RATIO, "B: buildBoardFramePrompt returns REFERENCE_ASPECT_RATIO (board frame / scene anchor)");
ok(boardResult.aspectRatio === "9:16", "B: board frame aspect ratio is 9:16");

/* ── C) source scan: every reference generator passes a 9:16 ratio ───────────── */
// Each entry: file + list of the exact aspect_ratio argument tokens that must all be 9:16-equivalent.
const NINE_SIXTEEN = new Set(["REFERENCE_ASPECT_RATIO", '"9:16"', "'9:16'", "ASPECT_RATIOS[shot]", "ASPECT[shot]", "aspectRatios[shot]"]);
const BANNED = /aspect_ratio:\s*("16:9"|"1:1"|"3:4"|"4:3"|'16:9'|'1:1'|'3:4'|'4:3')/;

const refFiles = [
  "lib/workers/character-images-job.ts",
  "app/api/ai/characters/regenerate/route.ts",
  "app/api/ai/characters/[id]/shot/route.ts",
  "lib/workers/location-image-job.ts",
  "lib/workers/location-extra-image-job.ts",
  "lib/workers/region-plate-job.ts",
  "app/api/ai/locations/[id]/shot/route.ts",
  "lib/workers/storyboard-job.ts",
  "lib/workers/artifact-images-job.ts",
  "app/api/ai/artifacts/[id]/revise/route.ts",
];

for (const rel of refFiles) {
  const src = read(rel);
  // no banned (non-9:16) aspect ratio anywhere in a reference generator
  ok(!BANNED.test(src), `C: no non-9:16 reference generation in ${rel}`);
  // every aspect_ratio argument passed is a 9:16-equivalent token (skip the `aspect_ratio: string`
  // TS type annotation, which is a declaration, not a passed value)
  const args = [...src.matchAll(/aspect_ratio:\s*([^,};\n]+)/g)]
    .map((m) => m[1].trim())
    .filter((a) => a !== "string");
  ok(args.length > 0, `C: ${rel} passes an aspect_ratio to at least one generation call`);
  for (const a of args) {
    ok(NINE_SIXTEEN.has(a), `C: ${rel} aspect_ratio arg '${a}' is a 9:16 reference ratio`);
  }
}

/* character shot maps must resolve to REFERENCE_ASPECT_RATIO for every shot */
const charWorker = read("lib/workers/character-images-job.ts");
ok(/ASPECT_RATIOS[^\n]*REFERENCE_ASPECT_RATIO[^\n]*REFERENCE_ASPECT_RATIO[^\n]*REFERENCE_ASPECT_RATIO/.test(charWorker),
  "C: character worker ASPECT_RATIOS maps front/profile/full all to REFERENCE_ASPECT_RATIO");
const charShot = read("app/api/ai/characters/[id]/shot/route.ts");
ok(/ASPECT[^\n]*REFERENCE_ASPECT_RATIO[^\n]*REFERENCE_ASPECT_RATIO[^\n]*REFERENCE_ASPECT_RATIO/.test(charShot),
  "C: character per-shot route ASPECT maps all shots to REFERENCE_ASPECT_RATIO");

/* location/plate reference files consolidated on the shared constant (no lingering literals) */
for (const rel of [
  "lib/workers/location-image-job.ts",
  "lib/workers/location-extra-image-job.ts",
  "lib/workers/region-plate-job.ts",
  "app/api/ai/locations/[id]/shot/route.ts",
]) {
  const src = read(rel);
  ok(src.includes("REFERENCE_ASPECT_RATIO"), `C: ${rel} uses the shared REFERENCE_ASPECT_RATIO constant`);
  ok(!/aspect_ratio:\s*["']9:16["']/.test(src), `C: ${rel} has no hardcoded 9:16 literal left`);
}

/* storyboard-prompt keeps the 9:16 board result on the shared constant */
const sbPrompt = read("lib/storyboard-prompt.ts");
ok(/aspectRatio:\s*REFERENCE_ASPECT_RATIO/.test(sbPrompt), "C: storyboard-prompt returns REFERENCE_ASPECT_RATIO");

/* ── D) invariants S133–S146 near the reference pipeline are intact ───────────── */
// 9:16 video output (scene video generation), untouched
const videoJob = read("lib/workers/video-job.ts");
ok(/aspect_ratio:\s*"9:16"/.test(videoJob), "D: scene video output stays 9:16 (S133)");
// S139 — dialogue reconciliation still present
ok(read("lib/storyboard-direction.ts").includes("reconcileSpeechIds"), "D: S139 reconcileSpeechIds present");
// S142 anchor + S144 continuity lines
const boardAnchor = read("lib/board-anchor.ts");
ok(boardAnchor.includes("buildSceneAnchorLine"), "D: S142 scene anchor line present");
ok(boardAnchor.includes("buildContinuityLine"), "D: S144 continuity line present");
// S145 — sequential generation guard
ok(read("app/api/ai/episodes/[id]/generate-all/route.ts").includes("GENERATE_ALL_CONCURRENCY"),
  "D: S145 sequential generation concurrency present");
// Stage 146 — character-forward directing wording intact
ok(/character/i.test(SCALE_DEPTH_RULE) && /CHARACTERS/.test(SCALE_DEPTH_RULE),
  "D: Stage 146 SCALE_DEPTH_RULE stays character-forward");
ok(typeof PACE_DIRECTION === "string" && PACE_DIRECTION.length > 0, "D: PACE_DIRECTION present");

console.log(`\nStage 147: PASS (${checks} checks)`);
