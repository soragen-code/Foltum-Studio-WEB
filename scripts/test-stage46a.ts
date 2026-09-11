/**
 * Stage 46A checks — pacing rule in every season prompt, the approved short synopsis as a mandatory
 * outline for the season structure, fixed 30 s test-episode scenes. Pure assertions, no I/O.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage46a.ts
 */
import assert from "node:assert";
import {
  PACING_RULE, seasonStructureSystemPrompt, seasonStructureUserPrompt, episodeScriptSystemPrompt,
  seasonFullStorySystemPrompt, seasonReviseSystemPrompt, seasonStoryReviseSystemPrompt,
} from "../lib/season";
import {
  shortSynopsisSchema, shortSynopsisSystemPrompt, shortSynopsisUserPrompt, normalizeShortSynopsis,
  renderShortSynopsis, parseStoredShortSynopsis, clampEpisodeCount,
} from "../lib/short-synopsis";
import { buildTestEpisodeRecords, TEST_EPISODE_DURATION_SEC } from "../lib/test-episode";
import { SEASON_MAX_EPISODES, SEASON_MIN_EPISODES } from "../lib/season";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

// ── A. Pacing rule ───────────────────────────────────────────────────────────────────────────────
{
  ok(PACING_RULE.includes("slow burn") && PACING_RULE.includes("EXACTLY ONE major plot turn") && PACING_RULE.includes("Episode 1 is EXPOSITION ONLY"), "A: PACING_RULE states slow burn, one turn per episode, exposition-only pilot");
  const prompts: [string, string][] = [
    ["season structure", seasonStructureSystemPrompt("ru", 8)],
    ["episode script", episodeScriptSystemPrompt("ru", 2)],
    ["full story", seasonFullStorySystemPrompt("ru", 8)],
    ["season revise", seasonReviseSystemPrompt("ru", 8)],
    ["story revise", seasonStoryReviseSystemPrompt("ru", 8)],
    ["short synopsis", shortSynopsisSystemPrompt("ru", 8)],
  ];
  for (const [name, p] of prompts) assert(p.includes(PACING_RULE), `A: ${name} prompt carries PACING_RULE`);
  ok(true, `A: PACING_RULE present in ${prompts.length} prompts`);
}

// ── B. Short synopsis: schema, normalisation, storage, outline in the structure prompt ──────────
{
  const raw = {
    premise: "A lighthouse keeper's daughter discovers her father has been signalling smugglers for years and must decide whom to protect.",
    episodes: [
      { number: 5, logline: " Mara finds the coded lamp schedule hidden in the logbook. " },
      { number: 7, logline: "A stranger arrives asking about the missing boat." },
      { number: 9, logline: "Mara follows her father to the cove at night." },
      { number: 11, logline: "Extra episode that must be dropped by the clamp." },
    ],
  };
  const n = normalizeShortSynopsis(raw, 3);
  ok(n.episodes.length === 3 && n.episodes.map((e) => e.number).join(",") === "1,2,3", "B: normalize keeps exactly N episodes and renumbers 1..N");
  ok(n.episodes[0].logline === "Mara finds the coded lamp schedule hidden in the logbook.", "B: loglines are trimmed");
  assert.throws(() => normalizeShortSynopsis(raw, 6), /expected 6/);
  ok(true, "B: too few episodes → throws (route retries)");
  assert.throws(() => normalizeShortSynopsis({ premise: "short", episodes: [] }, 3));
  ok(true, "B: schema rejects a too-short premise / empty list");
  ok(!shortSynopsisSchema.safeParse({ premise: raw.premise, episodes: [{ number: 1, logline: "tiny" }] }).success, "B: logline min length enforced");

  const rendered = renderShortSynopsis(n);
  ok(rendered.startsWith(n.premise) && rendered.includes("\n1. Mara finds") && rendered.includes("\n3. Mara follows"), "B: renderShortSynopsis = premise + numbered loglines");
  const stored = JSON.stringify(n);
  const back = parseStoredShortSynopsis(stored);
  ok(back && back.episodes.length === 3 && back.premise === n.premise, "B: parseStoredShortSynopsis round-trips the JSON column");
  ok(parseStoredShortSynopsis("plain legacy text") === null && parseStoredShortSynopsis(null) === null && parseStoredShortSynopsis("{}") === null, "B: legacy / empty / invalid stored values → null");

  ok(clampEpisodeCount(2, 8) === SEASON_MIN_EPISODES && clampEpisodeCount(99, 8) === SEASON_MAX_EPISODES && clampEpisodeCount("x", 7) === 7 && clampEpisodeCount(8.4, 6) === 8, "B: clampEpisodeCount clamps to product limits and falls back");

  const sys = shortSynopsisSystemPrompt("ru", 8);
  ok(sys.includes("EXACTLY 8 entries") && sys.includes("Russian"), "B: short-synopsis system prompt pins the episode count and language");
  const chars = [{ name: "Mara", role: "keeper's daughter", tier: "MAIN" } as any];
  const u0 = shortSynopsisUserPrompt({ idea: "idea", synopsis: "long", characters: chars, episodeCount: 8 });
  ok(u0.includes("EPISODES IN THE SEASON: 8") && u0.includes("- Mara (MAIN)") && !u0.includes("PREVIOUS SHORT SYNOPSIS"), "B: first-pass user prompt has cast + count, no previous version");
  const u1 = shortSynopsisUserPrompt({ idea: "idea", synopsis: "long", characters: chars, episodeCount: 8, previous: n, comment: "Меньше мистики" });
  ok(u1.includes("AUTHOR'S FEEDBACK") && u1.includes("Меньше мистики") && u1.includes("1. Mara finds"), "B: rework prompt carries the previous synopsis and the author's comment");
  const u2 = shortSynopsisUserPrompt({ idea: "idea", synopsis: "long", characters: chars, episodeCount: 8, previous: n });
  ok(u2.includes("DIFFERENT take") && !u2.includes("AUTHOR'S FEEDBACK"), "B: «Переделать» without a comment asks for a noticeably different take");

  const withOutline = seasonStructureUserPrompt("long synopsis", chars, [], rendered);
  ok(withOutline.includes("APPROVED SHORT SYNOPSIS") && withOutline.includes("MANDATORY") && withOutline.indexOf("APPROVED SHORT SYNOPSIS") < withOutline.indexOf("long synopsis") && withOutline.includes("2. A stranger arrives"), "B: season-structure user prompt opens with the approved outline (mandatory)");
  const without = seasonStructureUserPrompt("long synopsis", chars, []);
  ok(!without.includes("APPROVED SHORT SYNOPSIS") && seasonStructureUserPrompt("long synopsis", chars, [], null) === without, "B: no outline → unchanged prompt (backward compatible)");
}

// ── C. Test episode: fixed 30 s ─────────────────────────────────────────────────────────────────
{
  ok(TEST_EPISODE_DURATION_SEC === 30, "C: TEST_EPISODE_DURATION_SEC = 30");
  const prompt = "[SHOT TYPE] medium [VISUAL STYLE] photoreal [LIGHTING] dusk [BLOCKING] two men on a pier [GAZE] at each other [NON-VERBAL] tense [ACTION] They argue about the missing boat. [CHARACTER] two fishermen [TRANSITION] cut";
  for (const d of [null, 5, 12, 99, 1]) {
    const r = buildTestEpisodeRecords({ prompt, durationSec: d });
    assert(r.scene.durationSec === 30, `C: durationSec=${d} → 30`);
  }
  ok(true, "C: buildTestEpisodeRecords forces 30 s for any client value");
}

console.log(`\nStage 46A: ${pass} checks passed`);
