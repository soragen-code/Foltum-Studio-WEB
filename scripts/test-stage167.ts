/**
 * Stage 167 (task Stage 5+6 replacement) — the SHOT is the atomic unit of generation.
 *
 * This suite unit-tests, offline and synthetically, every pure piece introduced in Stage 167:
 *   - the numeric constants (season.ts) agree with their prompt-module literal mirrors;
 *   - every shot-plan validator (a valid plan passes; each rule fails on a targeted mutation);
 *   - normalizeShotPlan's safe defaults / never-throws behavior;
 *   - the shotType→camera table + resolveShotSize dialogue-framing (dialogue/reaction+line never WS);
 *   - assembleShotPrompt block presence/order, startState only on the first shot, endState only on the
 *     last, and the DIALOGUE_FRAMING_RULE folded into a speaking dialogue shot;
 *   - the assembly pipeline helpers (concat plan, postFx filters, centered subtitles, quiet music);
 *   - the textual continuity critic (consistent vs jump) and the VLM path skipping without a vision fn;
 *   - backward compatibility (a legacy scene with no escalationBeats/shots flows through every helper).
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations (the VLM path is structurally
 * unreachable without an injected vision fn + real https URLs, so it is never called here).
 * NOTE: the repo has no vitest wiring; per repo convention this uses the hand-written assertion style.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage167.ts
 */
import {
  SHOT_MIN_SECONDS,
  SHOT_MAX_SECONDS,
  REACTION_SHOT_MIN_SECONDS,
  REACTION_SHOT_MAX_SECONDS,
  EPISODE_MIN_SHOTS,
  EPISODE_MAX_SHOTS,
  EPISODE_SHOT_TOTAL_MIN,
  EPISODE_SHOT_TOTAL_MAX,
  SHOT_LINE_MAX_WORDS,
  SHOT_MIN_SILENT_RATIO,
  ESCALATION_LADDER,
} from "../lib/season";
import {
  SHOT_PLAN_PROMPT_VERSION,
  DEFAULT_CLIFFHANGER_TYPE,
  STAGE167_SHOT_MIN_SEC,
  STAGE167_SHOT_MAX_SEC,
  STAGE167_REACTION_MIN_SEC,
  STAGE167_REACTION_MAX_SEC,
  STAGE167_MIN_SHOTS,
  STAGE167_MAX_SHOTS,
  STAGE167_EP_TOTAL_MIN,
  STAGE167_EP_TOTAL_MAX,
  STAGE167_LINE_MAX_WORDS,
  STAGE167_MIN_SILENT_RATIO,
  shotPlanUserPrompt,
  shotPlanRetryNote,
  type PlannedShot,
} from "../lib/prompts/shot-plan";
import {
  validateShotPlan,
  validateShotCounts,
  validateFirstThreeShots,
  validateHighImpactReactions,
  validateSilentRatio,
  validateLineWordCounts,
  validateNoAdjacentSizeCamera,
  validateDialogueFraming,
  validateLastTwoCliffhanger,
  normalizeShotPlan,
} from "../lib/shot-plan";
import {
  SHOT_PROMPT_VERSION,
  SHOT_CAMERA_BY_TYPE,
  SHOT_BLOCK_NAMES,
  resolveShotSize,
  assembleShotPrompt,
  type ShotPromptInput,
} from "../lib/prompts/shot";
import { DIALOGUE_FRAMING_RULE } from "../lib/scene-prompt";
import {
  postFxToFfmpegFilter,
  postFxToAudioFilter,
  buildConcatPlan,
  buildSubtitleSpec,
  musicForBeat,
  textualContinuityCheck,
  textualContinuityChain,
  compareShotKeyframesVLM,
} from "../lib/shot-pipeline";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

/* ────────────────────────────── fixtures ────────────────────────────── */

