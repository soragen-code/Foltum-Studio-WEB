/**
 * Stage 93 checks (pure, static + a live import of lib/season.ts — no network / DB / render):
 *
 *  Change A — a single shared DIRECTING_RULES block (lib/directing-rules.ts, "shoot like a
 *    live-action drama series") is embedded verbatim into EVERY automatic scene-prompt SYSTEM
 *    prompt: the bulk breakdown worker (lib/workers/scenes-job.ts SYSTEM), the full-episode
 *    shooting-script prompt (lib/season.ts episodeScriptSystemPrompt) and the single-scene
 *    revise prompt (lib/season.ts sceneReviseSystemPrompt).
 *
 *  Change C — fixed-length shots: every episode is EXACTLY EPISODE_SCENE_COUNT (4) scenes,
 *    every scene a full SCENE_FIXED_SECONDS (30 s) EXCEPT the last (a little shorter), so the
 *    whole episode stays ≤ EPISODE_MAX_TOTAL_SECONDS (119 s / under 1:59). The canonical split
 *    for 4 scenes is 30 + 30 + 30 + 29 = 119. sceneDurationsForCount() produces that, and both
 *    lib/season.ts and lib/workers/scenes-job.ts drive their prompts and persistence from it.
 *
 *  (Change B — the references-screen location card now matches the character card size/layout —
 *   is a visual/JSX change verified in the build + test-stage9x DOM tests; a light static check
 *   is included below.)
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage93.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const RULES = "lib/directing-rules.ts";
const SEASON = "lib/season.ts";
const SCENES_JOB = "lib/workers/scenes-job.ts";
const EPISODE_VIEW = "app/project/[id]/episode/[episodeId]/episode-view.tsx";

const rules = readFileSync(RULES, "utf8");
const season = readFileSync(SEASON, "utf8");
const scenesJob = readFileSync(SCENES_JOB, "utf8");
const episodeView = readFileSync(EPISODE_VIEW, "utf8");

// ── A. DIRECTING_RULES defined once and embedded into every auto scene-prompt SYSTEM prompt ──
{
  ok(/export const DIRECTING_RULES\s*=/.test(rules), "A: lib/directing-rules.ts exports DIRECTING_RULES");
  ok(rules.includes("shoot like a live-action drama series"), "A: DIRECTING_RULES is the live-action-drama directive");
  // all 12 numbered directing points are present
  for (let n = 1; n <= 12; n++) {
    ok(new RegExp(`\\n${n}\\. `).test(rules), `A: DIRECTING_RULES contains point ${n}`);
  }

  ok(/import\s*{\s*DIRECTING_RULES\s*}\s*from\s*"@\/lib\/directing-rules"/.test(scenesJob), "A: scenes-job.ts imports DIRECTING_RULES");
  ok(scenesJob.includes("${DIRECTING_RULES}"), "A: scenes-job.ts SYSTEM prompt embeds DIRECTING_RULES");

  ok(/import\s*{\s*DIRECTING_RULES\s*}\s*from\s*"@\/lib\/directing-rules"/.test(season), "A: season.ts imports DIRECTING_RULES");
  // DIRECTING_RULES appears at least twice in season.ts (episodeScriptSystemPrompt + sceneReviseSystemPrompt)
  const seasonRuleHits = (season.match(/\$\{DIRECTING_RULES\}/g) ?? []).length;
  ok(seasonRuleHits >= 2, `A: season.ts embeds DIRECTING_RULES in >=2 prompts (found ${seasonRuleHits})`);

  // specifically inside sceneReviseSystemPrompt
  const revise = season.slice(season.indexOf("export function sceneReviseSystemPrompt"));
  ok(revise.includes("${DIRECTING_RULES}"), "A: sceneReviseSystemPrompt embeds DIRECTING_RULES");
  // specifically inside episodeScriptSystemPrompt
  const epScript = season.slice(
    season.indexOf("episodeScriptSystemPrompt"),
    season.indexOf("export function sceneReviseSystemPrompt")
  );
  ok(epScript.includes("${DIRECTING_RULES}"), "A: episodeScriptSystemPrompt embeds DIRECTING_RULES");
}

// ── C. Fixed 30 s scenes, last shorter, episode capped at 119 s / under 1:59 ──
{
  ok(/EPISODE_MAX_TOTAL_SECONDS\s*=\s*119/.test(season), "C: EPISODE_MAX_TOTAL_SECONDS = 119 (under 1:59)");
  ok(/export function sceneDurationsForCount/.test(season), "C: season.ts exports sceneDurationsForCount");
  ok(/export function applyFixedSceneDurations/.test(season), "C: season.ts exports applyFixedSceneDurations");

  // scenes-job derives its fixed durations from the season helper (single source of truth)
  ok(/import\s*{[\s\S]*sceneDurationsForCount[\s\S]*}\s*from\s*"@\/lib\/season"/.test(scenesJob), "C: scenes-job.ts imports sceneDurationsForCount from season");
  ok(scenesJob.includes("durationSec: s.durationSec"), "C: scenes-job.ts persists an explicit per-scene durationSec");
  ok(/durations\s*=\s*sceneDurationsForCount/.test(scenesJob), "C: scenes-job.ts computes per-index durations via sceneDurationsForCount");
}

// ── C (live). Import season.ts and check the actual numbers ──
async function liveChecks() {
  const mod = await import("../lib/season.ts");
  const { sceneDurationsForCount, EPISODE_SCENE_COUNT, EPISODE_MAX_TOTAL_SECONDS, SCENE_FIXED_SECONDS } = mod as any;

  ok(EPISODE_SCENE_COUNT === 4, `C-live: EPISODE_SCENE_COUNT === 4 (got ${EPISODE_SCENE_COUNT})`);
  ok(EPISODE_MAX_TOTAL_SECONDS === 119, `C-live: EPISODE_MAX_TOTAL_SECONDS === 119 (got ${EPISODE_MAX_TOTAL_SECONDS})`);
  ok(SCENE_FIXED_SECONDS === 30, `C-live: SCENE_FIXED_SECONDS === 30 (got ${SCENE_FIXED_SECONDS})`);

  const d = sceneDurationsForCount(4);
  ok(JSON.stringify(d) === JSON.stringify([30, 30, 30, 29]), `C-live: sceneDurationsForCount(4) === [30,30,30,29] (got ${JSON.stringify(d)})`);
  ok(d.reduce((a: number, b: number) => a + b, 0) === 119, "C-live: the 4 durations sum to 119");
  ok(d.slice(0, -1).every((x: number) => x === 30), "C-live: every non-last scene is exactly 30 s");
  ok(d[d.length - 1] < 30, "C-live: the last scene is shorter than 30 s");
  ok(d.every((x: number) => x <= 30), "C-live: no scene exceeds 30 s");
}

// ── B (static). The references location card matches the character card (no oversized wrapper) ──
{
  // the highlighted/oversized wrapper + "base scene layer" badge are gone
  ok(!episodeView.includes("border-2 border-primary/40 bg-primary/5"), "B: oversized highlighted location wrapper removed");
  ok(!episodeView.includes("Base scene layer — created first"), "B: 'Base scene layer — created first' badge removed");
  // location photos now use the same 9:16 object-contain sizing as character photos (not h-40 w-24)
  ok(!/h-40 w-24/.test(episodeView), "B: old fixed h-40 w-24 location thumbnails removed");
  // Locations heading uses the same text-sm font-semibold style as Characters and stays FIRST
  const locIdx = episodeView.indexOf("Locations ({refLocs.length})");
  const charIdx = episodeView.indexOf("Characters ({refChars.length})");
  ok(locIdx > 0 && charIdx > 0 && locIdx < charIdx, "B: Locations heading is rendered BEFORE Characters (locations first)");
  ok(/text-sm font-semibold[^>]*><MapPin className="h-4 w-4" \/> Locations/.test(episodeView), "B: Locations heading matches the character heading style");
  // location-specific controls are kept
  ok(episodeView.includes('data-testid="ref-location-generate"'), "B: location master-frame generate button kept");
  ok(episodeView.includes('data-testid="ref-location-add-angle"'), "B: location '+ Angle' button kept");
  ok(episodeView.includes('data-testid="ref-location-cancel"'), "B: location cancel-generation button kept");
}

liveChecks().then(() => {
  console.log(`\nAll ${pass} Stage 93 checks passed.`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
