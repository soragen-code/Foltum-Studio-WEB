/** Stage 11 unit checks: real cancellation + scene-to-scene continuity. Run: npx tsx scripts/test-stage11.ts */
import {
  sceneScriptSchema,
  episodeScriptSchema,
  sceneReviseSchema,
  normalizeEpisodeScript,
  validateEpisodeScript,
  hardProblems,
  episodeScriptSystemPrompt,
  sceneReviseSystemPrompt,
  CONTINUITY_RULE,
} from "../lib/season";
import { planContinuation, type SceneJobSnapshot, type ContinuationOptions } from "../lib/batch-continue";
import { TERMINAL_JOB_STATUSES } from "../lib/jobs";

const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const prompt = "[SHOT TYPE]: Medium\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: a\n[NON-VERBAL]: b\n[ACTION]: c\n[CHARACTER]: d\n[TRANSITION]: e";
const talk = 'ANNA (softly): "You knew from the very start and stayed silent all this time? Every night you looked me in the eye and said nothing at all."\nMARK (sharply): "I stayed silent because otherwise you would have left back then, that winter."';
const baseScene = { number: 1, shotType: "Medium shot", durationSec: 30, locationDesc: "INT — Office — day", characters: ["Anna"], action: "Anna enters the room.", dialogue: talk, videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." };

// ---------------------------------------------------------------------------------------------
// TASK 2 — continuity: schemas stay backward compatible, prompts carry the rule, normalize keeps fields
// ---------------------------------------------------------------------------------------------

// (a) Backward compat: OLD scenes with NO continuity fields still validate.
assert(sceneScriptSchema.safeParse(baseScene).success, "old scene (no continuity fields) still validates");
// New scenes WITH continuity fields validate too.
const newScene = { ...baseScene, presence: "Anna at the desk, Mark by the window", entrances: "Mark rises and crosses to the desk", continuesFrom: "same-location-continuation" };
assert(sceneScriptSchema.safeParse(newScene).success, "new scene (with continuity fields) validates");
// A whole 6-scene old episode still validates + passes the hard checks (no new required tags).
const mkOld = (n: number) => Array.from({ length: n }, (_, i) => ({ ...baseScene, number: i + 1, dialogue: i % 6 === 0 ? "[NO DIALOGUE]" : talk }));
const oldEp = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mkOld(6) }));
assert(hardProblems(validateEpisodeScript(oldEp)).length === 0, "legacy episode without continuity fields has no hard problems");

// (b) normalize carries continuity through; scene 1 defaults to new-sequence, others stay undefined when absent.
const withCont = normalizeEpisodeScript(episodeScriptSchema.parse({
  visualIdentity: "photoreal cinematic",
  scenes: mkOld(6).map((s, i) => (i === 1 ? { ...s, presence: "Anna and Mark at the desk", entrances: "none", continuesFrom: "same-location-continuation" } : s)),
}));
assert(withCont.scenes[0].continuesFrom === "new-sequence", "scene 1 continuesFrom defaults to new-sequence");
assert(withCont.scenes[1].presence === "Anna and Mark at the desk" && withCont.scenes[1].entrances === "none" && withCont.scenes[1].continuesFrom === "same-location-continuation", "normalize preserves presence/entrances/continuesFrom");
assert(withCont.scenes[2].presence === undefined && withCont.scenes[2].continuesFrom === undefined, "absent continuity fields stay undefined (not empty strings) for non-first scenes");

