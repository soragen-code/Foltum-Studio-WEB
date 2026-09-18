/**
 * Stage 164 — "no wide shot during dialogue" directing rule.
 *
 * The rule: whenever a character SPEAKS an on-screen line, the shot is a DIALOGUE shot framed
 * close on the people (over-the-shoulder / waist-up half-body / medium / medium-close / close-up),
 * with the location only a soft background — a WIDE / establishing / full-length / high-angle /
 * aerial / group / whole-space shot is FORBIDDEN while any line is spoken. Only two or three
 * characters converse, never a crowd. Action (fight) scenes keep their combat staging and
 * narration / voiceover scenes are unchanged, so the tail rule is emitted for talking scenes only.
 *
 * Pure/synthetic checks only — no network, no LLM, no DB, no paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage164.ts
 */
import {
  buildScenePrompt,
  DIALOGUE_FRAMING_RULE,
  LOCATION_INSIDE_NOTE,
} from "../lib/scene-prompt";
import {
  episodeScriptSystemPrompt,
  sceneReviseSystemPrompt,
} from "../lib/season";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

const url = (s: string) => "https" + "://media.invalid/" + VISUAL_STYLE_ID + "/" + s + ".png";

/* ============================================================================================= */
/*  (1) DIALOGUE_FRAMING_RULE — the constant itself                                               */
/* ============================================================================================= */
ok(typeof DIALOGUE_FRAMING_RULE === "string" && DIALOGUE_FRAMING_RULE.length > 0,
  "DIALOGUE_FRAMING_RULE is a non-empty exported string");
ok(/DIALOGUE FRAMING/.test(DIALOGUE_FRAMING_RULE),
  "DIALOGUE_FRAMING_RULE announces itself as a DIALOGUE FRAMING rule");
ok(/over-the-shoulder/i.test(DIALOGUE_FRAMING_RULE)
  && /half-body/i.test(DIALOGUE_FRAMING_RULE)
  && /close-up/i.test(DIALOGUE_FRAMING_RULE),
  "DIALOGUE_FRAMING_RULE names the allowed close framings (OTS / half-body / close-up)");
// "wide" AND "establishing" must appear inside a negative "Do NOT ... while ... speaking" clause
ok(/Do NOT use a wide, establishing[^.]*while any line is being spoken/i.test(DIALOGUE_FRAMING_RULE),
  'DIALOGUE_FRAMING_RULE forbids "wide" + "establishing" while any line is spoken');
ok(/never a crowd/i.test(DIALOGUE_FRAMING_RULE) && /two or three characters/i.test(DIALOGUE_FRAMING_RULE),
  "DIALOGUE_FRAMING_RULE limits the conversation to two or three characters, never a crowd");

/* ============================================================================================= */
/*  (2) LOCATION_INSIDE_NOTE — the old "wide/full shots" mandate is gone, intent kept             */
/* ============================================================================================= */
ok(!/wide\/full shots/i.test(LOCATION_INSIDE_NOTE),
  'LOCATION_INSIDE_NOTE no longer mandates "wide/full shots"');
ok(/inside this space/i.test(LOCATION_INSIDE_NOTE) && /never a flat backdrop/i.test(LOCATION_INSIDE_NOTE),
  'LOCATION_INSIDE_NOTE keeps the "inside this space" / "never a flat backdrop" intent');
ok(/never as figures placed in front of a picture of the place/i.test(LOCATION_INSIDE_NOTE),
  "LOCATION_INSIDE_NOTE keeps the anti-flat-backdrop framing clause");

/* ============================================================================================= */
/*  (3) buildScenePrompt — the rule is emitted for talking scenes ONLY                            */
/* ============================================================================================= */
const interiorLocation = {
  id: "loc", name: "Kitchen",
  imageUrl: url("kitchen-wide"), imageReverse: url("kitchen-layout"),
  setInventory: "long table — center; white mug — on the table, left",
};
const twoChars = [
  { characterId: "c1", name: "Alex", imageFull: url("alex"), appearance: "grey coat", tier: "MAIN" },
  { characterId: "c2", name: "Mara", imageFull: url("mara"), appearance: "red scarf", tier: "MAIN" },
];

