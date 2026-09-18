/**
 * Stage 115 — VARIABLE clip length + multi-clip dialogue.
 *  - durationSec is content-driven, clamped into [SCENE_MIN_SECONDS, SCENE_CLIP_MAX_SECONDS].
 *  - EPISODE_MAX_TOTAL_SECONDS is a CEILING: the sum of scene durations must stay AT OR UNDER it.
 *  - A conversation may span several consecutive clips.
 *  - The prompts carry anti-freeze + multi-clip wording.
 *  REBASELINED for Stage 166: clips are now 3–15 s (was 5–10), an episode is 5–8 scenes (was a fixed 9),
 *  the total budget is a 70–100 s band (was a 90 s ceiling), and clampSceneDuration default is 9 (was 8).
 *  The (h) normalize case keeps a legacy 9-scene episode to prove old episodes still load / validate.
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
ok(EPISODE_SCENE_COUNT === 8, `EPISODE_SCENE_COUNT === 8 (auto-path cap = EPISODE_MAX_SCENES) (got ${EPISODE_SCENE_COUNT})`);
ok(SCENE_MIN_SECONDS === 3, `SCENE_MIN_SECONDS === 3 (got ${SCENE_MIN_SECONDS})`);
ok(SCENE_CLIP_MAX_SECONDS === 15, `SCENE_CLIP_MAX_SECONDS === 15 (got ${SCENE_CLIP_MAX_SECONDS})`);
ok(SCENE_DEFAULT_SECONDS === 9, `SCENE_DEFAULT_SECONDS === 9 (got ${SCENE_DEFAULT_SECONDS})`);
ok(SCENE_MAX_SECONDS === 30, `SCENE_MAX_SECONDS === 30 (Seedance speech-split cap, untouched) (got ${SCENE_MAX_SECONDS})`);
ok(EPISODE_MAX_TOTAL_SECONDS === 100, `EPISODE_MAX_TOTAL_SECONDS === 100 ceiling (got ${EPISODE_MAX_TOTAL_SECONDS})`);

/* ---------------------------------------------------------------- (b) clampSceneDuration */
ok(clampSceneDuration(12) === 12, "clampSceneDuration(12) === 12 (in range preserved)");
ok(clampSceneDuration(3) === 3, "clampSceneDuration(3) === 3 (at floor preserved)");
ok(clampSceneDuration(20) === 15, "clampSceneDuration(20) === 15 (over max → 15)");
ok(clampSceneDuration(1) === 3, "clampSceneDuration(1) === 3 (under min → 3)");
ok(clampSceneDuration(7) === 7, "clampSceneDuration(7) === 7 (in range preserved)");
ok(clampSceneDuration(undefined) === 9, "clampSceneDuration(undefined) === 9 (default)");
ok(clampSceneDuration(null) === 9, "clampSceneDuration(null) === 9 (default)");
ok(clampSceneDuration(NaN) === 9, "clampSceneDuration(NaN) === 9 (invalid → default)");
ok(clampSceneDuration(6.6) === 7, "clampSceneDuration(6.6) === 7 (rounded then clamped)");

/* ---------------------------------------------------------------- (c) applyFixedSceneDurations */
// Short valid clips, no trimming needed (sum 63 ≤ 100): each length preserved.
const shortSet = [5, 6, 7, 8, 5, 6, 7, 9, 10].map((d) => ({ durationSec: d }));
const shortTotal = applyFixedSceneDurations(shortSet);
ok(shortSet.every((s) => (s.durationSec ?? 0) >= 3 && (s.durationSec ?? 0) <= 15), "applyFixedSceneDurations keeps every clip in [3,15]");
ok(shortTotal <= 100 && shortTotal === 63, `applyFixedSceneDurations preserves lengths when sum ≤ 100 (got ${shortTotal})`);
// Nine 10 s clips (sum 90 ≤ 100) — under the ceiling, no trim.
const maxSet = Array.from({ length: 9 }, () => ({ durationSec: 10 }));
const maxTotal = applyFixedSceneDurations(maxSet);
ok(maxTotal === 90 && maxSet.every((s) => s.durationSec === 10), `9 × 10 s clips preserved under the 100 s ceiling (got ${maxTotal})`);
// Over-ceiling raw values are clamped then trimmed down to ≤ 100, never below the floor / above the clip max.
const overSet = Array.from({ length: 9 }, () => ({ durationSec: 30 }));
const overTotal = applyFixedSceneDurations(overSet);
ok(overTotal <= 100, `over-ceiling clips are trimmed to ≤ 100 (got ${overTotal})`);
ok(overSet.every((s) => (s.durationSec ?? 0) >= 3 && (s.durationSec ?? 0) <= 15), "trimmed clips never fall below the 3 s floor or above the 15 s clip max");