function makeShot(o: Partial<PlannedShot> & { index: number }): PlannedShot {
  return {
    index: o.index,
    sceneNumber: o.sceneNumber ?? 1,
    shotType: o.shotType ?? "dialogue",
    size: o.size ?? "MCU",
    duration: o.duration ?? SHOT_MAX_SECONDS,
    camera: o.camera ?? "ots-medium",
    speakerId: o.speakerId ?? null,
    line: o.line ?? null,
    lineImpact: o.lineImpact ?? (o.line ? "medium" : null),
    reactionOfId: o.reactionOfId ?? null,
    escalationBeat: o.escalationBeat ?? "verbal",
    postFx: o.postFx ?? "none",
    matchCutIn: o.matchCutIn ?? "",
    matchCutOut: o.matchCutOut ?? "",
    cliffhangerRole: o.cliffhangerRole ?? null,
    cliffhangerType: o.cliffhangerType ?? null,
  };
}

/** A hand-built, valid 18-shot plan that satisfies every validator. */
function validShots(): PlannedShot[] {
  return [
    makeShot({ index: 0, shotType: "dialogue", size: "MCU", camera: "ots-medium", line: "You lied to me.", matchCutOut: "hand on the letter" }),
    makeShot({ index: 1, shotType: "action", size: "MS", camera: "handheld-track", matchCutIn: "hand on the letter" }),
    makeShot({ index: 2, shotType: "dialogue", size: "CU", camera: "push-close", line: "Say it again.", lineImpact: "high" }),
    makeShot({ index: 3, shotType: "reaction", size: "CU", camera: "push-close-b", duration: 1.2 }),
    makeShot({ index: 4, shotType: "dialogue", size: "MCU", camera: "ots-medium", line: "I trusted you completely." }),
    makeShot({ index: 5, shotType: "insert", size: "CU", camera: "static-detail" }),
    makeShot({ index: 6, shotType: "dialogue", size: "MS", camera: "ots-wide", line: "Then prove it now." }),
    makeShot({ index: 7, shotType: "action", size: "MCU", camera: "handheld-track" }),
    makeShot({ index: 8, shotType: "dialogue", size: "CU", camera: "push-close", line: "Never.", lineImpact: "high" }),
    makeShot({ index: 9, shotType: "reaction", size: "MCU", camera: "push-close", duration: 1.3 }),
    makeShot({ index: 10, shotType: "dialogue", size: "MS", camera: "ots-medium", line: "You'll regret this choice." }),
    makeShot({ index: 11, shotType: "insert", size: "CU", camera: "static-detail" }),
    makeShot({ index: 12, shotType: "action", size: "MS", camera: "handheld-track-b" }),
    makeShot({ index: 13, shotType: "dialogue", size: "MCU", camera: "ots-medium", line: "I already do." }),
    makeShot({ index: 14, shotType: "insert", size: "CU", camera: "static-detail-b" }),
    makeShot({ index: 15, shotType: "action", size: "MS", camera: "wide-track" }),
    makeShot({ index: 16, shotType: "dialogue", size: "MCU", camera: "ots-close", line: "Someone's coming.", cliffhangerRole: "arrival", matchCutOut: "headlights sweep the wall" }),
    makeShot({ index: 17, shotType: "reaction", size: "CU", camera: "push-close", duration: 1.2, cliffhangerRole: "strike", matchCutIn: "headlights sweep the wall" }),
  ];
}

/* ────────────────────────────── 1) constants agree ────────────────────────────── */