// (3a) a talking scene — DIALOGUE_FRAMING_RULE present
{
  const scene = {
    id: "s1", number: 1, episodeId: "ep1", status: "generating", sceneKind: "dialogue",
    continuesFrom: "new-sequence",
    locationDesc: "INT. kitchen — day",
    videoPrompt: "[SHOT TYPE]: medium\n[ACTION]: Alex talks.",
    dialogue: 'ALEX: "You came."\nMARA: "I did."',
    action: "Alex talks to Mara across the table.",
    startState: "WORLD: the kitchen. IN FRAME: Alex and Mara at the table. PEOPLE IN FRAME: exactly 2 persons.",
    endState: "WORLD: the kitchen. IN FRAME: Alex and Mara. PEOPLE IN FRAME: exactly 2 persons.",
  } as any;
  const built = buildScenePrompt({ scene, characters: twoChars, location: interiorLocation, previous: null } as any);
  ok(built.prompt.includes(DIALOGUE_FRAMING_RULE),
    "talking scene: the emitted prompt carries DIALOGUE_FRAMING_RULE");
}

// (3b) an action / fight scene — DIALOGUE_FRAMING_RULE absent (combat staging kept)
{
  const scene = {
    id: "s2", number: 2, episodeId: "ep1", status: "generating", sceneKind: "action",
    continuesFrom: "new-sequence",
    locationDesc: "INT. kitchen — day",
    videoPrompt: "[SHOT TYPE]: wide\n[ACTION]: Alex and Mara fight.",
    dialogue: 'ALEX: "Stop!"',
    action: "Alex and Mara struggle across the kitchen.",
    startState: "WORLD: the kitchen. IN FRAME: Alex and Mara. PEOPLE IN FRAME: exactly 2 persons.",
    endState: "WORLD: the kitchen. IN FRAME: Alex and Mara. PEOPLE IN FRAME: exactly 2 persons.",
  } as any;
  const built = buildScenePrompt({ scene, characters: twoChars, location: interiorLocation, previous: null } as any);
  ok(!built.prompt.includes(DIALOGUE_FRAMING_RULE),
    "action scene: the emitted prompt does NOT carry DIALOGUE_FRAMING_RULE (combat staging kept)");
}

// (3c) a narration / voiceover scene — DIALOGUE_FRAMING_RULE absent
{
  const scene = {
    id: "s3", number: 3, episodeId: "ep1", status: "generating", sceneKind: "narration",
    continuesFrom: "new-sequence",
    locationDesc: "EXT. city street — day",
    videoPrompt: "[SHOT TYPE]: wide\n[ACTION]: The city wakes.",
    voiceover: "The city had not slept that night.",
    action: "Establishing the waking city.",
    startState: "WORLD: the street. IN FRAME: Alex. PEOPLE IN FRAME: exactly 1 person.",
    endState: "WORLD: the street corner. IN FRAME: Alex.",
  } as any;
  const built = buildScenePrompt({ scene, characters: twoChars, location: interiorLocation, previous: null } as any);
  ok(!built.prompt.includes(DIALOGUE_FRAMING_RULE),
    "narration scene: the emitted prompt does NOT carry DIALOGUE_FRAMING_RULE");
}

/* ============================================================================================= */
/*  (4) season.ts RULES text — talking scenes forbid a wide/establishing shot while speaking      */
/* ============================================================================================= */
const epPrompt = episodeScriptSystemPrompt("en", 1);
ok(/every shot in which a line is spoken is a DIALOGUE shot/i.test(epPrompt),
  "episode prompt S2: every spoken shot is a DIALOGUE shot");
ok(/is NOT used while any character is speaking/i.test(epPrompt),
  "episode prompt S2: wide / establishing is NOT used while a character is speaking");
ok(/two or three characters are present and converse/i.test(epPrompt) && /never a crowd/i.test(epPrompt),
  "episode prompt S2: only two or three characters converse, never a crowd");

const rev = sceneReviseSystemPrompt("en");
ok(/every shot in which a line is spoken is a DIALOGUE shot/i.test(rev),
  "revise prompt: every spoken shot is a DIALOGUE shot");
ok(/is NOT used while any character is speaking/i.test(rev),
  "revise prompt: wide / establishing is NOT used while a character is speaking");
ok(/two or three characters are present and converse/i.test(rev) && /never a crowd/i.test(rev),
  "revise prompt: only two or three characters converse, never a crowd");

console.log(`Stage 164: PASS (${passed} checks; no-wide-shot-during-dialogue rule)`);