/* ---------------------------------------------------------------- (d) episode-script prompt: anti-freeze + variable + multi-clip */
for (const [lang, epNo] of [["ru", 1], ["en", 3]] as const) {
  const sys = episodeScriptSystemPrompt(lang, epNo);
  ok(/3–15 s/.test(sys), `ep${epNo}/${lang}: variable 3–15 s clip length stated`);
  ok(/5–8 consecutive shots/.test(sys), `ep${epNo}/${lang}: content-driven 5–8 shots`);
  // anti-freeze wording
  ok(/frozen final|freeze|static pose|stare into the camera|held pose|until the cut/i.test(sys), `ep${epNo}/${lang}: anti-freeze wording present`);
  // multi-clip dialogue wording
  ok(/split it across consecutive scenes|spread across consecutive|across consecutive scenes|span several clips|DIALOGUE ACROSS CLIPS/i.test(sys), `ep${epNo}/${lang}: multi-clip dialogue wording present`);
  // ceiling, not fixed total
  ok(/between 70 and 100 s|lands between|stay AT OR UNDER|at or under/i.test(sys), `ep${epNo}/${lang}: total stated as a 70–100 s band`);
  ok(!/9 × 10 s/.test(sys) && !/= 90 s/.test(sys), `ep${epNo}/${lang}: no leftover fixed 9 × 10 s = 90 s wording`);
}

/* ---------------------------------------------------------------- (e) season-structure + revise prompts */
const ss = seasonStructureSystemPrompt("en", 8);
ok(/3–15 s/.test(ss), "season prompt: clips stated as 3–15 s");
ok(!/9 short 10 s clips/.test(ss), "season prompt: no leftover '9 short 10 s clips'");
const rev = sceneReviseSystemPrompt("en");
ok(/3–15 s/.test(rev), "revise prompt: clip is 3–15 s");
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
// Stage 166 — a LEGACY 9-scene episode must still LOAD/VALIDATE. The AUTO normalize path caps new episodes
// at EPISODE_MAX_SCENES (8), but the MANUAL path preserves every authored scene, so we use it here to prove
// an existing 9-scene episode is carried through intact with each valid variable length preserved.
const varied = [5, 6, 7, 8, 5, 6, 7, 9, 10];
const ep: EpisodeScript = normalizeEpisodeScript(episodeScriptSchema.parse({
  visualIdentity: "photoreal cinematic",
  scenes: varied.map((d, i) => mkScene(i + 1, d)),
}), undefined, { manual: true });
ok(ep.scenes.length === 9, `manual normalize keeps a legacy 9-scene episode (got ${ep.scenes.length})`);
ok(ep.scenes.map((s) => s.durationSec).join(",") === varied.join(","), `normalize preserves each valid variable length (${ep.scenes.map((s) => s.durationSec).join(",")})`);
ok(ep.scenes.reduce((a, s) => a + s.durationSec, 0) <= 100, "normalized episode stays at or under the 100 s ceiling");
const cast = ["Mark Ellison", "Elena Voss"];
ok(hardProblems(validateEpisodeScript(ep, { characterNames: cast })).length === 0,
  `a legacy 9-scene episode still validates with no HARD problems (${JSON.stringify(validateEpisodeScript(ep, { characterNames: cast }))})`);
// AUTO path caps a fresh episode at EPISODE_MAX_SCENES (content-driven 5–8).
const epAuto: EpisodeScript = normalizeEpisodeScript(episodeScriptSchema.parse({
  visualIdentity: "photoreal cinematic",
  scenes: varied.map((d, i) => mkScene(i + 1, d)),
}));
ok(epAuto.scenes.length === 8, `auto normalize caps a fresh episode at EPISODE_MAX_SCENES=8 (got ${epAuto.scenes.length})`);

console.log(`\nStage 115: PASS (${passed} checks)`);
