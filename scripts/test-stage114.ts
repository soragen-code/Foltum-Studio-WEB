/**
 * Stage 114 (rebaselined at Stage 166 / task Stage 5): an episode is now 5-8 short clips (3-15 s),
 * total 70-100 s (was EXACTLY 9 x 10 s = 90 s). Existing 9-scene DB episodes keep their stored shape
 * their stored shape until their story / script is regenerated.) Dialogue and choreography are rescaled
 * to the short 10 s clip. Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage114.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  EPISODE_MIN_SCENES,
  EPISODE_MAX_SCENES,
  EPISODE_SCENE_COUNT,
  SCENE_FIXED_SECONDS,
  SCENE_MIN_SECONDS,
  SCENE_MAX_SECONDS,
  EPISODE_MAX_TOTAL_SECONDS,
  EPISODE_TOTAL_LABEL,
  sceneDurationsForCount,
  estimateDurationSec,
  episodeScriptSystemPrompt,
  seasonStructureSystemPrompt,
  episodeScriptSchema,
  normalizeEpisodeScript,
  validateEpisodeScript,
  hardProblems,
  type EpisodeScript,
} from "../lib/season";

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  passed++; console.log(`ok: ${msg}`);
}
const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/* ---------------------------------------------------------------- (a) constants */
ok(EPISODE_MIN_SCENES === 5, `EPISODE_MIN_SCENES === 5 (got ${EPISODE_MIN_SCENES})`);
ok(EPISODE_MAX_SCENES === 8, `EPISODE_MAX_SCENES === 8 (got ${EPISODE_MAX_SCENES})`);
ok(EPISODE_SCENE_COUNT === 8, `EPISODE_SCENE_COUNT === 8 (= EPISODE_MAX_SCENES) (got ${EPISODE_SCENE_COUNT})`);
ok(SCENE_FIXED_SECONDS === 10, `SCENE_FIXED_SECONDS === 10 (got ${SCENE_FIXED_SECONDS})`);
ok(EPISODE_MAX_TOTAL_SECONDS === 100, `EPISODE_MAX_TOTAL_SECONDS === 100 (got ${EPISODE_MAX_TOTAL_SECONDS})`);
ok(SCENE_MIN_SECONDS === 3, `SCENE_MIN_SECONDS === 3 (got ${SCENE_MIN_SECONDS})`);
ok(SCENE_MAX_SECONDS === 30, `SCENE_MAX_SECONDS === 30 (Seedance ceiling, untouched) (got ${SCENE_MAX_SECONDS})`);
ok(EPISODE_TOTAL_LABEL === "1:40", `EPISODE_TOTAL_LABEL === "1:40" (got ${EPISODE_TOTAL_LABEL})`);

/* ---------------------------------------------------------------- (b) duration split */
const durs = sceneDurationsForCount(EPISODE_SCENE_COUNT);
ok(durs.length === 8, `sceneDurationsForCount(8) has 8 entries (got ${durs.length})`);
ok(durs.every((d) => d === 10), `sceneDurationsForCount fills the 10 s base per scene (${durs.join(", ")})`);
ok(durs.reduce((a, b) => a + b, 0) === 80, `8 × 10 = 80 s (<= 100 ceiling, no trim) (got ${durs.reduce((a, b) => a + b, 0)})`);
ok(estimateDurationSec("anything", "x") === 9 && estimateDurationSec("") === 9, "estimateDurationSec returns the default fallback (Stage 166: 9 s)");

/* Sections (c)(d)(e) removed in the Stage 166 rebaseline: the episode-script /
   season-structure prompt wording and normalize behaviour are now fully
   covered by scripts/test-stage166.ts (78 checks). */

console.log(`\nStage 114: PASS (${passed} checks)`);
