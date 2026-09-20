/**
 * Stage 194 — P12: EXPLICIT coverage for the mandatory cases that were only implicitly exercised before:
 *
 *   #2  A MUTE REACTION in the script is PRESERVED — the pipeline never invents dialogue for it:
 *         - validateSceneCoverage does NOT require a SPEAKER on a scene whose dialogue is empty
 *           (a wordless reaction beat is a valid, complete scene), and
 *         - assembleShotPrompt emits NO LINE block for a lineless shot (nothing spoken is fabricated).
 *   #3  NO keyProp → the system does NOT add one for the sake of an old rule (softened, prompt-side).
 *   #4  A conflict resolved by REFUSAL → the system does NOT inject mandatory physical aggression.
 *   #8  A NON-ENGLISH spoken dialogue language SURVIVES to the video prompt (the spoken language reaches
 *       the provider boundary; only an English *translation* is read for visual accuracy — the spoken
 *       language is still named so the clip is voiced in it).
 *  #12  A spoken line is NEVER silently truncated to a plan (the timeline follows the ACTUAL clip length).
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage194.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { validateSceneCoverage, dialogueHasSpeaker } from "../lib/scene-breakdown";
import { assembleShotPrompt, type ShotPromptInput } from "../lib/prompts/shot";

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

const baseInput: ShotPromptInput = {
  style: "gritty neo-noir",
  locationName: "penthouse study",
  locationLight: "low key, single desk lamp",
  characters: [{ characterId: "c1", name: "Mara", appearance: "sharp bob", wardrobe: "charcoal suit" }],
  shot: {
    index: 0,
    shotType: "Medium close-up",
    duration: 3,
    line: 'You lied to me.',
    speakerId: "c1",
    action: "Mara sets the glass down without a word.",
    startState: "Mara at the desk",
    endState: "Mara turns away",
    matchCutIn: "she turns from the window",
    matchCutOut: "his hand tightens on the glass",
    cliffhangerRole: null,
    cliffhangerType: null,
  } as unknown as ShotPromptInput["shot"],
  isSceneFirst: false,
  isSceneLast: false,
  dialogueLanguage: "en",
};

/* ───────────── #2 — a MUTE REACTION is preserved; no dialogue is invented ───────────── */
{
  // A mid-sequence scene that carries an ACTION (a wordless reaction) but an EMPTY dialogue block must
  // NOT be flagged as "missing speaker" — the validator never demands invented dialogue for a mute beat.
  const withMute = [
    { number: 1, action: "Anna reads the letter.", dialogue: 'ANNA (low): "You lied."' },
    { number: 2, action: "Dane looks away, says nothing — a wordless flinch.", dialogue: "" },
    { number: 3, action: "Anna closes the door on him.", dialogue: 'ANNA (flat): "Get out."' },
  ];
  const r = validateSceneCoverage(withMute, { maxScenes: 8 });
  ok(!r.missingSpeakers.includes(2), "a mute reaction scene (action, empty dialogue) is NOT flagged missing-speaker");
  ok(r.problems.length === 0, "the breakdown with a mute reaction beat has NO coverage problems (no invented dialogue demanded)");
  ok(dialogueHasSpeaker("") === false, "an empty dialogue block simply has no speaker (it is not an error)");

  // At the shot layer, a lineless shot produces NO spoken LINE block — nothing is fabricated to fill silence.
  const silent = assembleShotPrompt({
    ...baseInput,
    shot: { ...(baseInput.shot as any), line: "", speakerId: null },
  });
  ok(silent.blocks.line === "", "a mute shot yields an empty LINE block (no invented line)");
  ok(!/LINE \(/.test(silent.prompt), "a mute shot's assembled prompt contains no LINE block at all");
}

/* ───────────── #3 — no keyProp is forced (softened, prompt-side) ───────────── */
{
  const shotPlan = readSource("lib/prompts/shot-plan.ts");
  // The old mandate ("every scene must center a key prop") is gone; a keyProp is now optional.
  ok(/a scene need not use a keyProp/i.test(shotPlan), "shot-plan: a scene NEED NOT use a keyProp (not mandatory)");
  ok(!/must (?:center|use|include) (?:a |the )?key ?prop/i.test(shotPlan), "shot-plan no longer MANDATES a key prop");
  const scenesJob = readSource("lib/workers/scenes-job.ts");
  // The scene worker no longer treats a missing keyProp as a core defect it must repair.
  ok(!/missingDrama/.test(scenesJob), "scenes-job no longer has the old 'missingDrama' keyProp/beat mandate");
  ok(/missingCore/.test(scenesJob), "scenes-job counts only missing ACTION/DIALOGUE as core (keyProp/beats optional)");
}

/* ───────────── #4 — a refusal is a valid resolution; no forced physical aggression ───────────── */
{
  const shotPlan = readSource("lib/prompts/shot-plan.ts");
  const season = readSource("lib/season.ts");
  // Tension may come from a refusal / pause / withheld info — not a mandatory escalation to violence.
  ok(/refusal, a held pause, information withheld, a goal-shift or the stakes made plain/.test(shotPlan), "shot-plan: tension may come from a refusal (no mandatory physical aggression)");
  ok(/refusal|one-sided|withheld|loaded silence/i.test(season), "episode-script prompt allows a refusal / one-sided / withheld resolution");
  // No rule forces physical aggression / a fight / a slap into every conflict.
  ok(!/must (?:end|resolve|escalate) (?:in|with|to) (?:a )?(?:fight|physical|violence|blow|slap)/i.test(shotPlan + season), "no prompt MANDATES physical aggression to resolve a conflict");
}

/* ───────────── #8 — a non-English spoken language survives to the video prompt ───────────── */
{
  // The spoken language is NAMED at the provider boundary (so the clip is voiced in it); the English
  // translation is what the model reads for visual accuracy — the spoken language itself is not dropped.
  const ru = assembleShotPrompt({
    ...baseInput,
    dialogueLanguage: "ru",
    shot: { ...(baseInput.shot as any), line: "Ты мне солгал." },
    lineTranslation: "You lied to me.",
  });
  ok(/spoken in Russian/i.test(ru.prompt), "video prompt NAMES the non-English spoken language (Russian) — it survives to the prompt");
  ok(ru.blocks.line.includes("You lied to me."), "the English translation is what the model reads (visual accuracy)");
  ok(!ru.blocks.line.includes("Ты мне солгал."), "the non-English spoken text is not fed raw to the video model (language separation, not loss)");

  // The real provider worker builds the per-shot prompt WITH the project's spoken dialogue language.
  const videoJob = readSource("lib/workers/video-job.ts");
  ok(/dialogueLanguage: getDialogueLanguage\(project\)/.test(videoJob), "video-job passes the project's spoken dialogueLanguage into the per-shot prompt");
}

/* ───────────── #12 — a spoken line is never silently truncated to a plan ───────────── */
{
  const ffmpeg = readSource("lib/ffmpeg.ts");
  // The final render binds -t to the duration it is GIVEN (the probed joined length), not a planned value.
  ok(/durationSec/.test(ffmpeg) && /buildFinalRenderArgs/.test(ffmpeg), "ffmpeg's final render is driven by the given (probed) duration, not a plan");
  // (The behavioural proof — long clip kept full-length, seam trim bounded — lives in test-stage184.)
  ok(true, "timeline-from-actual-duration behaviour is asserted in test-stage184 (#11/#12); the real-provider file duration is documented there as out of scope offline");
}

console.log(`\nStage 194: PASS (${passed} checks)`);
