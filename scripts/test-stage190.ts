/**
 * Stage 190 — P8.3: the SHOT-PLANNER prompt gains geography/space, character-&-location referencing and
 * cause-before-reaction ordering, WHILE keeping the pre-existing DIALOGUE FRAMING rule (no WS while
 * speaking) and the close/medium-at-scene-start rule. The JSON contract is unchanged so the prompt
 * version stays 6.2.0.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage190.ts
 */
import {
  SHOT_PLAN_PROMPT_VERSION,
  SHOT_GEOGRAPHY_RULE,
  SHOT_SCENE_OPENING_RULE,
  SHOT_REACTION_RULE,
  SHOT_FRAMING_RULE,
  SHOT_PLAN_SYSTEM,
} from "../lib/prompts/shot-plan";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

/* ───────────── 1) GEOGRAPHY & SPACE rule exists and covers layout / screen direction / eyeline / the line ───────────── */
{
  ok(/GEOGRAPHY & SPACE/i.test(SHOT_GEOGRAPHY_RULE), "SHOT_GEOGRAPHY_RULE is titled 'GEOGRAPHY & SPACE'");
  ok(/screen direction/i.test(SHOT_GEOGRAPHY_RULE), "geography rule keeps screen direction stable across cuts");
  ok(/eyeline/i.test(SHOT_GEOGRAPHY_RULE), "geography rule keeps eyelines stable across cuts");
  ok(/cross the line/i.test(SHOT_GEOGRAPHY_RULE), "geography rule allows crossing the line only with a re-establishing shot");
  ok(/layout/i.test(SHOT_GEOGRAPHY_RULE), "geography rule respects the location's established layout");
}

/* ───────────── 2) geography rule enforces referencing only established characters / objects ───────────── */
{
  ok(
    /already placed|already established|the scene has (?:not )?established|introduce no one/i.test(SHOT_GEOGRAPHY_RULE),
    "geography rule: a shot may reference only a character/object the scene has already established",
  );
}

/* ───────────── 3) NEW-SCENE OPENING rule: first shot of a new scene re-establishes who is present ───────────── */
{
  ok(/NEW-SCENE OPENING/i.test(SHOT_SCENE_OPENING_RULE), "SHOT_SCENE_OPENING_RULE is titled 'NEW-SCENE OPENING'");
  ok(/first shot/i.test(SHOT_SCENE_OPENING_RULE), "scene-opening rule targets the FIRST shot of each new scene");
  ok(/re-establish/i.test(SHOT_SCENE_OPENING_RULE), "scene-opening rule re-establishes who is present / where");
  ok(/close or medium|close\/medium|close-up|medium/i.test(SHOT_SCENE_OPENING_RULE), "scene-opening rule opens on a close/medium (not a wide of the empty room)");
  ok(/empty room|not a wide/i.test(SHOT_SCENE_OPENING_RULE), "scene-opening rule explicitly forbids opening on a wide of the empty room");
}

/* ───────────── 4) cause-before-reaction ordering is in the reaction rule (kept close-up-on-listener behaviour) ───────────── */
{
  ok(/cause before reaction/i.test(SHOT_REACTION_RULE), "SHOT_REACTION_RULE names 'cause before reaction'");
  ok(/AFTER the shot/i.test(SHOT_REACTION_RULE), "reaction rule: a reaction comes AFTER the shot that shows what it reacts to");
  ok(/never (?:place|before)/i.test(SHOT_REACTION_RULE), "reaction rule: never place a reaction before its cause is shown");
  // the pre-existing reaction behaviour (0.8–1.5s close on the receiver) is kept
  ok(/0\.8.?1\.5/.test(SHOT_REACTION_RULE), "reaction rule keeps the 0.8–1.5s tight reaction beat");
  ok(/reactionOfId/.test(SHOT_REACTION_RULE), "reaction rule keeps setting reactionOfId to the receiver");
}

/* ───────────── 5) DIALOGUE FRAMING (no WS while speaking) is KEPT, not removed ───────────── */
{
  ok(/DIALOGUE FRAMING/i.test(SHOT_FRAMING_RULE), "SHOT_FRAMING_RULE (DIALOGUE FRAMING) is still present");
  ok(/never a wide|NEVER a wide/i.test(SHOT_FRAMING_RULE), "dialogue-framing rule still bans a WS while a line is spoken");
}

/* ───────────── 6) all four rules are wired into the assembled SYSTEM prompt ───────────── */
{
  ok(SHOT_PLAN_SYSTEM.includes(SHOT_GEOGRAPHY_RULE), "SHOT_PLAN_SYSTEM includes the geography rule");
  ok(SHOT_PLAN_SYSTEM.includes(SHOT_SCENE_OPENING_RULE), "SHOT_PLAN_SYSTEM includes the new-scene-opening rule");
  ok(SHOT_PLAN_SYSTEM.includes(SHOT_REACTION_RULE), "SHOT_PLAN_SYSTEM includes the cause-before-reaction reaction rule");
  ok(SHOT_PLAN_SYSTEM.includes(SHOT_FRAMING_RULE), "SHOT_PLAN_SYSTEM still includes the dialogue-framing rule");
}

/* ───────────── 7) the JSON contract is unchanged, so the prompt version stays 6.2.0 ───────────── */
{
  ok(SHOT_PLAN_PROMPT_VERSION === "6.2.0", "SHOT_PLAN_PROMPT_VERSION stays 6.2.0 (guidance-only change, JSON contract unchanged)");
  // the return-shape contract is still described verbatim in the prompt
  ok(/Return JSON:/.test(SHOT_PLAN_SYSTEM), "SHOT_PLAN_SYSTEM still declares the same 'Return JSON' contract");
}

console.log(`\nStage 190: PASS (${passed} checks)`);
