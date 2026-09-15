/**
 * Stage 114 — an episode is EXACTLY 9 short 10 s shots = 90 s (1:30).
 * (Stage 103 had 2 × 30 s = 60 s. Existing two-/four-scene DB episodes are NOT migrated — they keep
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
ok(EPISODE_MIN_SCENES === 9, `EPISODE_MIN_SCENES === 9 (got ${EPISODE_MIN_SCENES})`);
ok(EPISODE_MAX_SCENES === 9, `EPISODE_MAX_SCENES === 9 (got ${EPISODE_MAX_SCENES})`);
ok(EPISODE_SCENE_COUNT === 9, `EPISODE_SCENE_COUNT === 9 (got ${EPISODE_SCENE_COUNT})`);
ok(SCENE_FIXED_SECONDS === 10, `SCENE_FIXED_SECONDS === 10 (got ${SCENE_FIXED_SECONDS})`);
ok(EPISODE_MAX_TOTAL_SECONDS === 90, `EPISODE_MAX_TOTAL_SECONDS === 90 (got ${EPISODE_MAX_TOTAL_SECONDS})`);
ok(SCENE_MIN_SECONDS === 5, `SCENE_MIN_SECONDS === 5 (got ${SCENE_MIN_SECONDS})`);
ok(SCENE_MAX_SECONDS === 30, `SCENE_MAX_SECONDS === 30 (Seedance ceiling, untouched) (got ${SCENE_MAX_SECONDS})`);
ok(EPISODE_TOTAL_LABEL === "1:30", `EPISODE_TOTAL_LABEL === "1:30" (got ${EPISODE_TOTAL_LABEL})`);

/* ---------------------------------------------------------------- (b) duration split */
const durs = sceneDurationsForCount(EPISODE_SCENE_COUNT);
ok(durs.length === 9, `sceneDurationsForCount(9) has 9 entries (got ${durs.length})`);
ok(durs.every((d) => d === 10), `sceneDurationsForCount still returns the legacy 10 s ceiling per scene (${durs.join(", ")})`);
ok(durs.reduce((a, b) => a + b, 0) === 90, `9 × 10 = 90 s ceiling (got ${durs.reduce((a, b) => a + b, 0)})`);
// Stage 115 — estimateDurationSec is a legacy helper now returning the default fallback (8 s); real clip length is content-driven.
ok(estimateDurationSec("anything", "x") === 8 && estimateDurationSec("") === 8, "estimateDurationSec returns the default fallback (Stage 115: 8 s)");

/* ---------------------------------------------------------------- (c) episode-script prompt */
for (const [lang, epNo] of [["ru", 1], ["en", 3]] as const) {
  const sys = episodeScriptSystemPrompt(lang, epNo);
  ok(/EXACTLY 9 consecutive shots/.test(sys), `ep${epNo}/${lang}: "EXACTLY 9 consecutive shots"`);
  ok(sys.includes("1:30"), `ep${epNo}/${lang}: 1:30 running-time label`);
  // Stage 115 — variable clip length: the prompt states a 5–10 s range and an "up to 90 s" ceiling, not a fixed 9 × 10 s = 90 s.
  ok(/5–10 s/.test(sys), `ep${epNo}/${lang}: variable 5–10 s clip length stated`);
  ok(!/9 × 10 s/.test(sys) && !/= 90 s/.test(sys), `ep${epNo}/${lang}: no leftover fixed 9 × 10 s = 90 s wording`);
  ok(!/short 10-second clip/.test(sys), `ep${epNo}/${lang}: no leftover "short 10-second clip" wording`);
  ok(!/EXACTLY 2 /.test(sys) && !/2 × 30/.test(sys) && !/= 60 s/.test(sys), `ep${epNo}/${lang}: no leftover 2 × 30 / 60 s wording`);
}

/* ---------------------------------------------------------------- (d) season-structure prompt */
const ss = seasonStructureSystemPrompt("en", 8);
ok(/EPISODE SHAPE \(2 beats, 1:30\)/.test(ss), "season prompt: EPISODE SHAPE (2 beats, 1:30)");
ok(!/1:00\)/.test(ss) && !/2 beats, 1:00/.test(ss), "season prompt: no leftover 1:00 label");

/* ---------------------------------------------------------------- (e) scenes-job structure text (derived) */
const scenesJob = read("lib/workers/scenes-job.ts");
ok(/FIRST half of the shots = the SET-UP/.test(scenesJob) && /SECOND half = the ESCALATION/.test(scenesJob), "scenes-job EPISODE_STRUCTURE_TEXT: first-half set-up / second-half escalation");
ok(!/2 × 30/.test(scenesJob) && !/60 s\b/.test(scenesJob), "scenes-job: no leftover 2 × 30 / 60 s");

/* ---------------------------------------------------------------- (f) validation on the new shape */
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
const baseScene = {
  shotType: "Wide", durationSec: 10, locationDesc: "INT — office — night", characters: ["Mark", "Elena"],
  action: "Mark enters and crosses to the desk while Elena rises.", sceneKind: "dialogue", dialogue,
  videoPrompt, presence: "both at the desk", entrances: "none", continuesFrom: "same-location-continuation",
  startState: "WORLD: Mark at the door. CAMERA: wide.", endState: "WORLD: Elena at the window. CAMERA: medium.",
};
const mk = (count: number): EpisodeScript =>
  normalizeEpisodeScript(episodeScriptSchema.parse({
    visualIdentity: "photoreal cinematic",
    scenes: Array.from({ length: count }, (_, i) => ({ ...baseScene, number: i + 1 })),
  }));
const cast = ["Mark Ellison", "Elena Voss"];

const nine = mk(9);
ok(nine.scenes.length === 9, `normalize keeps 9 scenes (got ${nine.scenes.length})`);
// Stage 115 — clip length is preserved (clamped to 5–10 s), not forced; the baseScene's 10 s stays 10 s.
ok(nine.scenes.every((s) => s.durationSec >= 5 && s.durationSec <= 10), "normalize keeps every scene within 5–10 s");
ok(nine.scenes.reduce((a, s) => a + s.durationSec, 0) <= 90, "normalized episode stays at or under the 90 s ceiling");
ok(hardProblems(validateEpisodeScript(nine, { characterNames: cast })).length === 0,
  `a valid 9-scene episode has no hard problems (${JSON.stringify(validateEpisodeScript(nine, { characterNames: cast }))})`);

const two = mk(2);
ok(hardProblems(validateEpisodeScript(two, { characterNames: cast })).some((p) => /scene count 2 below 9/.test(p)),
  "a 2-scene episode is a HARD failure (scene count below 9)");

console.log(`\nStage 114: PASS (${passed} checks)`);
