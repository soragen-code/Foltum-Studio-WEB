/**
 * Stage 186 — P5: the SCRIPT step is STAGING-oriented (actions / lines / reactions), stage directions
 * never leak into spoken lines, the episode ending LOGICALLY follows from the episode's events, and the
 * softened dramaturgy mandates (mandatory two-way exchange, keyProp, fixed escalation ladder) are NOT
 * hard-gated by the validator.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage186.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  episodeScriptSchema,
  validateEpisodeScript,
  normalizeEpisodeScript,
  hardProblems,
  episodeScriptSystemPrompt,
  EPISODE_MIN_SCENES,
  EPISODE_MAX_SCENES,
} from "../lib/season";

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

/* ───────────── 1) the script prompt keeps spoken lines free of stage directions ───────────── */
{
  const prompt = episodeScriptSystemPrompt("en", 1);
  // stage directions / action / blocking / narration must never appear inside the spoken "dialogue" line
  ok(/NEVER stage directions/i.test(prompt), "prompt: spoken line carries ONLY words spoken — NEVER stage directions inside the line");
  ok(/belongs in "action"|belongs in \[BLOCKING\]|belongs in .action./i.test(prompt), "prompt: everything characters DO belongs in action / [BLOCKING] / [ACTION], not the line");
  // an example of the forbidden leak is called out explicitly
  ok(/he grabs the knife|walks to the door/i.test(prompt), "prompt gives a concrete example of the forbidden stage-direction-in-line leak");
}

/* ───────────── 2) the ending must LOGICALLY follow from the episode's events (causality) ───────────── */
{
  const prompt = episodeScriptSystemPrompt("en", 1);
  ok(/LOGICALLY FOLLOWS from the events of THIS episode/i.test(prompt), "prompt: cliffhanger must LOGICALLY FOLLOW from the events of THIS episode");
  ok(/causal pay-off/i.test(prompt) && /never an unrelated or arbitrary shock/i.test(prompt), "prompt: ending is a causal pay-off, never an unrelated/arbitrary shock bolted on");
}

/* ───────────── 3) the two-way exchange is softened to a recommendation, not a mandate ───────────── */
{
  const prompt = episodeScriptSystemPrompt("en", 1);
  ok(/NOT mandatory/i.test(prompt), "prompt: a genuine two-way exchange is strongest but NOT mandatory");
  ok(/refusal|one-sided|withheld|loaded silence|phone/i.test(prompt), "prompt: a scene may turn on a refusal / one-sided confrontation / withheld answer / loaded silence / phone");
  // but pure NARRATOR / voice-over-only scenes are still disallowed (spoken-language logic untouched)
  ok(/NARRATOR|voice-over-only/i.test(prompt), "prompt still forbids a pure off-screen NARRATOR / voice-over-only scene");
}

