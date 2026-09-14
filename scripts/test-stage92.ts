/**
 * Stage 92 checks (pure, static — no network / DB / render):
 *
 *  REQUEST: "make the scene prompts (videoPrompt) be written by gpt-6-astra".
 *
 *  Every LLM call that WRITES a scene's videoPrompt is switched from the default gpt-4o to
 *  SCRIPT_MODEL (= "gpt-6-astra"), with no timeouts/regressions:
 *
 *   Site #1 — the ~12-shot bulk breakdown (app/api/ai/scenes) — CONVERTED TO A BACKGROUND JOB
 *     (lib/workers/scenes-job.ts): a synchronous gpt-6-astra call would die at the ~300 s undici
 *     headers timeout, so the route creates a GenerationJob and the worker starts an OpenAI
 *     background response (gpt-6-astra) and polls it. The client polls GET /api/jobs/[id].
 *   Site #2 — the single-scene revise (app/api/ai/scenes/[id]/revise) — SYNC gpt-6-astra with
 *     reasoningEffort "low" (one small reasoning call finishes well under the sync limit).
 *   Site #3 — the continuity audit that rewrites correctedVideoPrompt
 *     (app/api/ai/assemble-episode/polish) — the whole-episode audit is switched to a gpt-6-astra
 *     OpenAI background response + poll loop (it already runs inside a background job).
 *
 *  DELIBERATELY LEFT ALONE (documented here so a future change does not "fix" them):
 *   - lib/workers/season-script-job.ts already uses SCRIPT_MODEL (background) — untouched.
 *   - lib/workers/story-revise-job.ts rewrites season PROSE/structure (loglines/arcs/fullStory),
 *     NOT scene videoPrompts (it deletes scenes and delegates scene writing to season-script-job),
 *     and is a 16k-token whole-season sync call — left on gpt-4o (out of scope + timeout risk).
 *   - ensureEnglishDialogue is a short non-prompt pass — stays on gpt-4o.
 *   - lib/character-look.ts (LOOK_MODEL prompt ADAPTATION at video-gen time) — protected, stays gpt-4o.
 *   - Media models (Seedance / Seedream) untouched.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage92.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const SCENES_JOB = "lib/workers/scenes-job.ts";
const SCENES_ROUTE = "app/api/ai/scenes/route.ts";
const REVISE_ROUTE = "app/api/ai/scenes/[id]/revise/route.ts";
const POLISH_ROUTE = "app/api/ai/assemble-episode/polish/route.ts";
const SEASON_SCRIPT = "lib/workers/season-script-job.ts";
const STORY_REVISE = "lib/workers/story-revise-job.ts";
const AI = "lib/ai.ts";
const CHAR_LOOK = "lib/character-look.ts";

const scenesJob = readFileSync(SCENES_JOB, "utf8");
const scenesRoute = readFileSync(SCENES_ROUTE, "utf8");
const revise = readFileSync(REVISE_ROUTE, "utf8");
const polish = readFileSync(POLISH_ROUTE, "utf8");
const seasonScript = readFileSync(SEASON_SCRIPT, "utf8");
const storyRevise = readFileSync(STORY_REVISE, "utf8");
const ai = readFileSync(AI, "utf8");
const charLook = readFileSync(CHAR_LOOK, "utf8");

// ── A. Site #1: the bulk breakdown worker writes videoPrompt with gpt-6-astra in the background ──
{
  ok(scenesJob.includes("SCRIPT_MODEL") && /model:\s*SCRIPT_MODEL/.test(scenesJob), "A: scenes-job.ts starts the breakdown with SCRIPT_MODEL");
  ok(scenesJob.includes("startBackgroundJSON") && scenesJob.includes("pollBackgroundJSON"), "A: scenes-job.ts runs it as an OpenAI background response and polls it");
  ok(/reasoningEffort:\s*"low"/.test(scenesJob), "A: scenes-job.ts uses reasoningEffort low (room for the large JSON)");
  ok(scenesJob.includes('export const SCENES_JOB_TYPE = "scenes"'), "A: scenes-job.ts exports SCENES_JOB_TYPE");
  ok(scenesJob.includes('"videoPrompt"') || scenesJob.includes("videoPrompt"), "A: scenes-job.ts is the writer of the scene videoPrompt (SYSTEM prompt lives here now)");
}

// ── B. Site #1 route: background job, no synchronous SYSTEM chatJSON ─────────────────────────────
{
  ok(scenesRoute.includes("runInBackground") && scenesRoute.includes("runScenesJob"), "B: scenes/route.ts dispatches the background worker");
  ok(scenesRoute.includes("SCENES_JOB_TYPE"), "B: scenes/route.ts creates a job of type SCENES_JOB_TYPE");
  ok(!scenesRoute.includes("chatJSON"), "B: scenes/route.ts no longer does a synchronous chatJSON of the breakdown");
  ok(/maxDuration\s*=\s*800/.test(scenesRoute), "B: scenes/route.ts has the long-job maxDuration for after()");
  ok(scenesRoute.includes("jobId"), "B: scenes/route.ts returns a jobId for the client to poll");
}

// ── C. Site #2: single-scene revise uses sync gpt-6-astra (reasoningEffort low) ─────────────────
{
  ok(revise.includes("SCRIPT_MODEL"), "C: revise route imports/uses SCRIPT_MODEL");
  ok(/chatJSON\(sceneReviseSystemPrompt\(language\), user, \{\s*model:\s*SCRIPT_MODEL/.test(revise), "C: revise route writes the new videoPrompt with SCRIPT_MODEL");
  ok(/reasoningEffort:\s*"low"/.test(revise), "C: revise route uses reasoningEffort low");
  // The short English-dialogue guard is NOT a prompt writer — it must stay on the gpt-4o default.
  const ensuredCall = revise.slice(revise.indexOf("ensureEnglishDialogue("));
  ok(!/ensureEnglishDialogue\([^)]*SCRIPT_MODEL/.test(revise), "C: ensureEnglishDialogue was NOT switched to SCRIPT_MODEL (stays gpt-4o)");
  ok(ensuredCall.includes("chatJSON)"), "C: ensureEnglishDialogue is still handed the default chatJSON");
}

// ── D. Site #3: continuity audit (correctedVideoPrompt) uses gpt-6-astra via background response ─
{
  ok(polish.includes("SCRIPT_MODEL"), "D: polish route uses SCRIPT_MODEL for the audit");
  ok(polish.includes("startBackgroundJSON") && polish.includes("pollBackgroundJSON"), "D: polish audit runs as an OpenAI background response + poll (avoids the 300s sync death)");
  ok(/model:\s*SCRIPT_MODEL[\s\S]{0,60}reasoningEffort:\s*"low"/.test(polish), "D: polish audit passes model SCRIPT_MODEL + reasoningEffort low");
  ok(!/chatJSON\(/.test(polish), "D: polish route no longer does a synchronous chatJSON audit");
  ok(polish.includes("cancelBackgroundResponse"), "D: polish audit cancels the background response on cancel");
}

// ── E. Untouched-by-design: season-script (already astra) and story-revise (season prose) ────────
{
  ok(seasonScript.includes("SCRIPT_MODEL"), "E: season-script-job.ts still uses SCRIPT_MODEL (was already astra — untouched)");
  // story-revise rewrites season prose, not scene videoPrompts → left on the gpt-4o default.
  ok(!storyRevise.includes("SCRIPT_MODEL"), "E: story-revise-job.ts still on the gpt-4o default (rewrites season prose, not scene videoPrompts — out of scope)");
}

// ── F. SCRIPT_MODEL is the single source of the model name; no hardcoded literal leaked out ──────
{
  ok(/SCRIPT_MODEL\s*=\s*"gpt-6-astra"/.test(ai), "F: SCRIPT_MODEL is defined once in lib/ai.ts as gpt-6-astra");
  for (const [name, src] of [["scenes-job", scenesJob], ["scenes/route", scenesRoute], ["revise", revise], ["polish", polish]] as const) {
    ok(!src.includes('"gpt-6-astra"'), `F: ${name} references SCRIPT_MODEL, never the hardcoded "gpt-6-astra" literal`);
  }
}

// ── G. Protected file untouched by scope: character-look stays on the gpt-4o LOOK_MODEL ──────────
{
  ok(!charLook.includes("SCRIPT_MODEL"), "G: lib/character-look.ts (prompt adaptation at video-gen time) is not switched to SCRIPT_MODEL");
}

console.log(`\nStage 92: ${pass} checks passed.`);
