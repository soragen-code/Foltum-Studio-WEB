/**
 * Stage 191 — P9: the PER-SHOT video prompt is LEAN (only this shot's own content, no season-bible /
 * whole-drama dump) and the TECHNICAL language (English) is separated from the SPOKEN dialogue language.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage191.ts
 */
import {
  assembleShotPrompt,
  SHOT_BLOCK_NAMES,
  SHOT_PROMPT_VERSION,
  type ShotPromptInput,
} from "../lib/prompts/shot";
import type { PlannedShot } from "../lib/prompts/shot-plan";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

function makeShot(over: Partial<PlannedShot> = {}): PlannedShot {
  return {
    index: 3,
    sceneNumber: 1,
    shotType: "dialogue",
    size: "MCU",
    duration: 3,
    camera: "ots-medium",
    speakerId: "c1",
    line: "You lied to me.",
    lineImpact: "high",
    reactionOfId: null,
    escalationBeat: "verbal",
    postFx: "none",
    matchCutIn: "she turns from the window",
    matchCutOut: "his hand tightens on the glass",
    cliffhangerRole: null,
    cliffhangerType: null,
    ...over,
  };
}

const baseInput: ShotPromptInput = {
  style: "gritty neo-noir, teal-orange grade",
  locationName: "penthouse study",
  locationLight: "low key, single desk lamp",
  characters: [
    { characterId: "c1", name: "Mara", appearance: "sharp bob, charcoal suit", wardrobe: "charcoal suit" },
    { characterId: "c2", name: "Victor", appearance: "grey stubble", wardrobe: "open-collar shirt" },
  ],
  shot: makeShot(),
  isSceneFirst: false,
  isSceneLast: false,
  dialogueLanguage: "en",
};

/* ───────────── 1) the prompt is per-shot only — it contains THIS shot's blocks ───────────── */
{
  const { prompt, blocks } = assembleShotPrompt(baseInput);
  ok(/STYLE:/.test(prompt), "prompt carries the one-line STYLE block");
  ok(/LOCATION:/.test(prompt), "prompt carries the shot's LOCATION block");
  ok(/CHARACTERS \(only these people are in frame\)/.test(prompt), "prompt carries only the in-frame CHARACTERS block");
  ok(/CAMERA:/.test(prompt), "prompt carries the per-shot CAMERA block");
  ok(/MATCH-CUT IN/.test(prompt) && /MATCH-CUT OUT/.test(prompt), "prompt carries the per-shot match-cut continuity blocks");
  // every emitted block name belongs to the known per-shot block set — no foreign/bible block leaked in
  const known = new Set(SHOT_BLOCK_NAMES);
  ok(Object.keys(blocks).every((n) => known.has(n as any)), "assembled blocks are exactly the known per-shot ShotBlockName set");
}

/* ───────────── 2) the prompt is LEAN — no season-bible / whole-drama / multi-scene dump ───────────── */
{
  const { prompt } = assembleShotPrompt(baseInput);
  ok(!/season bible|series bible|whole (?:drama|season)|every episode/i.test(prompt), "prompt does NOT dump a season/series bible");
  // it must not enumerate other scenes or a full shot list — only this one shot
  ok(!/SCENE 2|SCENE 3|shot list|all shots/i.test(prompt), "prompt does NOT enumerate other scenes or the whole shot list");
  // characters not in this shot's frame are not injected: only the two supplied appear
  ok(/Mara/.test(prompt) && /Victor/.test(prompt), "prompt names only the in-frame characters supplied");
}

/* ───────────── 3) technical language is English regardless of the spoken dialogue language ───────────── */
{
  const ru = assembleShotPrompt({ ...baseInput, dialogueLanguage: "ru", lineTranslation: "You lied to me." });
  // the structural/technical block labels stay English even when the spoken language is Russian
  ok(/STYLE:/.test(ru.prompt) && /CAMERA:/.test(ru.prompt) && /LOCATION:/.test(ru.prompt), "technical block labels stay English for a non-English spoken language");
  ok(/NEGATIVE/.test(ru.prompt), "the NEGATIVE (technical) block stays English for a non-English spoken language");
}

/* ───────────── 4) English line → voiced verbatim, no translation branch ───────────── */
{
  const en = assembleShotPrompt(baseInput);
  ok(/LINE \(spoken in English, voiced verbatim\)/.test(en.prompt), "English line block: 'spoken in English, voiced verbatim'");
  ok(en.blocks.line.includes("You lied to me."), "English line block carries the line verbatim");
}

/* ───────────── 5) non-English line → separated: spoken language named, English translation read by the model ───────────── */
{
  const ru = assembleShotPrompt({
    ...baseInput,
    dialogueLanguage: "ru",
    shot: makeShot({ line: "Ты мне солгал." }),
    lineTranslation: "You lied to me.",
  });
  ok(/LINE \(spoken in Russian; the model reads this English translation verbatim\)/.test(ru.prompt), "non-English line block names the spoken language AND says the model reads the English translation");
  ok(ru.blocks.line.includes("You lied to me."), "non-English line block feeds the ENGLISH translation to the model");
  ok(!ru.blocks.line.includes("Ты мне солгал."), "non-English line block does NOT feed the model the non-English spoken text (language separation)");
}

/* ───────────── 6) empty line → no LINE block at all (silent shot stays silent) ───────────── */
{
  const silent = assembleShotPrompt({ ...baseInput, shot: makeShot({ line: "", speakerId: null }) });
  ok(silent.blocks.line === "", "a silent shot produces no LINE block");
  ok(!/LINE \(/.test(silent.prompt), "a silent shot's assembled prompt has no LINE block");
}

/* ───────────── 7) version unchanged (lean/language change is not a contract bump) ───────────── */
{
  ok(SHOT_PROMPT_VERSION === "6.2.0", "SHOT_PROMPT_VERSION stays 6.2.0");
}

console.log(`\nStage 191: PASS (${passed} checks)`);
