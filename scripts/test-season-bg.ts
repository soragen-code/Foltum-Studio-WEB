/**
 * Season script job — background-mode state machine unit checks (pure helpers, no DB / no API).
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-season-bg.ts
 */
import {
  parseSeasonState, initialSeasonState, isAdvanceLocked, isStepTimedOut, planNextStep, retryDecision,
  reviseInstruction, episodeProgress, validateStructure, validateFullStory, ADVANCE_LOCK_MS, STEP_TIMEOUT_MS,
} from "../lib/workers/season-script-job";
import { stripJsonFences } from "../lib/ai";

const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

// --- state parsing -----------------------------------------------------------
const fresh = parseSeasonState(null, 8);
assert(fresh.v === 2 && fresh.step === "structure" && fresh.episodeCount === 8 && fresh.remaining === 8 && !fresh.responseId, "null resultData → fresh structure state");
const legacy = parseSeasonState(JSON.stringify({ revise: true, affected: [3, 4] }), 6);
assert(legacy.v === 2 && legacy.step === "structure" && legacy.episodeCount === 6 && !legacy.revise, "legacy {revise:true} resultData → fresh v2 state (revise queue comes from the DB)");
const withRevise = initialSeasonState(8, { episodeIds: ["ep3"], instruction: "darker ending" });
const round = parseSeasonState(JSON.stringify({ ...withRevise, responseId: "resp_1", step: "episode", episodeId: "ep3" }));
assert(round.responseId === "resp_1" && round.step === "episode" && round.revise?.episodeIds[0] === "ep3", "v2 state round-trips through JSON");
assert(JSON.stringify(round).includes('"responseId":'), "live response is detectable by failStaleJobs via '\"responseId\":'");
assert(parseSeasonState("not json", 5).step === "structure", "garbage resultData → fresh state");

// --- lock & timeout -----------------------------------------------------------
const now = Date.now();
assert(!isAdvanceLocked({ ...fresh }, now), "no lockedAt → not locked");
assert(isAdvanceLocked({ ...fresh, lockedAt: new Date(now - 5_000).toISOString() }, now), "lock 5 s old → locked");
assert(!isAdvanceLocked({ ...fresh, lockedAt: new Date(now - ADVANCE_LOCK_MS - 1).toISOString() }, now), "lock older than ADVANCE_LOCK_MS → expired");
assert(!isStepTimedOut({ ...fresh, stepStartedAt: new Date(now - 10 * 60_000).toISOString() }, now), "step 10 min old → not timed out");
assert(isStepTimedOut({ ...fresh, stepStartedAt: new Date(now - STEP_TIMEOUT_MS - 1000).toISOString() }, now), "step older than STEP_TIMEOUT_MS → timed out");

// --- planner ---------------------------------------------------------------------
const eps = (scripts: (string | null)[]) => scripts.map((s, i) => ({ id: `ep${i + 1}`, number: i + 1, script: s }));
assert(planNextStep(null, {}).step === "structure", "no season → structure");
assert(planNextStep({ fullStory: null, episodes: [] }, {}).step === "structure", "season without episodes → structure");
assert(planNextStep({ fullStory: null, episodes: eps([null, null]) }, {}).step === "fullStory", "episodes but no full story → fullStory");
assert(planNextStep({ fullStory: null, episodes: eps([null, null]) }, { skipFullStory: true }).step === "episode", "full story skipped after failures → episode");
let p = planNextStep({ fullStory: "story", episodes: eps(["done", null, null]) }, {});
assert(p.step === "episode" && p.episodeId === "ep2" && !p.instruction, "first episode without a script is next");
p = planNextStep({ fullStory: "story", episodes: eps(["done", "done"]) }, { revise: { episodeIds: ["ep1"], instruction: "more conflict" } });
assert(p.step === "episode" && p.episodeId === "ep1" && p.instruction === "more conflict", "revise queue goes first (already-written episode, with instruction)");
p = planNextStep({ fullStory: "story", episodes: eps(["done", "done"]) }, { revise: { episodeIds: ["gone"], instruction: "x" } });
assert(p.step === "done", "revise queue with an unknown episode id is ignored → done");
assert(planNextStep({ fullStory: "story", episodes: eps(["a", "b"]) }, {}).step === "done", "everything written → done");

// --- retry policy -----------------------------------------------------------------
assert(retryDecision({ step: "episode", attempt: 0 }) === "retry", "first failure → retry");
assert(retryDecision({ step: "episode", attempt: 1 }) === "fail", "second failure of an episode → job fails");
assert(retryDecision({ step: "structure", attempt: 1 }) === "fail", "second failure of the structure → job fails");
assert(retryDecision({ step: "fullStory", attempt: 1 }) === "skip", "second failure of the full story → skipped (non-fatal)");

// --- prompts / progress --------------------------------------------------------------
const hint = reviseInstruction("darker", { number: 4, title: "Шторм", logline: "Anna leaves." });
assert(hint.startsWith("darker\n(The NEXT episode 4 «Шторм» starts from: Anna leaves.") && hint.endsWith("compatible with it.)"), "revise instruction carries the next-episode hint");
assert(reviseInstruction("darker", null) === "darker", "last episode → no hint");
assert(episodeProgress(0, 8) === 5 && episodeProgress(4, 8) === 50 && episodeProgress(8, 8) === 95, "episode progress 5..95");

// --- step result validation -----------------------------------------------------------
assert(stripJsonFences("```json\n{\"a\":1}\n```") === '{"a":1}', "stripJsonFences unwraps fenced JSON");
let threw = false;
try { validateFullStory({ fullStory: "short" }); } catch { threw = true; }
assert(threw, "full story shorter than 200 chars is rejected");
assert(validateFullStory({ fullStory: "x".repeat(250) }).length === 250, "full story ≥ 200 chars is accepted");
threw = false;
try { validateStructure({ title: "t", logline: "l", episodes: [] }, 6); } catch { threw = true; }
assert(threw, "structure with the wrong episode count is rejected");

console.log("ALL OK");
