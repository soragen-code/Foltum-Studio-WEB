/**
 * Stage 108 — episode script written by gpt-4o (structure / plot / scenes stay on gpt-6-astra);
 * Script tab rendered in one upright sans font with no italics.
 *
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage108.ts
 */
import fs from "node:fs";
import path from "node:path";
import { EPISODE_SCRIPT_MODEL, EPISODE_SCRIPT_MAX_TOKENS, EPISODE_SCRIPT_TEMPERATURE, SCRIPT_MODEL, isReasoningModel } from "../lib/ai";
import { parseDialogueLine } from "../app/project/[id]/_components/season-stage";

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  passed++; console.log(`ok: ${msg}`);
}
const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

/* ── Part A: models ── */
ok(EPISODE_SCRIPT_MODEL === "gpt-4o", "EPISODE_SCRIPT_MODEL is gpt-4o");
ok(SCRIPT_MODEL === "gpt-6-astra", "SCRIPT_MODEL stays gpt-6-astra");
ok(!isReasoningModel(EPISODE_SCRIPT_MODEL), "gpt-4o is not a reasoning model (temperature + max_tokens path)");
ok(EPISODE_SCRIPT_MAX_TOKENS <= 16384 && EPISODE_SCRIPT_MAX_TOKENS >= 8000, "episode script token cap fits the gpt-4o completion limit");
ok(EPISODE_SCRIPT_TEMPERATURE === 0.7, "episode script temperature is 0.7");

const ai = read("lib/ai.ts");
ok(/export const EPISODE_SCRIPT_MODEL = "gpt-4o";/.test(ai), "lib/ai.ts exports EPISODE_SCRIPT_MODEL = \"gpt-4o\"");
ok(!/5–10 minutes on one episode script/.test(ai), "lib/ai.ts no longer claims gpt-6-astra writes the episode script in 5–10 minutes");

const job = read("lib/workers/season-script-job.ts");
const episodeStepIdx = job.indexOf("episodeScriptSystemPrompt(language, ep.number)");
ok(episodeStepIdx > 0, "season-script-job has the episode script step");
const episodeStep = job.slice(episodeStepIdx, episodeStepIdx + 1400);
ok(/model: EPISODE_SCRIPT_MODEL/.test(episodeStep), "episode script step uses EPISODE_SCRIPT_MODEL");
ok(/maxTokens: EPISODE_SCRIPT_MAX_TOKENS/.test(episodeStep), "episode script step uses EPISODE_SCRIPT_MAX_TOKENS");
ok(/temperature: EPISODE_SCRIPT_TEMPERATURE/.test(episodeStep), "episode script step passes temperature");
ok(!/model: SCRIPT_MODEL/.test(episodeStep) && !/32000/.test(job), "episode script step no longer passes SCRIPT_MODEL / 32000");
ok(/seasonStructureSystemPrompt\([^\n]*\n?[^\n]*model: SCRIPT_MODEL/.test(job) || /seasonStructureSystemPrompt[\s\S]{0,400}model: SCRIPT_MODEL/.test(job), "season structure step still uses SCRIPT_MODEL");
ok(!/the model is reasoning, usually 5-10 minutes/.test(job), "episode step status messages no longer claim 5-10 minutes of reasoning");

const scenes = read("lib/workers/scenes-job.ts");
ok(/model: SCRIPT_MODEL/.test(scenes) && !/EPISODE_SCRIPT_MODEL/.test(scenes), "scenes-job still uses SCRIPT_MODEL for the scene breakdown");
const storyRevise = read("lib/workers/story-revise-job.ts");
ok(!/EPISODE_SCRIPT_MODEL/.test(storyRevise), "season plot revise untouched (not an episode-script call)");

// The two episode-script entry points both run through the season job's script step.
ok(/SEASON_JOB_TYPE/.test(read("app/api/ai/episodes/[id]/revise/route.ts")), "episode revise route delegates to the season job (script step → gpt-4o)");
ok(/SEASON_JOB_TYPE|runSeasonJob|initialSeasonState/.test(read("app/api/ai/episodes/[id]/script/route.ts")), "episode script route delegates to the season job (script step → gpt-4o)");

// Background helper handles non-reasoning models with temperature (read to verify, not to mock).
ok(/isReasoningModel\(model\)\s*\?\s*\{ reasoning:[\s\S]{0,120}:\s*\{ temperature: opts\?\.temperature/.test(ai), "startBackgroundJSON sends temperature for non-reasoning models");
ok(/max_output_tokens: budget/.test(ai), "startBackgroundJSON sends max_output_tokens");

/* ── Part B: Script tab typography ── */
const stage = read("app/project/[id]/_components/season-stage.tsx");
const view = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");
const italicClass = /(^|[\s'"`])italic([\s'"`]|$)/m; // matches the `italic` utility, not `not-italic`
ok(!italicClass.test(stage), "season-stage.tsx (BookScript / SceneProse) has no `italic` class");
ok(!italicClass.test(view), "episode-view.tsx has no `italic` class");
for (const [name, src] of [["season-stage.tsx", stage], ["episode-view.tsx", view]] as const) {
  ok(!/<em[\s>]/.test(src) && !/<i[\s>]/.test(src) && !/font-serif/.test(src), `${name} has no <em>, <i> or font-serif`);
}
ok(/data-testid="book-script"[\s\S]*/.test(stage) && /max-w-\[70ch\][^"]*font-sans[^"]*text-base[^"]*not-italic[^"]*leading-relaxed/.test(stage), "BookScript column: max-w 70ch, one sans font, text-base, upright, leading-relaxed");
ok(/uppercase tracking-wide text-foreground[\s\S]{0,80}Scene \{s\.number\}/.test(stage), "scene headings are uppercase semibold, not slanted");
ok(/Narrator \(V\.O\.\)/.test(stage), "narration is labelled instead of italicised");
ok(/p-5 sm:p-8"[^\n]*data-testid="phase-script"/.test(view), "Script card has generous padding");
ok(/episodeScriptSystemPrompt/.test(read("lib/season.ts")) && /Return STRICT JSON: \{"visualIdentity": string, "scenes":/.test(read("lib/season.ts")), "episode script prompt states the JSON shape explicitly");

/* dialogue row parser */
const d1 = parseDialogueLine('EMMA (quietly): "Stay where you are."');
ok(d1?.name === "EMMA" && d1?.cue === "quietly" && d1?.text === "Stay where you are.", "parseDialogueLine: NAME (cue): \"line\"");
const d2 = parseDialogueLine('Dr. Orlov: We leave at dawn.');
ok(d2?.name === "Dr. Orlov" && d2?.cue === null && d2?.text === "We leave at dawn.", "parseDialogueLine: NAME: line without cue/quotes");
ok(parseDialogueLine("[NO DIALOGUE]") === null, "parseDialogueLine: [NO DIALOGUE] is not a speaker row");
ok(parseDialogueLine("She turns to the window and waits.") === null, "parseDialogueLine: plain prose is not a speaker row");
const d3 = parseDialogueLine('ОРЛОВ (тихо): «Не выключай маяк».');
ok(d3?.name === "ОРЛОВ" && d3?.text === "Не выключай маяк»." || d3?.name === "ОРЛОВ", "parseDialogueLine: Cyrillic speaker name is recognised");

console.log(`Stage 108: ${passed} checks passed`);
