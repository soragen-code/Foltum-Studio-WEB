/**
 * Stage 156 — cinematic dramatic score (remove cheerful character; drama/tension across the episode).
 *
 * Pure-logic unit test (no network, no DB, no paid generation). Verifies:
 *   1. No MOOD_PROMPTS value has a cheerful/upbeat character (banned words).
 *   2. Every mood prompt is cinematic + instrumental (contains "cinematic" and "no vocals").
 *   3. moodToTags(m) still includes "instrumental" and the cinematic suffix for every mood.
 *   4. The single-mood pick and per-scene plan system prompts bias toward cinematic drama/tension
 *      and forbid a cheerful/upbeat read (checked on the exported prompt strings — no LLM call).
 */
import { MOODS, MOOD_PROMPTS, moodToTags, MOOD_PICK_SYSTEM_PROMPT } from "../lib/music";
import { MUSIC_PLAN_SYSTEM_PROMPT } from "../lib/music-plan";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok: ${msg}`);
}

// Words that read as cheerful / upbeat / poppy — none may appear in ANY mood prompt.
const BANNED = ["bright", "happy", "cheerful", "bouncy", "upbeat", "uplifting", "jolly", "light percussion", "poppy", "playful", "joyful", "fun ", "major key"];

// ── 1 + 2: MOOD_PROMPTS character ──────────────────────────────────────────
for (const m of MOODS) {
  const p = MOOD_PROMPTS[m].toLowerCase();
  for (const bad of BANNED) {
    ok(!p.includes(bad), `MOOD_PROMPTS[${m}] has no cheerful/upbeat word "${bad.trim()}"`);
  }
  ok(p.includes("cinematic"), `MOOD_PROMPTS[${m}] is cinematic`);
  ok(p.includes("no vocals"), `MOOD_PROMPTS[${m}] is instrumental (no vocals)`);
  ok(p.includes("seamless loop"), `MOOD_PROMPTS[${m}] is a seamless loop`);
}

// The "warm" moods must stay restrained / minor-leaning, not happy.
ok(/restrained|subdued|understated|minor/.test(MOOD_PROMPTS.uplifting.toLowerCase()), "uplifting recast as restrained/minor-leaning");
ok(/wistful|melancholy|chopin|tender/.test(MOOD_PROMPTS.romantic.toLowerCase()), "romantic recast as tender/wistful (Chopin-esque)");

// ── 3: moodToTags still instrumental + cinematic ────────────────────────────
for (const m of MOODS) {
  const tags = moodToTags(m).toLowerCase();
  ok(tags.includes("instrumental"), `moodToTags(${m}) includes "instrumental"`);
  ok(tags.includes("cinematic"), `moodToTags(${m}) includes "cinematic"`);
  ok(tags.includes("no vocals"), `moodToTags(${m}) includes "no vocals"`);
}

// ── 4: system prompts bias toward cinematic drama/tension, forbid cheerful ──
for (const [name, prompt] of [["MOOD_PICK_SYSTEM_PROMPT", MOOD_PICK_SYSTEM_PROMPT], ["MUSIC_PLAN_SYSTEM_PROMPT", MUSIC_PLAN_SYSTEM_PROMPT]] as const) {
  const s = prompt.toLowerCase();
  ok(s.includes("cinematic"), `${name} mentions cinematic`);
  ok(s.includes("drama"), `${name} mentions drama`);
  ok(s.includes("tension"), `${name} mentions tension`);
  ok(/never .*(cheerful|upbeat)|not .*(cheerful|upbeat)/.test(s) || (s.includes("never") && s.includes("cheerful")), `${name} forbids a cheerful/upbeat read`);
  // Output JSON contract preserved.
  ok(s.includes('"mood"'), `${name} keeps the JSON mood contract`);
}
// The per-scene plan still explains "none" (silence) and the low-under-dialogue / swell guidance.
ok(MUSIC_PLAN_SYSTEM_PROMPT.toLowerCase().includes('"none"'), "MUSIC_PLAN_SYSTEM_PROMPT keeps the \"none\" (silence) option");
ok(/low|unobtrusive/.test(MUSIC_PLAN_SYSTEM_PROMPT.toLowerCase()) && MUSIC_PLAN_SYSTEM_PROMPT.toLowerCase().includes("swell"), "MUSIC_PLAN_SYSTEM_PROMPT guides intensity (low under dialogue, swell in dramatic beats)");

console.log(`Stage 156: PASS (${passed} checks; pure logic, no network, no paid generation)`);
