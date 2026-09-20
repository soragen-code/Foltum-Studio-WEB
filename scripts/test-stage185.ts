/**
 * Stage 185 — P4: SYNOPSIS prompts demand CONCRETE, CAUSAL content and no longer impose
 * artificial magic-number caps on the cast/locations.
 *
 * This suite proves, offline and synthetically, that the synopsis-generation change holds:
 *
 *   #1  SYNOPSIS_CRAFT_RULES exists and is CAUSAL & CONCRETE: it asks WHO wants WHAT, what they do,
 *       and what that LEADS TO (cause and effect / consequence), and forbids overload / name-dumping.
 *
 *   #2  SYNOPSIS_CRAFT_RULES states the ARTIFACT LEVEL so the three levels never blur:
 *       Project.synopsis (the whole-season arc, produced here) vs a single episode's synopsis
 *       vs the scene-by-scene script.
 *
 *   #3  Every synopsis prompt (from-idea / auto / upload) actually embeds SYNOPSIS_CRAFT_RULES.
 *
 *   #4  The hard "must contain 8-14 items" magic-number cap is gone from the prompt text and is
 *       reframed as a production GUIDE, not a hard cap.
 *
 *   #5  No artificial small cap on the number of characters/locations: MAX_CAST stays generous and
 *       the result schema parses a large cast (40) and up to 16 locations.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage185.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  SYNOPSIS_CRAFT_RULES,
  ideaSystemPrompt,
  ideaAutoSystemPrompt,
  ideaFromStorySystemPrompt,
  ideaResultSchema,
  MAX_CAST,
  type CharacterCard,
  type LocationCard,
} from "../lib/idea";

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

const rules = SYNOPSIS_CRAFT_RULES;
const rulesLower = rules.toLowerCase();

/* ───────────── 1) SYNOPSIS_CRAFT_RULES is causal & concrete ───────────── */
{
  ok(typeof rules === "string" && rules.length > 200, "SYNOPSIS_CRAFT_RULES is a non-trivial exported string");
  ok(/who wants what/i.test(rules), "rules ask WHO wants WHAT (concrete subject + motive)");
  ok(/leads to/i.test(rules), "rules ask what the action LEADS TO (consequence)");
  ok(/cause and effect/i.test(rules), "rules frame the arc as cause and effect");
  ok(rulesLower.includes("consequence"), "rules require a consequence per beat");
  ok(/concrete/i.test(rules), "rules require CONCRETE subjects/motives/outcomes");
  // reduce overload / no name-dumping
  ok(/overload/i.test(rules) && /name-dumping/i.test(rules), "rules forbid overload and name-dumping (reduce abstraction pile-up)");
}

/* ───────────── 2) SYNOPSIS_CRAFT_RULES states the ARTIFACT LEVEL (3-level distinction) ───────────── */
{
  ok(/artifact level/i.test(rules), "rules declare the ARTIFACT LEVEL explicitly");
  ok(/project-level/i.test(rules) && /season/i.test(rules), "rules identify this as the PROJECT-LEVEL season synopsis (project arc)");
  ok(/episode/i.test(rules), "rules distinguish a single episode's synopsis (Episode.description)");
  ok(/scene-by-scene|script/i.test(rules), "rules distinguish the scene-by-scene script (Episode.script)");
}

/* ───────────── 3) every synopsis prompt embeds SYNOPSIS_CRAFT_RULES ───────────── */
{
  const fromIdea = ideaSystemPrompt();
  const auto = ideaAutoSystemPrompt("en");
  const autoRu = ideaAutoSystemPrompt("ru");
  const fromStory = ideaFromStorySystemPrompt("en");

  ok(fromIdea.includes(rules), "ideaSystemPrompt embeds SYNOPSIS_CRAFT_RULES");
  ok(auto.includes(rules), "ideaAutoSystemPrompt(en) embeds SYNOPSIS_CRAFT_RULES");
  ok(autoRu.includes(rules), "ideaAutoSystemPrompt(ru) embeds SYNOPSIS_CRAFT_RULES");
  ok(fromStory.includes(rules), "ideaFromStorySystemPrompt embeds SYNOPSIS_CRAFT_RULES");
}

/* ───────────── 4) the hard magic-number cap is softened to a production GUIDE ───────────── */
{
  const prompts = [ideaSystemPrompt(), ideaAutoSystemPrompt("en"), ideaFromStorySystemPrompt("en")];
  for (const p of prompts) {
    ok(!/must contain 8-14 items/i.test(p), "prompt no longer says the hard 'must contain 8-14 items'");
    ok(/production GUIDE, not a hard cap/i.test(p), "prompt reframes 8-14 as a production GUIDE, not a hard cap");
    ok(/do not pad or trim/i.test(p), "prompt forbids padding/trimming just to hit a number");
  }
}

/* ───────────── 5) no artificial small cap on cast/locations ───────────── */
{
  ok(MAX_CAST >= 60, `MAX_CAST is generous (${MAX_CAST}) — not an artificial small cap`);

  const ch: CharacterCard = {
    name: "Anna",
    age: "30",
    gender: "female" as unknown as CharacterCard["gender"],
    role: "lighthouse keeper",
    appearance: "tall, dark hair",
    personality: "guarded",
    firstAppearance: "the pier",
    tier: "MAIN",
    groupSize: null,
  } as CharacterCard;
  const loc: LocationCard = {
    name: "Lighthouse",
    description: "a remote lighthouse on the cliffs",
    visualPrompt: "INT lighthouse, night, cold light, no people",
    setInventory: [],
  } as LocationCard;

  const bigCast = Array.from({ length: 40 }, (_, i) => ({ ...ch, name: `Char ${i + 1}` }));
  const manyLocs = Array.from({ length: 16 }, (_, i) => ({ ...loc, name: `Loc ${i + 1}` }));
  const parsed = ideaResultSchema.safeParse({
    synopsis: "A causal season arc ".repeat(20),
    characters: bigCast,
    locations: manyLocs,
  });
  ok(parsed.success, "ideaResultSchema parses a large cast (40) and 16 locations — no artificial small cap");

  // and a small-but-valid payload still parses (lower bound unchanged, min 2 characters)
  const small = ideaResultSchema.safeParse({
    synopsis: "A causal season arc ".repeat(20),
    characters: [ch, { ...ch, name: "Mark" }],
    locations: [loc],
  });
  ok(small.success, "ideaResultSchema still accepts a small (2-character) cast — lower bound unchanged");
}

/* ───────────── 6) the source keeps generous zod parse-safety maxes (not tightened) ───────────── */
{
  const src = readSource("lib/idea.ts");
  ok(/export const MAX_CAST = 60/.test(src), "source keeps MAX_CAST = 60 (generous parse-safety max)");
  ok(/locations:\s*z\.array\(locationCardSchema\)\.max\(16\)/.test(src), "source keeps locations .max(16) parse-safety cap");
}

console.log(`\nStage 185: PASS (${passed} checks)`);
