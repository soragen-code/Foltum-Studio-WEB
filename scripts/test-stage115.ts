/**
 * Stage 115 — VARIABLE clip length (5–10 s, no frozen padding) + multi-clip dialogue.
 *  - durationSec is now content-driven, clamped into [SCENE_MIN_SECONDS, SCENE_CLIP_MAX_SECONDS] (default 8).
 *  - EPISODE_MAX_TOTAL_SECONDS (90 s) is a CEILING: the sum of scene durations must stay AT OR UNDER it.
 *  - EPISODE_SCENE_COUNT stays 9; a conversation may span several consecutive clips.
 *  - The prompts carry anti-freeze wording and drop the fixed "9 × 10 s = 90 s" language.
 *  Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage115.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  EPISODE_SCENE_COUNT,
  SCENE_MIN_SECONDS,
  SCENE_CLIP_MAX_SECONDS,
  SCENE_DEFAULT_SECONDS,
  SCENE_MAX_SECONDS,
  EPISODE_MAX_TOTAL_SECONDS,
  clampSceneDuration,
  applyFixedSceneDurations,
  episodeScriptSystemPrompt,
  seasonStructureSystemPrompt,
  sceneReviseSystemPrompt,
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
ok(EPISODE_SCENE_COUNT === 9, `EPISODE_SCENE_COUNT === 9 (got ${EPISODE_SCENE_COUNT})`);
ok(SCENE_MIN_SECONDS === 5, `SCENE_MIN_SECONDS === 5 (got ${SCENE_MIN_SECONDS})`);
ok(SCENE_CLIP_MAX_SECONDS === 10, `SCENE_CLIP_MAX_SECONDS === 10 (got ${SCENE_CLIP_MAX_SECONDS})`);
ok(SCENE_DEFAULT_SECONDS === 8, `SCENE_DEFAULT_SECONDS === 8 (got ${SCENE_DEFAULT_SECONDS})`);
ok(SCENE_MAX_SECONDS === 30, `SCENE_MAX_SECONDS === 30 (Seedance speech-split cap, untouched) (got ${SCENE_MAX_SECONDS})`);
ok(EPISODE_MAX_TOTAL_SECONDS === 90, `EPISODE_MAX_TOTAL_SECONDS === 90 ceiling (got ${EPISODE_MAX_TOTAL_SECONDS})`);

/* ---------------------------------------------------------------- (b) clampSceneDuration */
ok(clampSceneDuration(12) === 10, "clampSceneDuration(12) === 10 (over max → 10)");
ok(clampSceneDuration(3) === 5, "clampSceneDuration(3) === 5 (under min → 5)");
ok(clampSceneDuration(7) === 7, "clampSceneDuration(7) === 7 (in range preserved)");
ok(clampSceneDuration(undefined) === 8, "clampSceneDuration(undefined) === 8 (default)");
ok(clampSceneDuration(null) === 8, "clampSceneDuration(null) === 8 (default)");
ok(clampSceneDuration(NaN) === 8, "clampSceneDuration(NaN) === 8 (invalid → default)");
ok(clampSceneDuration(6.6) === 7, "clampSceneDuration(6.6) === 7 (rounded then clamped)");

/* ---------------------------------------------------------------- (c) applyFixedSceneDurations */
// Nine short valid clips, no trimming needed (sum 63 ≤ 90): each length preserved.
const shortSet = [5, 6, 7, 8, 5, 6, 7, 9, 10].map((d) => ({ durationSec: d }));
const shortTotal = applyFixedSceneDurations(shortSet);
ok(shortSet.every((s) => (s.durationSec ?? 0) >= 5 && (s.durationSec ?? 0) <= 10), "applyFixedSceneDurations keeps every clip in [5,10]");
ok(shortTotal <= 90 && shortTotal === 63, `applyFixedSceneDurations preserves lengths when sum ≤ 90 (got ${shortTotal})`);
// Nine max clips (9 × 10 = 90) — exactly at the ceiling, no trim.
const maxSet = Array.from({ length: 9 }, () => ({ durationSec: 10 }));
const maxTotal = applyFixedSceneDurations(maxSet);
ok(maxTotal === 90 && maxSet.every((s) => s.durationSec === 10), `9 × 10 s sits exactly at the ceiling (got ${maxTotal})`);
// Over-ceiling raw values are clamped then trimmed down to ≤ 90, never below the floor.
const overSet = Array.from({ length: 9 }, () => ({ durationSec: 30 }));
const overTotal = applyFixedSceneDurations(overSet);
ok(overTotal <= 90, `over-ceiling clips are trimmed to ≤ 90 (got ${overTotal})`);
ok(overSet.every((s) => (s.durationSec ?? 0) >= 5 && (s.durationSec ?? 0) <= 10), "trimmed clips never fall below the 5 s floor or above 10 s");

/* ---------------------------------------------------------------- (d) episode-script prompt: anti-freeze + variable + multi-clip */
for (const [lang, epNo] of [["ru", 1], ["en", 3]] as const) {
  const sys = episodeScriptSystemPrompt(lang, epNo);
  ok(/5–10 s/.test(sys), `ep${epNo}/${lang}: variable 5–10 s clip length stated`);
  ok(/EXACTLY 9 consecutive shots/.test(sys), `ep${epNo}/${lang}: still exactly 9 shots`);
  // anti-freeze wording
  ok(/frozen final|freeze|static pose|stare into the camera|held pose|until the cut/i.test(sys), `ep${epNo}/${lang}: anti-freeze wording present`);
  // multi-clip dialogue wording
  ok(/split it across consecutive scenes|spread across consecutive|across consecutive scenes|span several clips|DIALOGUE ACROSS CLIPS/i.test(sys), `ep${epNo}/${lang}: multi-clip dialogue wording present`);
  // ceiling, not fixed total
  ok(/at or under|does NOT exceed|up to 1:30|stay AT OR UNDER/i.test(sys), `ep${epNo}/${lang}: sum stated as a ceiling`);
  ok(!/9 × 10 s/.test(sys) && !/= 90 s/.test(sys), `ep${epNo}/${lang}: no leftover fixed 9 × 10 s = 90 s wording`);
}