ok(STAGE167_SHOT_MIN_SEC === SHOT_MIN_SECONDS, "shot-plan literal mirror STAGE167_SHOT_MIN_SEC == season SHOT_MIN_SECONDS");
ok(STAGE167_SHOT_MAX_SEC === SHOT_MAX_SECONDS, "STAGE167_SHOT_MAX_SEC == SHOT_MAX_SECONDS");
ok(STAGE167_REACTION_MIN_SEC === REACTION_SHOT_MIN_SECONDS, "STAGE167_REACTION_MIN_SEC == REACTION_SHOT_MIN_SECONDS");
ok(STAGE167_REACTION_MAX_SEC === REACTION_SHOT_MAX_SECONDS, "STAGE167_REACTION_MAX_SEC == REACTION_SHOT_MAX_SECONDS");
ok(STAGE167_MIN_SHOTS === EPISODE_MIN_SHOTS, "STAGE167_MIN_SHOTS == EPISODE_MIN_SHOTS");
ok(STAGE167_MAX_SHOTS === EPISODE_MAX_SHOTS, "STAGE167_MAX_SHOTS == EPISODE_MAX_SHOTS");
ok(STAGE167_EP_TOTAL_MIN === EPISODE_SHOT_TOTAL_MIN, "STAGE167_EP_TOTAL_MIN == EPISODE_SHOT_TOTAL_MIN");
ok(STAGE167_EP_TOTAL_MAX === EPISODE_SHOT_TOTAL_MAX, "STAGE167_EP_TOTAL_MAX == EPISODE_SHOT_TOTAL_MAX");
ok(STAGE167_LINE_MAX_WORDS === SHOT_LINE_MAX_WORDS, "STAGE167_LINE_MAX_WORDS == SHOT_LINE_MAX_WORDS");
ok(STAGE167_MIN_SILENT_RATIO === SHOT_MIN_SILENT_RATIO, "STAGE167_MIN_SILENT_RATIO == SHOT_MIN_SILENT_RATIO");
ok(SHOT_PLAN_PROMPT_VERSION === "6.2.0" && SHOT_PROMPT_VERSION === "6.2.0", "prompt versions are 6.2.0");
ok(ESCALATION_LADDER.length >= 5 && ESCALATION_LADDER.length <= 7, "escalation ladder is 5–7 rungs");

/* ────────────────────────────── 2) valid plan passes ────────────────────────────── */

const good = validShots();
ok(good.length >= EPISODE_MIN_SHOTS && good.length <= EPISODE_MAX_SHOTS, "fixture shot count within bounds");
const total = good.reduce((a, s) => a + s.duration, 0);
ok(total >= EPISODE_SHOT_TOTAL_MIN && total <= EPISODE_SHOT_TOTAL_MAX, `fixture total duration ${total.toFixed(1)}s within 60–90`);
const v = validateShotPlan(good);
ok(v.ok, "validateShotPlan passes the valid fixture" + (v.ok ? "" : ": " + JSON.stringify(v.errors)));
ok(v.errors.length === 0, "valid fixture yields zero errors");

/* ────────────────────────────── 3) each rule fails on a targeted mutation ────────────────────────────── */

// shot-count: too few
ok(validateShotCounts(good.slice(0, 5)).some((e) => e.rule === "shot-count"), "shot-count fails with too few shots");
// shot-duration: a normal shot too long
{
  const m = good.map((s) => ({ ...s }));
  m[4].duration = 9;
  ok(validateShotCounts(m).some((e) => e.rule === "shot-duration" && e.shotIndex === 4), "shot-duration fails for an over-long shot");
}
// total-duration: shrink every shot
{
  const m = good.map((s) => ({ ...s, duration: 1.5 }));
  ok(validateShotCounts(m).some((e) => e.rule === "total-duration"), "total-duration fails when the episode is too short");
}
// first-three-no-establishing
{
  const m = good.map((s) => ({ ...s }));
  m[1].shotType = "establishing";
  ok(validateFirstThreeShots(m).some((e) => e.rule === "first-three-no-establishing"), "first-three rule fails on an early establishing shot");
}
// high-impact-reaction: high line not followed by reaction
{
  const m = good.map((s) => ({ ...s }));
  m[3].shotType = "insert"; // shot 2 is high-impact; its follower is no longer a reaction
  ok(validateHighImpactReactions(m).some((e) => e.rule === "high-impact-reaction"), "high-impact-reaction fails when no reaction follows");
}
// silent-ratio: give every shot a line
{
  const m = good.map((s) => ({ ...s, line: "a short spoken line" }));
  ok(validateSilentRatio(m).some((e) => e.rule === "silent-ratio"), "silent-ratio fails when too few shots are silent");
}
// line-word-count
{
  const m = good.map((s) => ({ ...s }));
  m[0].line = "this line is deliberately far too long to ever pass the twelve word limit rule";
  ok(validateLineWordCounts(m).some((e) => e.rule === "line-word-count" && e.shotIndex === 0), "line-word-count fails on a >12-word line");
}
// no-adjacent-size-camera
{
  const m = good.map((s) => ({ ...s }));
  m[1] = { ...m[1], size: m[0].size, camera: m[0].camera };
  ok(validateNoAdjacentSizeCamera(m).some((e) => e.rule === "no-adjacent-size-camera"), "no-adjacent-size-camera fails on a repeated size+camera");
}
// dialogue-framing: a speaking dialogue shot in a WS
{
  const m = good.map((s) => ({ ...s }));
  m[0] = { ...m[0], size: "WS" };
  ok(validateDialogueFraming(m).some((e) => e.rule === "dialogue-framing" && e.shotIndex === 0), "dialogue-framing fails on a WS with a line");
}
// last-two-cliffhanger: strip the roles
{
  const m = good.map((s) => ({ ...s, cliffhangerRole: null, cliffhangerType: null }));
  ok(validateLastTwoCliffhanger(m).some((e) => e.rule === "last-two-cliffhanger"), "last-two-cliffhanger fails without arrival→strike");
}
// last-two-cliffhanger: a named season type on the last shot satisfies it
{
  const m = good.map((s) => ({ ...s, cliffhangerRole: null }));
  m[m.length - 1] = { ...m[m.length - 1], cliffhangerType: "betrayalReveal" };
  ok(validateLastTwoCliffhanger(m, { cliffhangerType: "betrayalReveal" }).length === 0, "last-two-cliffhanger passes with a matching named season cliffhanger type");
}

