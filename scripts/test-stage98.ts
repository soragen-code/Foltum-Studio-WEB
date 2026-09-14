/**
 * Stage 98 — three coordinated changes:
 *   PART 1: chain generation is the DEFAULT (schema column default + normalizeChainMode +
 *           patch.sql migration), and consecutive same-location scenes stay
 *           "same-location-continuation" so the previous scene's real last frame is passed on.
 *   PART 2: on the story page, every later episode's logline OPENS by continuing directly from
 *           the immediately preceding episode's cliffhanger (unbroken cliffhanger chain).
 *   PART 3: scene-to-scene continuity (opening WORLD == previous ending WORLD, camera differs)
 *           is still enforced — regression guard, no source change this stage.
 *
 * normalizeChainMode is a pure, DB-free helper (safe to import). Everything else is a static
 * assertion on NON-protected source text. No protected file is read for content.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { normalizeChainMode } from "../lib/chain-run";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const root = process.cwd();
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ── PART 1: chain is the default ────────────────────────────────────────────
// (a) normalizeChainMode: absent / invalid → "chain"; explicit "parallel" still preserved.
ok(normalizeChainMode(undefined) === "chain", "1a: normalizeChainMode(undefined) → chain");
ok(normalizeChainMode(null) === "chain", "1a: normalizeChainMode(null) → chain");
ok(normalizeChainMode("nope") === "chain", "1a: normalizeChainMode(invalid) → chain");
ok(normalizeChainMode("chain") === "chain", "1a: normalizeChainMode('chain') → chain");
ok(normalizeChainMode("parallel") === "parallel", "1a: parallel is still selectable (preserved)");

// (b) schema.prisma: chainMode column default is now "chain".
const schema = read("prisma/schema.prisma");
const chainLine = schema.split("\n").find((l) => l.includes("chainMode") && l.includes("@default"));
ok(!!chainLine, "1b: schema has a chainMode column with a default");
ok(/@default\("chain"\)/.test(chainLine || ""), "1b: schema chainMode default is \"chain\"");

// (c) patch.sql: idempotent migration flips the column default to 'chain'.
const patch = read("prisma/patch.sql");
ok(/ALTER TABLE "Episode" ALTER COLUMN "chainMode" SET DEFAULT 'chain'/.test(patch),
  "1c: patch.sql sets the Episode.chainMode column default to 'chain'");

// (d) same-location scenes default to same-location-continuation so the last frame is passed on.
const season = read("lib/season.ts");
ok(/DEFAULT to "same-location-continuation"/i.test(season),
  "1d: season prompt defaults consecutive same-location scenes to same-location-continuation");
ok(/(last frame|carried-over frame)/i.test(season) && /previous scene/i.test(season),
  "1d: rule explains the previous scene's frame is handed to the next scene");

// ── PART 2: story-page episodes continue from the previous cliffhanger ────────
ok(/previous.*cliffhanger|preceding episode|where .*previous episode (ended|left)/i.test(season),
  "2: season structure prompt references continuing from the previous episode's cliffhanger");
ok(/CLIFFHANGER CHAIN/.test(season),
  "2: explicit CLIFFHANGER CHAIN rule present in the season structure prompt");
// The rule must instruct the logline to OPEN / pick up from that cliffhanger.
{
  const idx = season.indexOf("CLIFFHANGER CHAIN");
  const region = season.slice(idx, idx + 900);
  ok(/(opens?|begins?|continues?|picks? up)/i.test(region),
    "2: the cliffhanger-chain rule tells each episode to open / pick up from the previous cliffhanger");
}

// ── PART 3: scene-to-scene continuity regression guard ───────────────────────
ok(/START_STATE_RULE/.test(season), "3: START_STATE_RULE still present");
{
  const idx = season.indexOf("START_STATE_RULE =");
  const region = season.slice(idx, idx + 1400);
  ok(/previous scene'?s endState WORLD/i.test(region) || /previous end-?state/i.test(region),
    "3: opening WORLD must equal the previous scene's endState WORLD");
  ok(/(pose|position|motion|action)/i.test(region),
    "3: same pose / position / motion / action carried across the cut");
}
// MATCH-CUT: camera must differ across a continuous seam.
ok(/MATCH-CUT RULE/.test(season) && /CAMERA block MUST be DIFFERENT/i.test(season),
  "3: match-cut rule keeps the camera different across a continuous seam");
// prompt-seam: passed frame is the STARTING frame only, not a re-blocked held pose.
const seam = read("lib/prompt-seam.ts");
ok(/STARTING frame/.test(seam) && /NOT re-blocked/i.test(seam),
  "3: reframePreviousFrameLine keeps the passed frame as the starting frame, not a held/re-blocked pose");

console.log(`\nPASS — ${pass} assertions`);