/* ---------------------------------------------------------------- (e) season-structure + revise prompts */
const ss = seasonStructureSystemPrompt("en", 8);
ok(/5–10 s/.test(ss), "season prompt: clips stated as 5–10 s");
ok(!/9 short 10 s clips/.test(ss), "season prompt: no leftover '9 short 10 s clips'");
const rev = sceneReviseSystemPrompt("en");
ok(/5–10 s/.test(rev), "revise prompt: clip is 5–10 s");
ok(!/set durationSec = 10\b/.test(rev) && !/full 10 s clip/.test(rev), "revise prompt: no leftover 'set durationSec = 10' / 'full 10 s clip'");
ok(/frozen final|freeze|static pose|stare into the camera|no frozen/i.test(rev), "revise prompt: anti-freeze wording present");

/* ---------------------------------------------------------------- (f) scenes-job worker prompt (derived, textual) */
const scenesJob = read("lib/workers/scenes-job.ts");
ok(/UP TO|at most|at or under/i.test(scenesJob), "scenes-job: episode running time is a ceiling (UP TO / at most)");
ok(/VARIABLE/i.test(scenesJob) && /5–10 s/.test(scenesJob), "scenes-job: variable 5–10 s clips stated");
ok(/several consecutive shots|spread across|conversation is spread/i.test(scenesJob), "scenes-job: multi-clip dialogue stated");
ok(/frozen final beat|static pose|stare into the camera|no frozen/i.test(scenesJob), "scenes-job: anti-freeze wording present");

/* ---------------------------------------------------------------- (g) scene-prompt anti-freeze directive */
const scenePrompt = read("lib/scene-prompt.ts");
ok(/NO_FROZEN_PADDING_LINE/.test(scenePrompt), "scene-prompt: NO_FROZEN_PADDING_LINE defined and wired");
ok(/NO FROZEN PADDING/.test(scenePrompt), "scene-prompt: anti-freeze directive text present");

/* ---------------------------------------------------------------- (h) normalize preserves a valid variable length */
const videoPrompt = [
  "[SHOT TYPE]: wide two-shot of the whole loft → medium over-the-shoulder on Elena; vertical 9:16",
  "[VISUAL STYLE]: photoreal live-action, cold teal-and-amber palette",
  "[LIGHTING]: late evening, single desk lamp and grey rain light from the window",
  "[BLOCKING]: Mark crosses from the door to the desk; Elena rises and steps to the window",
  "[GAZE]: Mark locks eyes with Elena on his line; Elena looks away to the window",
  "[NON-VERBAL]: Mark's jaw tight; Elena's hands flat on the desk",
  "[ACTION]: Mark pushes the door open and crosses to the desk while Elena rises and slams the logbook shut.",
  "[CHARACTER]: Mark Ellison, 40, dark hair, navy rain jacket; Elena Voss, 36, red hair tied back, grey sweater",
  "[TRANSITION]: hard cut into the next shot",
].join("\n");
const dialogue = 'MARK (low): "You were at the pier last night."\nELENA (sharply): "Then go home, Mark. Now."';
const mkScene = (n: number, dur: number) => ({
  number: n, shotType: "Wide", durationSec: dur, locationDesc: "INT — office — night", characters: ["Mark", "Elena"],
  action: "Mark enters and crosses to the desk while Elena rises.", sceneKind: "dialogue" as const, dialogue,
  videoPrompt, presence: "both at the desk", entrances: "none", continuesFrom: "same-location-continuation",
  startState: "WORLD: Mark at the door. CAMERA: wide.", endState: "WORLD: Elena at the window. CAMERA: medium.",
});
// Varied lengths (sum 63 ≤ 90) — normalize must preserve each valid length, not force a fixed value.
const varied = [5, 6, 7, 8, 5, 6, 7, 9, 10];
const ep: EpisodeScript = normalizeEpisodeScript(episodeScriptSchema.parse({
  visualIdentity: "photoreal cinematic",
  scenes: varied.map((d, i) => mkScene(i + 1, d)),
}));
ok(ep.scenes.length === 9, `normalize keeps 9 scenes (got ${ep.scenes.length})`);
ok(ep.scenes.map((s) => s.durationSec).join(",") === varied.join(","), `normalize preserves each valid variable length (${ep.scenes.map((s) => s.durationSec).join(",")})`);
ok(ep.scenes.reduce((a, s) => a + s.durationSec, 0) <= 90, "normalized episode stays at or under the 90 s ceiling");
const cast = ["Mark Ellison", "Elena Voss"];
ok(hardProblems(validateEpisodeScript(ep, { characterNames: cast })).length === 0,
  `a valid variable-length 9-scene episode has no hard problems (${JSON.stringify(validateEpisodeScript(ep, { characterNames: cast }))})`);

console.log(`\nStage 115: PASS (${passed} checks)`);