/* ────────────────────────────── 4) normalizeShotPlan ────────────────────────────── */

{
  const norm = normalizeShotPlan([{ shotType: "bogus", size: "XX", duration: "nope", line: "hi" }, {}]);
  ok(norm.length === 2, "normalizeShotPlan keeps every entry");
  ok(norm[0].index === 0 && norm[1].index === 1, "normalizeShotPlan forces sequential 0-based index");
  ok(norm[0].shotType === "dialogue" && norm[0].size === "MS", "normalizeShotPlan defaults invalid enums");
  ok(norm[0].duration === SHOT_MIN_SECONDS, "normalizeShotPlan defaults invalid duration to the floor");
  ok(norm[0].line === "hi" && norm[0].lineImpact === "medium", "normalizeShotPlan keeps a line and defaults its impact");
  ok(norm[1].line === null && norm[1].lineImpact === null, "normalizeShotPlan leaves a lineless shot silent");
}
ok(normalizeShotPlan({ shots: [{}, {}, {}] }).length === 3, "normalizeShotPlan accepts a { shots: [...] } wrapper");
ok(normalizeShotPlan(null).length === 0 && normalizeShotPlan("garbage").length === 0, "normalizeShotPlan never throws on garbage");

/* ────────────────────────────── 5) camera table + resolveShotSize ────────────────────────────── */

ok(!SHOT_CAMERA_BY_TYPE.dialogue.allowedSizes.includes("WS"), "dialogue camera never allows WS");
ok(!SHOT_CAMERA_BY_TYPE.reaction.allowedSizes.includes("WS"), "reaction camera never allows WS");
ok(SHOT_CAMERA_BY_TYPE.establishing.allowedSizes.includes("WS"), "establishing camera allows WS");
ok(resolveShotSize({ shotType: "dialogue", size: "WS", line: "hello there" }) !== "WS", "resolveShotSize forces a speaking dialogue shot off WS");
ok(resolveShotSize({ shotType: "dialogue", size: "WS", line: "hello there" }) === SHOT_CAMERA_BY_TYPE.dialogue.defaultSize, "resolveShotSize falls back to the dialogue default framing");
ok(resolveShotSize({ shotType: "establishing", size: "WS", line: "" }) === "WS", "resolveShotSize keeps a silent establishing WS");

/* ────────────────────────────── 6) assembleShotPrompt ────────────────────────────── */