/* ───────────── 4) reactions + beats are required at the shot layer (staging), tension is advisory ───────────── */
{
  const src = readSource("lib/prompts/shot-plan.ts");
  ok(/SHOT_REACTION_RULE\s*=/.test(src) && /REACTION shot/i.test(src), "shot-plan requires a REACTION shot after every high-impact line");
  ok(/SHOT_SILENCE_RULE\s*=/.test(src) && /NO spoken line/i.test(src), "shot-plan requires image-only beats (≥30% shots carry no line)");
  ok(/SHOT_ESCALATION_RULE\s*=\s*\n?\s*"TENSION \(advisory, not a gate\)/.test(src), "shot-plan reframes escalation as TENSION (advisory, not a gate)");
  ok(/a scene need not use a keyProp, hit every rung, or grow monotonically louder/.test(src), "shot-plan: no mandatory keyProp / full ladder / monotone escalation");
  ok(/refusal, a held pause, information withheld, a goal-shift or the stakes made plain/.test(src), "shot-plan: tension may come from refusal / pause / withheld info / goal-shift / stakes");
}

/* ───────────── 5) a valid episode with one-sided dialogue, no keyProp, no escalation is NOT hard-gated ───────────── */
{
  const videoPrompt =
    "[SHOT TYPE]: Medium close-up\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: a\n[NON-VERBAL]: b\n[ACTION]: c\n[CHARACTER]: d\n[TRANSITION]: e";
  // one-sided ENGLISH dialogue — a single speaker, no two-way exchange, no keyProp, no escalation ladder
  const oneSided =
    'ANNA (quietly): "You knew about this from the very start and you said nothing. Every single evening you looked me in the eye and stayed silent. I trusted you with all of it."';
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      shotType: "Medium shot",
      durationSec: 30,
      locationDesc: "INT — Lighthouse — night",
      characters: ["Anna"],
      // scene 1 opens IN the conflict (not on an arrival / exposition)
      action: "Anna slams the letter onto the table.",
      dialogue: oneSided,
      videoPrompt,
      hook: i === 0 ? "A confession no one wanted to hear" : undefined,
      startState: "Anna grips the letter, facing the window, wide shot from the corner.",
      endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway.",
    }));

  for (const count of [EPISODE_MIN_SCENES, EPISODE_MAX_SCENES]) {
    const ep = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(count) }));
    const probs = validateEpisodeScript(ep);
    ok(
      hardProblems(probs).length === 0,
      `${count}-scene one-sided episode (no keyProp / no escalation / no two-way) has NO hard problems — softened mandates are not gated (got: ${JSON.stringify(hardProblems(probs))})`,
    );
  }
}

/* ───────────── 6) real production/technical gates still bite (proves we only softened the ARTISTIC mandates) ───────────── */
{
  const videoPrompt =
    "[SHOT TYPE]: Medium close-up\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: a\n[NON-VERBAL]: b\n[ACTION]: c\n[CHARACTER]: d\n[TRANSITION]: e";
  const line = 'ANNA (quietly): "You knew about this and you said nothing at all, for years, to my face."';
  const scene = {
    number: 1,
    shotType: "Medium shot",
    durationSec: 30,
    locationDesc: "INT — Lighthouse — night",
    characters: ["Anna"],
    action: "Anna slams the letter onto the table.",
    dialogue: line,
    videoPrompt,
    hook: "A confession no one wanted to hear",
    startState: "Anna grips the letter, wide shot from the corner.",
    endState: "Anna stands by the window, medium shot from the doorway.",
  };
  // too FEW scenes is still a hard failure (production limit — enforced by the validator)
  const tooFew = episodeScriptSchema.parse({
    visualIdentity: "photoreal cinematic",
    scenes: [scene, { ...scene, number: 2, hook: undefined }, { ...scene, number: 3, hook: undefined }],
  });
  const fewProbs = validateEpisodeScript(tooFew);
  ok(
    hardProblems(fewProbs).some((p) => /scene count \d+ below/i.test(p)),
    "an episode below the minimum scene count is still a hard failure (production limit intact)",
  );

  // a videoPrompt missing a required tag is still a hard failure (technical gate)
  const badPrompt = {
    visualIdentity: "photoreal cinematic",
    scenes: Array.from({ length: EPISODE_MIN_SCENES }, (_, i) => ({
      ...scene,
      number: i + 1,
      hook: i === 0 ? scene.hook : undefined,
      // long enough to pass the 40-char min, but missing the [TRANSITION] tag → technical gate must catch it
      videoPrompt:
        i === 2
          ? "[SHOT TYPE]: MCU\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: a\n[NON-VERBAL]: b\n[ACTION]: c\n[CHARACTER]: d"
          : videoPrompt,
    })),
  };
  const ep2 = normalizeEpisodeScript(episodeScriptSchema.parse(badPrompt));
  const probs2 = validateEpisodeScript(ep2);
  ok(
    hardProblems(probs2).some((p) => /videoPrompt missing/i.test(p)),
    "an incomplete videoPrompt is still a hard failure (technical gate intact)",
  );
}

console.log(`\nStage 186: PASS (${passed} checks)`);
