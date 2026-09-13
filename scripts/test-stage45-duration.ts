/**
 * Stage 45 checks — doubled frame-state size (24–40 sentences / ≥300 words) with an explicit IN FRAME /
 * NOT IN FRAME inventory, WORLD continuity across seams, and the 2-minute episode budget (each scene
 * ≤ 30 s, total ≤ 120 s, never below the speech floor). Pure assertions, no I/O.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage45-duration.ts
 */
import assert from "node:assert";
import {
  START_STATE_RULE, END_STATE_RULE, FRAME_STATE_ASPECTS, episodeScriptSystemPrompt, sceneReviseSystemPrompt,
  normalizeEpisodeScript, episodeScriptSchema, validateEpisodeScript, hardProblems, isSoftProblem,
  fitEpisodeDuration, episodeTotalSeconds, splitState,
  EPISODE_MAX_TOTAL_SECONDS, SCENE_MAX_SECONDS, SCENE_MIN_SECONDS, NATURAL_WORDS_PER_SEC,
  STATE_MIN_SENTENCES, STATE_MAX_SENTENCES, STATE_MIN_WORDS,
} from "../lib/season";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

// ── A. Doubled limits + inventory in every prompt that carries the state rules ──────────────────
{
  ok(STATE_MIN_SENTENCES === 36 && STATE_MAX_SENTENCES === 60 && STATE_MIN_WORDS === 450, "A: limits raised ~1.5x (Stage 72: 36–60 sentences, ≥450 words)");
  const size = `${STATE_MIN_SENTENCES}–${STATE_MAX_SENTENCES} sentences, AT LEAST ${STATE_MIN_WORDS} words`;
  ok(START_STATE_RULE.includes(size) && END_STATE_RULE.includes(size), "A: START/END_STATE_RULE carry the doubled size");
  ok(!START_STATE_RULE.includes("12–20") && !END_STATE_RULE.includes("150 words"), "A: old 12–20 / 150-word wording is gone from the rules");
  for (const key of ["IN FRAME:", "NOT IN FRAME:", "BY NAME", "LEFT / CENTER / RIGHT", "foreground / midground / background", "what each hand holds", "light source"]) {
    assert(FRAME_STATE_ASPECTS.includes(key), `A: FRAME_STATE_ASPECTS mentions ${key}`);
  }
  ok(true, "A: FRAME_STATE_ASPECTS opens with an explicit character / prop / light inventory");
  const sys = episodeScriptSystemPrompt("en", 1);
  ok(sys.includes(size) && !sys.includes("12–20 sentences"), "A: episode system prompt uses the doubled size everywhere");
  ok(sys.includes("IN FRAME / NOT IN FRAME"), "A: final checklist demands the inventory");
  const rev = sceneReviseSystemPrompt("en");
  ok(rev.includes(size), "A: scene revise prompt uses the doubled size");
}

// ── B. Duration budget in the prompt ────────────────────────────────────────────────────────────
{
  const sys = episodeScriptSystemPrompt("en", 2);
  ok(EPISODE_MAX_TOTAL_SECONDS === 120 && SCENE_MAX_SECONDS === 30, "B: constants — 120 s per episode, 30 s per scene");
  ok(sys.includes(`≤ ${EPISODE_MAX_TOTAL_SECONDS} s`) && sys.includes("UNDER 2 MINUTES"), "B: R1 states the hard 2-minute total");
  ok(sys.includes(`NO scene may exceed ${SCENE_MAX_SECONDS} s`), "B: R1 states the 30 s per-scene cap");
  ok(sys.includes(`the SUM of all "durationSec" is ≤ ${EPISODE_MAX_TOTAL_SECONDS} s`), "B: final checklist repeats the total budget");
}

// ── C. fitEpisodeDuration — clamp, proportional scale, speech floor ─────────────────────────────
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const line = (n: number) => `ANNA (calm): "${words(n)}."`;
{
  // Over 30 s clips are clamped.
  const a = [{ durationSec: 45, dialogue: line(10) }, { durationSec: 30, dialogue: line(10) }];
  fitEpisodeDuration(a);
  ok(a[0].durationSec === 30 && a[1].durationSec === 30, "C: per-scene clamp to 30 s");

  // Already within budget → untouched.
  const b = [{ durationSec: 20, dialogue: line(10) }, { durationSec: 25, dialogue: line(10) }];
  ok(fitEpisodeDuration(b) === 45 && b[0].durationSec === 20 && b[1].durationSec === 25, "C: within budget → durations untouched");

  // 6 × 30 s = 180 s with short lines → scaled down to exactly 120 s, all ≥ 15 s.
  const c = Array.from({ length: 6 }, () => ({ durationSec: 30, dialogue: line(20) }));
  const total = fitEpisodeDuration(c);
  ok(total === EPISODE_MAX_TOTAL_SECONDS, `C: 180 s scaled to exactly ${EPISODE_MAX_TOTAL_SECONDS} s (got ${total})`);
  ok(c.every((s) => s.durationSec >= SCENE_MIN_SECONDS && s.durationSec <= SCENE_MAX_SECONDS), "C: scaled scenes stay within 15–30 s");

  // Speech floor is respected: 6 scenes × 50 words → floor ceil(50/2.1)+2 = 26 s each = 156 s > 120 → stays at floors.
  const d = Array.from({ length: 6 }, () => ({ durationSec: 30, dialogue: line(50) }));
  const floor = Math.ceil(50 / NATURAL_WORDS_PER_SEC) + 2;
  const dTotal = fitEpisodeDuration(d);
  ok(d.every((s) => s.durationSec === floor), `C: never below the speech floor (${floor} s)`);
  ok(dTotal === floor * 6 && dTotal > EPISODE_MAX_TOTAL_SECONDS, "C: overflowing floors are left over budget (reported as soft)");

  // Mixed: a long scene and short scenes — the long one keeps its floor, the short ones give up slack.
  const e = [{ durationSec: 30, dialogue: line(55) }, ...Array.from({ length: 5 }, () => ({ durationSec: 30, dialogue: line(15) }))];
  const eTotal = fitEpisodeDuration(e);
  ok(eTotal === EPISODE_MAX_TOTAL_SECONDS && e[0].durationSec === Math.ceil(55 / NATURAL_WORDS_PER_SEC) + 2, "C: long scene keeps its floor, short scenes absorb the cut");

  // Silent scenes fall to the 15 s clip minimum, no lower.
  const f = Array.from({ length: 9 }, () => ({ durationSec: 30, dialogue: "[NO DIALOGUE]" }));
  fitEpisodeDuration(f);
  ok(f.every((s) => s.durationSec === SCENE_MIN_SECONDS), "C: silent scenes stop at the 15 s clip minimum");
}