function promptInput(o: Partial<ShotPromptInput> & { shot: PlannedShot }): ShotPromptInput {
  return {
    style: "gritty cinematic drama, muted palette",
    locationName: "INT. courthouse corridor",
    locationLight: "late afternoon amber",
    characters: [{ characterId: "c1", name: "Yara", appearance: "sharp bob, grey coat", wardrobe: "grey wool coat" }],
    shot: o.shot,
    startState: o.startState ?? null,
    endState: o.endState ?? null,
    isSceneFirst: o.isSceneFirst ?? false,
    isSceneLast: o.isSceneLast ?? false,
    dialogueLanguage: o.dialogueLanguage ?? "en",
  };
}

{
  const dlg = makeShot({ index: 0, shotType: "dialogue", size: "MCU", line: "You lied to me.", matchCutIn: "hand on the door", matchCutOut: "eyes narrowing" });
  const a = assembleShotPrompt(promptInput({ shot: dlg, isSceneFirst: true, startState: "The corridor is empty and cold." }));
  ok(a.version === SHOT_PROMPT_VERSION, "assembleShotPrompt stamps the prompt version");
  ok(a.blocks.style && a.blocks.location && a.blocks.character, "assembled prompt has style, location, character blocks");
  ok(a.blocks.line.includes("You lied to me."), "line block carries the spoken line");
  ok(a.blocks.camera.includes(DIALOGUE_FRAMING_RULE), "a speaking dialogue shot folds in the DIALOGUE_FRAMING_RULE");
  ok(a.size !== "WS", "assembled speaking dialogue shot is never WS");
  ok(a.blocks.startState.length > 0, "startState present on the first shot of the scene");
  // block ORDER preserved: the assembled prompt concatenates present blocks in SHOT_BLOCK_NAMES order.
  const presentOrder = SHOT_BLOCK_NAMES.filter((n) => a.blocks[n] && a.blocks[n].length > 0);
  let cursor = -1;
  let ordered = true;
  for (const n of presentOrder) {
    const at = a.prompt.indexOf(a.blocks[n]);
    if (at <= cursor) ordered = false;
    cursor = at;
  }
  ok(ordered, "assembled prompt keeps blocks in SHOT_BLOCK_NAMES order");
}
{
  // startState only on the first shot; endState only on the last.
  const mid = makeShot({ index: 5, shotType: "insert", size: "CU" });
  const a = assembleShotPrompt(promptInput({ shot: mid, isSceneFirst: false, isSceneLast: false, startState: "x", endState: "y" }));
  ok(a.blocks.startState === "" && a.blocks.endState === "", "startState/endState omitted for a mid-scene shot even when supplied");
  const last = makeShot({ index: 17, shotType: "reaction", size: "CU" });
  const b = assembleShotPrompt(promptInput({ shot: last, isSceneLast: true, endState: "The door hangs open." }));
  ok(b.blocks.endState.length > 0 && b.blocks.startState === "", "endState present only on the last shot of the scene");
  // a silent shot has no line block
  ok(a.blocks.line === "", "a silent shot produces no line block");
}

/* ────────────────────────────── 7) pipeline helpers ────────────────────────────── */

ok(postFxToFfmpegFilter("slowmo").includes("setpts"), "slowmo → setpts video filter");
ok(postFxToFfmpegFilter("punchZoom").includes("zoompan"), "punchZoom → zoompan video filter");
ok(postFxToFfmpegFilter("none") === "" && postFxToFfmpegFilter("bogus") === "", "none/unknown → no video filter");
ok(postFxToAudioFilter("slowmo") === "atempo=0.5" && postFxToAudioFilter("none") === "", "slowmo stretches audio; none does not");

