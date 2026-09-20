/**
 * Stage 189 — P8: the scene breakdown is validated for COVERAGE instead of blindly sliced. The old worker
 * used `scenes.slice(0, MAX_SCENES)` as the ONLY mechanism (a silent drop of anything past the ceiling and
 * no check that the kept scenes covered the script). validateSceneCoverage replaces that: it checks order,
 * action, speakers and the final scene, treats the count as a PRODUCTION LIMIT (never fails for "too few"),
 * and reports going OVER the ceiling EXPLICITLY so the caller trims with a logged note (never silently).
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage189.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { validateSceneCoverage, dialogueHasSpeaker } from "../lib/scene-breakdown";

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

const scene = (n: number, action: string, dialogue: string) => ({ number: n, action, dialogue });
const good = [
  scene(1, "Anna finds the letter.", 'ANNA (low): "You lied to me."'),
  scene(2, "Dane denies it.", 'DANE (flat): "I never lied."'),
  scene(3, "The lights cut out as a shadow crosses the door.", 'ANNA (whisper): "Who is there?"'),
];

/* ───────────── 1) complete coverage → no problems, even with FEW scenes (count is a production limit) ───────────── */
{
  const r = validateSceneCoverage(good, { maxScenes: 8 });
  ok(r.problems.length === 0, "a well-formed 3-scene breakdown has NO coverage problems");
  ok(r.overLimit === false && r.overflow === 0, "3 scenes under a ceiling of 8 is not over the limit");
  ok(r.count === 3 && r.maxScenes === 8, "count and maxScenes are reported");
  // "too few" must NEVER be a problem, even against a large ceiling
  const r2 = validateSceneCoverage(good, { maxScenes: 50 });
  ok(r2.problems.length === 0, "FEWER scenes than any minimum is NOT a problem when coverage is complete");
}

/* ───────────── 2) real coverage gaps ARE problems ───────────── */
{
  const noAction = validateSceneCoverage([scene(1, "opens", "A: hi"), scene(2, "", 'B: "no action here"'), scene(3, "closes on a cliff", "C: end")], { maxScenes: 8 });
  ok(noAction.problems.length > 0 && noAction.missingAction.includes(2), "a scene with no action is a problem (missingAction lists it)");

  const badOrder = validateSceneCoverage([scene(1, "a", "A: 1"), scene(5, "b", "B: 2"), scene(3, "c cliff", "C: 3")], { maxScenes: 8 });
  ok(badOrder.problems.some((p) => /consecutive|order/i.test(p)), "non-consecutive numbering (broken order) is a problem");

  const noSpeaker = validateSceneCoverage([scene(1, "a", "A: hi"), scene(2, "b", "just narration with no speaker label"), scene(3, "c cliff", "C: end")], { maxScenes: 8 });
  ok(noSpeaker.problems.some((p) => /SPEAKER/i.test(p)) && noSpeaker.missingSpeakers.includes(2), "a dialogue block with no SPEAKER label is a problem (speakers must be preserved)");

  const noFinal = validateSceneCoverage([scene(1, "a", "A: hi"), scene(2, "", "")], { maxScenes: 8 });
  ok(noFinal.problems.some((p) => /final scene/i.test(p)), "a missing/empty final scene is a problem (the closing/cliffhanger scene)");

  const empty = validateSceneCoverage([], { maxScenes: 8 });
  ok(empty.problems.some((p) => /empty|no scenes/i.test(p)), "an empty breakdown is a problem");
}

/* ───────────── 3) going OVER the ceiling is EXPLICIT (overLimit + overflow), never a silent drop ───────────── */
{
  const many = Array.from({ length: 11 }, (_, i) => scene(i + 1, `event ${i + 1}`, `S${i + 1}: "line"`));
  const r = validateSceneCoverage(many, { maxScenes: 8 });
  ok(r.overLimit === true, "11 scenes over a ceiling of 8 is flagged overLimit");
  ok(r.overflow === 3, "the overflow count (3) is reported so the caller can trim explicitly");
  // over-limit is NOT itself a coverage problem — the breakdown is still faithful, it just needs trimming
  ok(!r.problems.some((p) => /too many|over/i.test(p)), "over-limit is reported via overLimit/overflow, not as a coverage 'problem'");
}

/* ───────────── 4) dialogueHasSpeaker recognises speaker labels ───────────── */
{
  ok(dialogueHasSpeaker('ANNA (cold): "Get out."') === true, "SPEAKER (cue): line is recognised");
  ok(dialogueHasSpeaker("DANE: I am leaving.") === true, "SPEAKER: line is recognised");
  ok(dialogueHasSpeaker("just a sentence with no speaker") === false, "prose with no speaker label is not a speaker line");
  ok(dialogueHasSpeaker("") === false, "empty dialogue has no speaker");
}

/* ───────────── 5) the worker replaced the blind slice with the validator ───────────── */
{
  const src = readSource("lib/workers/scenes-job.ts");
  ok(/validateSceneCoverage\(candidates, \{ maxScenes: MAX_SCENES \}\)/.test(src), "persistScenes runs validateSceneCoverage over the full candidate list");
  // the OLD blind slice as the sole mechanism is gone (rawScenes.slice(0, MAX_SCENES) removed)
  ok(!/rawScenes\.slice\(0, MAX_SCENES\)/.test(src), "the old blind rawScenes.slice(0, MAX_SCENES) is gone");
  ok(/coverage\.overLimit/.test(src) && /clipping the last/.test(src), "over-ceiling scenes are clipped only with an EXPLICIT logged warning");
  ok(/coverage\.problems\.length/.test(src) && /coverage problems/.test(src), "coverage problems are logged for visibility");
  ok(/stale: false/.test(src), "recreated scenes reset stale=false (freshly derived from the current script)");
}

console.log(`\nStage 189: PASS (${passed} checks)`);
