/**
 * Stage 59 — 4-step wizard tests.
 *
 * Pure/unit + source-scan guardrails (no live model calls):
 *  (a) seasonCastResultSchema accepts a full valid cast + locations, rejects empty locations / <2 chars.
 *  (b) seasonCastSystemPrompt covers every cast tier + 8-14 locations + originality rule.
 *  (c) seasonCastUserPrompt embeds the synopsis.
 *  (d) source scans: idea route no longer creates characters/locations and advances to stage="synopsis";
 *      approve-synopsis routes the new flow to stage="structure"; episode tabs are ordered
 *      Script → References → Scenes and the default phase falls back to "script".
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage59.ts   (from the repo root)
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  seasonCastResultSchema,
  seasonCastSystemPrompt,
  seasonCastUserPrompt,
  CAST_TARGETS,
} from "@/lib/idea";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const char = (name: string, tier: string) => ({
  name, age: "30", role: "role", appearance: "a person", personality: "calm",
  firstAppearance: "ep1", tier, groupSize: null,
});
const loc = (name: string) => ({ name, description: "a place", visualPrompt: "a place, english" });

// (a) schema
{
  const valid = {
    characters: [char("Anna", "MAIN"), char("Boris", "SUPPORTING"), char("Extras", "CROWD")],
    locations: [loc("Home"), loc("Office")],
  };
  ok(seasonCastResultSchema.safeParse(valid).success, "seasonCastResultSchema accepts a valid cast + locations");

  const noLocs = { characters: valid.characters, locations: [] };
  ok(!seasonCastResultSchema.safeParse(noLocs).success, "seasonCastResultSchema rejects empty locations");

  const oneChar = { characters: [char("Solo", "MAIN")], locations: [loc("Home")] };
  ok(!seasonCastResultSchema.safeParse(oneChar).success, "seasonCastResultSchema rejects fewer than 2 characters");
}

// (b) system prompt
{
  const sp = seasonCastSystemPrompt("ru");
  ok(sp.includes(CAST_TARGETS.MAIN) && sp.includes("MAIN"), "system prompt mentions MAIN tier target");
  ok(sp.includes(CAST_TARGETS.SUPPORTING) && sp.includes("SUPPORTING"), "system prompt mentions SUPPORTING tier target");
  ok(sp.includes(CAST_TARGETS.MINOR) && sp.includes("MINOR"), "system prompt mentions MINOR tier target");
  ok(sp.includes(CAST_TARGETS.CROWD) && sp.includes("CROWD"), "system prompt mentions CROWD tier target");
  ok(sp.includes("8-14"), "system prompt asks for 8-14 locations");
  ok(/original/i.test(sp), "system prompt includes an originality rule");
  ok(sp.includes("Russian"), "system prompt names the story language (ru → Russian)");
}

// (c) user prompt
{
  const synopsis = "A quiet town hides a loud secret.";
  ok(seasonCastUserPrompt(synopsis).includes(synopsis), "user prompt embeds the synopsis");
}

// (d) source-scan guardrails
{
  const ideaRoute = read("app/api/ai/idea/route.ts");
  ok(!/tx\.character\.create/.test(ideaRoute), "idea route no longer creates character rows");
  ok(!/tx\.location\.create/.test(ideaRoute), "idea route no longer creates location rows");
  ok(/stage:\s*["']synopsis["']/.test(ideaRoute), "idea route advances the project to stage=synopsis");

  const approve = read("app/api/projects/[id]/approve-synopsis/route.ts");
  ok(/newFlow/.test(approve), "approve-synopsis branches on newFlow");
  ok(/stage:\s*["']structure["']|["']structure["']/.test(approve), "approve-synopsis routes the new flow to stage=structure");

  const ev = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");
  const iScript = ev.indexOf("'1 · Сценарий'");
  const iRefs = ev.indexOf("'2 · Референсы'");
  const iScenes = ev.indexOf("'3 · Сцены'");
  ok(iScript > 0 && iRefs > iScript && iScenes > iRefs, "episode tabs ordered Script → References → Scenes");
  ok(/anyScene \|\| validUrl\(initial\.videoUrl\) \? 'scenes' : 'script'/.test(ev), "episode default phase falls back to 'script'");

  const job = read("lib/workers/season-script-job.ts");
  ok(/generateSeasonCast/.test(job), "season job defines/uses generateSeasonCast");
  ok(/project\.characters\.length === 0/.test(job), "season job only generates cast when the project has none");
}

console.log(`\nAll ${pass} assertions passed.`);