{
  const plan = buildConcatPlan(good.map((s) => ({ ...s, videoUrl: `https://cdn/x/${s.index}.mp4` })));
  ok(plan.ready, "concat plan is ready when every shot has a videoUrl");
  ok(plan.clips[0].index === 0 && plan.clips[plan.clips.length - 1].index === 17, "concat plan is ordered by shot index");
  const notReady = buildConcatPlan([{ index: 0, duration: 3, postFx: "none", videoUrl: null }]);
  ok(!notReady.ready, "concat plan is not ready when a shot lacks a videoUrl");
}
{
  const spec = buildSubtitleSpec(good);
  ok(spec.alignment === "center", "subtitles are centered");
  ok(spec.language === "en", "subtitle language defaults to en");
  const lineCount = good.filter((s) => (s.line ?? "").trim()).length;
  ok(spec.cues.length === lineCount, "one subtitle cue per spoken line, none for silent shots");
  ok(spec.cues[0].start === 0, "first cue starts at 0");
  ok(spec.cues.every((c) => c.end > c.start), "every cue ends after it starts");
  ok(buildSubtitleSpec(good, { dialogueLanguage: "uk" }).language === "uk", "dialogueLanguage threads through");
}
ok(musicForBeat("expectationFlip") === "tense" && musicForBeat("statusReveal") === "dark", "musicForBeat maps beats to quiet moods");
ok(musicForBeat(null) === "mysterious", "musicForBeat defaults to a quiet mood");

/* ────────────────────────────── 8) continuity critic ────────────────────────────── */

ok(
  textualContinuityCheck({ index: 0, matchCutOut: "hand on the letter" }, { index: 1, matchCutIn: "hand grips the letter" }).consistent,
  "textual continuity is consistent when match-cuts share a prop"
);
ok(
  !textualContinuityCheck({ index: 0, matchCutOut: "hand on the letter" }, { index: 1, matchCutIn: "wide shot of the skyline" }).consistent,
  "textual continuity flags a jump when match-cuts share nothing"
);
ok(
  textualContinuityCheck({ index: 0, matchCutOut: "" }, { index: 1, matchCutIn: "" }).consistent,
  "textual continuity treats empty match-cuts as continuous (nothing to contradict)"
);
ok(textualContinuityChain(good).length === good.length - 1, "continuity chain yields one result per adjacent pair");

/* ────────────────────────────── 9) backward compatibility ────────────────────────────── */

{
  // a legacy scene object with NO escalationBeats / keyProp / shots must flow through the pure helpers.
  const legacyScene = { number: 1, action: "Yara waits.", dialogue: "YARA: Well?" };
  ok(typeof shotPlanUserPrompt([legacyScene]) === "string", "shotPlanUserPrompt tolerates a legacy scene without escalationBeats/keyProp");
  ok(shotPlanUserPrompt([legacyScene]).includes(DEFAULT_CLIFFHANGER_TYPE), "shot-plan prompt falls back to the default cliffhanger type");
  ok(typeof shotPlanRetryNote("silent-ratio") === "string", "shotPlanRetryNote builds a targeted note");
  ok(buildConcatPlan([]).ready === false && buildSubtitleSpec([]).cues.length === 0, "empty shot list flows through the pipeline without throwing");
}

/* ────────────────────────────── 10) VLM path is structurally unreachable offline ────────────────────────────── */

void (async () => {
  const skipNoFn = await compareShotKeyframesVLM("https://www.provideocoalition.com/wp-content/uploads/keyframe-premiere-2.png", "https://pbs.twimg.com/media/HOkLg5aaQAA9f3Y.jpg", null);
  ok(skipNoFn.consistent && /skipped/i.test(skipNoFn.reason), "VLM path skips (no vision fn) without calling anything");
  let called = false;
  const visionFn = async () => {
    called = true;
    return { consistent: true, reason: "match" };
  };
  const skipNoUrl = await compareShotKeyframesVLM(null, "https://miro.medium.com/v2/resize:fit:1400/1*WrARVGN-GoG3KCKUOCt6Dw.png", visionFn);
  ok(skipNoUrl.consistent && !called, "VLM path skips (no real prev URL) without invoking the vision fn");
  const skipBadUrl = await compareShotKeyframesVLM("not-a-url", "also-bad", visionFn);
  ok(skipBadUrl.consistent && !called, "VLM path skips non-http URLs without invoking the vision fn");

  console.log(`\nStage 167: PASS (${passed} checks)`);
})();