// (c) Continuity rule text present in every script prompt (episode, revise).
assert(/SCENE-TO-SCENE CONTINUITY/.test(CONTINUITY_RULE) && /never teleport/i.test(CONTINUITY_RULE) && /MOVEMENT IS SHOWN/.test(CONTINUITY_RULE), "CONTINUITY_RULE says no teleporting + movement shown");
assert(episodeScriptSystemPrompt("ru").includes(CONTINUITY_RULE) && /presence/.test(episodeScriptSystemPrompt("ru")) && /continuesFrom/.test(episodeScriptSystemPrompt("ru")), "episode prompt embeds CONTINUITY_RULE + asks for presence/continuesFrom");
assert(episodeScriptSystemPrompt("en").includes(CONTINUITY_RULE), "episode prompt (en) embeds CONTINUITY_RULE");
assert(sceneReviseSystemPrompt("ru").includes(CONTINUITY_RULE) && /PREVIOUS shot/.test(sceneReviseSystemPrompt("ru")) && /NEXT shot/.test(sceneReviseSystemPrompt("ru")), "scene-revise prompt embeds CONTINUITY_RULE + prev/next hand-off");

// (d) scene-revise schema accepts continuity fields (and still accepts old payloads).
assert(sceneReviseSchema.safeParse({ shotType: "Close-up", durationSec: 30, locationDesc: "INT — Office — day", action: "Anna waits.", dialogue: talk, videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." }).success, "scene revise accepts payload without continuity fields");
assert(sceneReviseSchema.safeParse({ shotType: "Close-up", durationSec: 30, locationDesc: "INT — Office — day", action: "Anna waits.", dialogue: talk, videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway.", presence: "Anna alone", entrances: "Mark exits through the door", continuesFrom: "character-moves" }).success, "scene revise accepts continuity fields");

console.log("ALL STAGE11 CONTINUITY CHECKS PASSED");

// ---------------------------------------------------------------------------------------------
// TASK 1 — real cancellation: a canceled job must NOT be resubmitted by the auto-continue loop,
// stays relaunchable via manual retry, and an already-submitted (predictionId) job is never touched.
// ---------------------------------------------------------------------------------------------
assert((TERMINAL_JOB_STATUSES as readonly string[]).includes("canceled"), "canceled is a terminal job status");

const opts = (retryFailed: boolean): ContinuationOptions => ({ nowMs: 1_000_000, kickStaleMs: 60_000, concurrency: 3, maxAttempts: 3, retryFailed });
const snap = (over: Partial<SceneJobSnapshot>): SceneJobSnapshot => ({ sceneId: "s", number: 1, hasVideo: false, latestJob: null, attempts: 1, ...over });

// A canceled scene (job status "canceled", no video). AUTO mode: excluded from remaining → loop stops, nothing resubmitted.
const canceledSnap = snap({ sceneId: "sc", number: 2, latestJob: { status: "canceled", hasPrediction: false, isModeration: false, updatedAtMs: 500_000 }, attempts: 1 });
const autoPlan = planContinuation([snap({ sceneId: "d", hasVideo: true }), canceledSnap], opts(false));
assert(autoPlan.resubmit.length === 0 && autoPlan.retry.length === 0, "auto mode: canceled scene is NOT resubmitted or retried (no new charge)");
assert(autoPlan.remaining === 0, "auto mode: canceled scene is excluded from remaining → batch loop stops");
assert(autoPlan.scenes.find((s) => s.sceneId === "sc")?.status === "pending", "canceled scene shown as pending (relaunchable) in the UI");

// MANUAL relaunch (retryFailed=true): the same canceled scene becomes a retry candidate → user can restart it.
const manualPlan = planContinuation([canceledSnap], opts(true));
assert(manualPlan.retry.includes("sc") && manualPlan.remaining === 1, "manual relaunch: canceled scene is retried on demand");

// An already-submitted job (has predictionId) is NEVER touched — a running Replicate predict is left alone.
const submittedSnap = snap({ sceneId: "sub", latestJob: { status: "processing", hasPrediction: true, isModeration: false, updatedAtMs: 999_000 } });
const submittedPlan = planContinuation([submittedSnap], opts(false));
assert(submittedPlan.resubmit.length === 0 && submittedPlan.generating === 1, "already-submitted (predictionId) job is never resubmitted (idempotent)");

console.log("ALL STAGE11 CANCELLATION CHECKS PASSED");