// ── D. normalizeEpisodeScript + validateEpisodeScript end-to-end ────────────────────────────────
// ~30 spoken words → speech floor ceil(30/2.1)+2 = 17 s, so six scenes (102 s) fit the budget while nine (153 s) overflow.
const talk = 'ANNA (quietly): "You knew he was not coming back and you still sent the boat out there? I waited until morning."\nMARK (not looking): "I sent the boat because otherwise we would have lost both."';
const prompt = "[SHOT TYPE]: 0-6s wide → 6-14s medium two-shot\n[VISUAL STYLE]: photoreal\n[LIGHTING]: warm lamp\n[BLOCKING]: Anna at the table\n[GAZE]: at each other\n[NON-VERBAL]: tense\n[ACTION]: Anna turns.\n[CHARACTER]: Anna, Mark\n[TRANSITION]: hard cut";
const CAM_A = "Wide shot from a LOW camera height, three-quarter angle across the room.";
const CAM_B = "Medium shot from a HIGH camera height, profile to the characters.";
const mk = (n: number, dur: number) =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1, shotType: "Medium shot", durationSec: dur, locationDesc: "INT — Office — day", characters: ["Anna", "Mark"],
    action: "Anna and Mark talk.", dialogue: talk, videoPrompt: prompt,
    startState: `WORLD: START-WORLD-${i + 1} IN FRAME: Anna, Mark.\nCAMERA: ${CAM_B}`,
    endState: `WORLD: END-WORLD-${i + 1} IN FRAME: Anna, Mark. NOT IN FRAME: none. Anna mid-step toward the door.\nCAMERA: ${CAM_A}`,
  }));
{
  // 6 scenes × 30 s (raw) → normalize scales to ≤ 120 s; seams keep WORLD identity.
  const ep = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6, 30) }));
  const total = episodeTotalSeconds(ep.scenes);
  ok(total <= EPISODE_MAX_TOTAL_SECONDS, `D: normalized episode total ${total} s ≤ 120 s`);
  ok(ep.scenes.every((s) => s.durationSec <= SCENE_MAX_SECONDS && s.durationSec >= SCENE_MIN_SECONDS), "D: every scene within 15–30 s");
  for (let i = 1; i < ep.scenes.length; i++) {
    assert.strictEqual(splitState(ep.scenes[i].startState).world, splitState(ep.scenes[i - 1].endState).world, `D: seam ${i}: startState WORLD == previous endState WORLD`);
    assert.notStrictEqual(splitState(ep.scenes[i].startState).camera, splitState(ep.scenes[i - 1].endState).camera, `D: seam ${i}: camera differs`);
  }
  ok(true, "D: every continuous seam: startState(N+1).WORLD === endState(N).WORLD, CAMERA differs");
  const problems = validateEpisodeScript(ep);
  ok(hardProblems(problems).length === 0, "D: fitted episode has no hard problems");
  ok(!problems.some((p) => p.includes("exceeds")), "D: fitted episode has no over-budget note");

  // 9 talking scenes: floors (≥ 15 s each with ~40 words → 22 s) overflow → soft problem, still not hard.
  const big = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(9, 30) }));
  const bigTotal = episodeTotalSeconds(big.scenes);
  const bigProblems = validateEpisodeScript(big);
  const over = bigProblems.find((p) => p.includes(`exceeds ${EPISODE_MAX_TOTAL_SECONDS}s`));
  ok(bigTotal > EPISODE_MAX_TOTAL_SECONDS && !!over && isSoftProblem(over), `D: 9-scene overflow → soft problem "${over}"`);
  ok(hardProblems(bigProblems).length === 0, "D: overflow is never a hard failure (no retry loop)");
  ok(big.scenes.every((s) => s.durationSec <= SCENE_MAX_SECONDS), "D: per-scene cap still holds on overflow");

  // A scene above 30 s that slipped through is a HARD problem in validate.
  const bad = { ...ep, scenes: ep.scenes.map((s, i) => (i === 0 ? { ...s, durationSec: 31 } : s)) };
  ok(hardProblems(validateEpisodeScript(bad)).some((p) => p.includes("above 30")), "D: durationSec > 30 is a hard problem");
}

console.log(`\nStage 45 duration/state checks: ${pass} passed`);
