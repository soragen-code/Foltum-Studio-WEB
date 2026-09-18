/**
 * Stage 166 (task "Stage 5") — episode SCRIPT rework: 5–8 scenes, 3–15 s clips, 70–100 s total, hook,
 * cliffhanger, one emotional peak, ≤2 silent scenes (visualBeat), dialogue-polish rules, time skip,
 * structured state checklist, and the PROMPT_VERSION plumbing.
 *
 * PURE ASSERTIONS ONLY — no network, no LLM, no DB. Everything below tests pure functions, prompt strings
 * and zod validators. The defensive LLM wrappers are exercised with a fake chatJSON injected as a plain fn.
 * Run: timeout 180 npx tsx scripts/test-stage166.ts
 */
import {
  // constants
  STAGE166_MIN_SCENES,
  STAGE166_MAX_SCENES,
  STAGE166_SCENE_MIN_SEC,
  STAGE166_SCENE_MAX_SEC,
  STAGE166_EP_MIN_SEC,
  STAGE166_EP_MAX_SEC,
  STAGE166_MAX_SILENT_SCENES,
  DIALOGUE_MAX_AVG_WORDS,
  STATE_CHECKLIST_MIN_WORDS,
  EPISODE_SCRIPT_PROMPT_VERSION,
  TIME_SKIP_VALUES,
  isTimeSkip,
  STATE_CHECKLIST_ITEMS,
  STATE_CHECKLIST_TEXT,
  // rule strings
  SCENE_COUNT_DURATION_RULE,
  SCENE_HOOK_RULE,
  LAST_SCENE_CLIFFHANGER_RULE,
  EMOTIONAL_PEAK_RULE,
  TIME_SKIP_RULE,
  SILENT_SCENE_RULE,
  DIALOGUE_POLISH_SYSTEM,
  dialoguePolishUserPrompt,
  STATE_CHECKLIST_CRITIC_SYSTEM,
  stateChecklistCriticUserPrompt,
  stateChecklistRetryNote,
  // pure helpers
  sceneCountInBounds,
  sceneDurationInBounds,
  episodeDurationTotalInBounds,
  resolveCliffhangerType,
  resolvePeakSceneIndex,
  resolveTimeSkipBefore,
  requiresEstablishingBeat,
  looksLikeExpositionOpening,
  averageDialogueLineWords,
  // defensive LLM wrappers
  polishEpisodeDialogue,
  judgeStateChecklist,
  type ChatJSONFn,
} from "../lib/prompts/episode-script";
import {
  EPISODE_MIN_SCENES,
  EPISODE_MAX_SCENES,
  SCENE_MIN_SECONDS,
  SCENE_CLIP_MAX_SECONDS,
  EPISODE_MIN_TOTAL_SECONDS,
  EPISODE_MAX_TOTAL_SECONDS,
  MAX_SILENT_SCENES,
  episodeScriptSchema,
  normalizeEpisodeScript,
  validateEpisodeScript,
  hardProblems,
  countWords,
  type EpisodeScript,
} from "../lib/season";

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  passed++; console.log(`ok: ${msg}`);
}

void (async () => {
/* ---- reusable fixtures ------------------------------------------------------ */
const videoPrompt = [
  "[SHOT TYPE]: medium close-up on Mara → over-the-shoulder on Deacon; vertical 9:16",
  "[VISUAL STYLE]: photoreal live-action, cold teal-and-amber palette",
  "[LIGHTING]: late evening, one desk lamp, grey rain light from the window",
  "[BLOCKING]: Mara stands at the desk; Deacon steps in from frame left",
  "[GAZE]: Mara locks eyes with Deacon; Deacon looks at the logbook",
  "[NON-VERBAL]: Mara's jaw tight; Deacon's hands flat on the desk",
  "[ACTION]: Mara slams the logbook shut as Deacon reaches for it.",
  "[CHARACTER]: Mara Vane, 36, red hair tied back; Deacon Ross, 41, grey coat",
  "[TRANSITION]: hard cut into the next shot",
].join("\n");
const state = (who: string) =>
  `WORLD: IN FRAME: ${who}. NOT IN FRAME: none. ${who} frame CENTER, foreground, facing the desk, right hand on the logbook. EMOTION: jaw tight, fear behind the eyes. PROP: brass logbook closed on the desk, lamp lit. LIGHT / TIME: desk lamp from frame left, hard shadow right, late evening, rain. CAMERA: medium close-up, eye-level, slight left angle.`;
const dlg = 'MARA (sharp): "You were at the pier."\nDEACON (flat): "Prove it."';
const mkScene = (n: number, dur: number, extra: Record<string, unknown> = {}) => ({
  number: n, shotType: "MCU", durationSec: dur, locationDesc: "INT — office — night",
  characters: ["Mara", "Deacon"], action: "Mara slams the logbook shut as Deacon reaches for it.",
  sceneKind: "dialogue" as const, dialogue: dlg, videoPrompt,
  presence: "both at the desk", entrances: "none", continuesFrom: n === 1 ? "new-sequence" : "same-location-continuation",
  startState: state("Mara"), endState: state("Deacon"), ...extra,
});
// A valid NEW-style 6-scene episode (scene 1 has a hook, last has endState, peak in the middle).
const mkEpisode = (over: Record<string, unknown> = {}, sceneCount = 6): EpisodeScript =>
  episodeScriptSchema.parse({
    visualIdentity: "photoreal cinematic",
    peakSceneIndex: 3,
    scenes: Array.from({ length: sceneCount }, (_, i) =>
      mkScene(i + 1, 13, i === 0 ? { hook: "Deacon is lying about the pier." } : {})),
    ...over,
  });
const cast = ["Mara Vane", "Deacon Ross"];
const fakeChat = (payload: unknown): ChatJSONFn => (async () => payload) as ChatJSONFn;

/* ---------------------------------------------------------------- (a) constants agree across modules */
ok(EPISODE_SCRIPT_PROMPT_VERSION === "6.1.0" && /^\d+\.\d+\.\d+$/.test(EPISODE_SCRIPT_PROMPT_VERSION), `PROMPT_VERSION is semver "${EPISODE_SCRIPT_PROMPT_VERSION}"`);
ok(STAGE166_MIN_SCENES === 5 && STAGE166_MAX_SCENES === 8, "scene band is 5–8");
ok(STAGE166_SCENE_MIN_SEC === 3 && STAGE166_SCENE_MAX_SEC === 15, "clip band is 3–15 s");
ok(STAGE166_EP_MIN_SEC === 70 && STAGE166_EP_MAX_SEC === 100, "episode band is 70–100 s");
ok(STAGE166_MAX_SILENT_SCENES === 2, "MAX_SILENT_SCENES is 2 (was 0)");
ok(DIALOGUE_MAX_AVG_WORDS === 12, "dialogue avg-line cap is 12 words");
ok(STATE_CHECKLIST_MIN_WORDS === 150, "state checklist floor is 150 words");
// season.ts must expose the SAME numbers (single source of truth check)
ok(EPISODE_MIN_SCENES === STAGE166_MIN_SCENES && EPISODE_MAX_SCENES === STAGE166_MAX_SCENES, "season.ts scene bounds match the prompt module");
ok(SCENE_MIN_SECONDS === STAGE166_SCENE_MIN_SEC && SCENE_CLIP_MAX_SECONDS === STAGE166_SCENE_MAX_SEC, "season.ts clip bounds match the prompt module");
ok(EPISODE_MIN_TOTAL_SECONDS === STAGE166_EP_MIN_SEC && EPISODE_MAX_TOTAL_SECONDS === STAGE166_EP_MAX_SEC, "season.ts total bounds match the prompt module");
ok(MAX_SILENT_SCENES === STAGE166_MAX_SILENT_SCENES, "season.ts MAX_SILENT_SCENES matches the prompt module");

/* ---------------------------------------------------------------- (b) scene-count / duration / total bounds */
ok(sceneCountInBounds(5) && sceneCountInBounds(8), "sceneCountInBounds accepts 5 and 8");
ok(!sceneCountInBounds(4) && !sceneCountInBounds(9), "sceneCountInBounds rejects 4 and 9");
ok(!sceneCountInBounds(6.5), "sceneCountInBounds rejects non-integers");
ok(sceneDurationInBounds(3) && sceneDurationInBounds(15), "sceneDurationInBounds accepts 3 and 15");
ok(!sceneDurationInBounds(2) && !sceneDurationInBounds(16), "sceneDurationInBounds rejects 2 and 16");
ok(episodeDurationTotalInBounds(70) && episodeDurationTotalInBounds(100), "episodeDurationTotalInBounds accepts 70 and 100");
ok(!episodeDurationTotalInBounds(69) && !episodeDurationTotalInBounds(101), "episodeDurationTotalInBounds rejects 69 and 101");

/* ---------------------------------------------------------------- (c) silent scenes: ≤2 AND visualBeat required */
// exactly 2 silent scenes, each with a visualBeat → no HARD problem
{
  const ep = mkEpisode({
    scenes: [
      mkScene(1, 13, { hook: "Deacon is lying about the pier." }),
      mkScene(2, 13, { dialogue: "[NO DIALOGUE]", visualBeat: "Mara's hand hovers over the logbook, deciding." }),
      mkScene(3, 13),
      mkScene(4, 13, { dialogue: "[NO DIALOGUE]", visualBeat: "A phone screen lights with a name." }),
      mkScene(5, 13),
      mkScene(6, 13),
    ],
  });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  ok(hardProblems(validateEpisodeScript(norm, { characterNames: cast, allowSilent: false })).length === 0, "2 silent scenes WITH visualBeat pass");
}
// a silent scene WITHOUT visualBeat → HARD problem
{
  const ep = mkEpisode({
    scenes: [
      mkScene(1, 13, { hook: "Deacon is lying about the pier." }),
      mkScene(2, 13, { dialogue: "[NO DIALOGUE]" }),
      mkScene(3, 13), mkScene(4, 13), mkScene(5, 13), mkScene(6, 13),
    ],
  });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  const probs = validateEpisodeScript(norm, { characterNames: cast, allowSilent: false });
  ok(hardProblems(probs).some((p) => /visualBeat/i.test(p)), "silent scene WITHOUT visualBeat is rejected (HARD)");
}
// 3 silent scenes (> MAX) → HARD problem
{
  const ep = mkEpisode({
    scenes: [
      mkScene(1, 13, { hook: "Deacon is lying about the pier." }),
      mkScene(2, 13, { dialogue: "[NO DIALOGUE]", visualBeat: "a" }),
      mkScene(3, 13, { dialogue: "[NO DIALOGUE]", visualBeat: "b" }),
      mkScene(4, 13, { dialogue: "[NO DIALOGUE]", visualBeat: "c" }),
      mkScene(5, 13), mkScene(6, 13),
    ],
  });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  const probs = validateEpisodeScript(norm, { characterNames: cast, allowSilent: false });
  ok(hardProblems(probs).some((p) => /at most 2 silent/i.test(p)), "more than 2 silent scenes is rejected (HARD)");
}

/* ---------------------------------------------------------------- (d) scene-1 hook + exposition rejection */
ok(/hook/i.test(SCENE_HOOK_RULE) && /first ~?3 ?seconds?/i.test(SCENE_HOOK_RULE), "SCENE_HOOK_RULE names the hook + first ~3 s");
ok(/must NOT open with exposition/i.test(SCENE_HOOK_RULE) && /ENTERING|entering/.test(SCENE_HOOK_RULE), "SCENE_HOOK_RULE forbids exposition + 'character enters'");
ok(looksLikeExpositionOpening("Mara enters the office and sits down."), "looksLikeExposition flags 'enters'");
ok(looksLikeExpositionOpening("Let me explain how it all began years ago."), "looksLikeExposition flags backstory exposition");
ok(!looksLikeExpositionOpening("Mara slams the logbook shut and rounds on Deacon."), "looksLikeExposition passes an in-conflict opening");
// scene 1 missing a hook → HARD problem
{
  const ep = mkEpisode({
    scenes: Array.from({ length: 6 }, (_, i) => mkScene(i + 1, 13)), // NO hook on scene 1
  });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  ok(hardProblems(validateEpisodeScript(norm, { characterNames: cast })).some((p) => /scene 1.*hook/i.test(p)), "scene 1 with no hook is rejected");
}
// scene 1 opening on exposition → HARD problem
{
  const ep = mkEpisode({
    scenes: Array.from({ length: 6 }, (_, i) =>
      mkScene(i + 1, 13, i === 0 ? { hook: "conflict", action: "Mara enters the office and settles at the desk." } : {})),
  });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  ok(hardProblems(validateEpisodeScript(norm, { characterNames: cast })).some((p) => /scene 1.*exposition|character enters/i.test(p)), "scene 1 opening on exposition is rejected");
}

/* ---------------------------------------------------------------- (e) last-scene cliffhanger + defensive type resolution */
ok(/UNRESOLVED IMAGE/i.test(LAST_SCENE_CLIFFHANGER_RULE) && /cliffhangerType/.test(LAST_SCENE_CLIFFHANGER_RULE), "LAST_SCENE_CLIFFHANGER_RULE demands an unresolved image + reads cliffhangerType");
ok(resolveCliffhangerType(undefined) === "unresolved-image", "resolveCliffhangerType falls back when seasonMap absent");
ok(resolveCliffhangerType(null, 2) === "unresolved-image", "resolveCliffhangerType falls back when seasonMap null");
ok(resolveCliffhangerType({}) === "unresolved-image", "resolveCliffhangerType falls back when cliffhangerType missing");
ok(resolveCliffhangerType({ cliffhangerType: "reveal" }) === "reveal", "resolveCliffhangerType reads the top-level type");
ok(resolveCliffhangerType({ episodes: [{ number: 2, cliffhangerType: "arrival" }] }, 2) === "arrival", "resolveCliffhangerType reads the per-episode type");

/* ---------------------------------------------------------------- (f) emotional peak: exactly one */
ok(/exactly one/i.test(EMOTIONAL_PEAK_RULE) && /peakSceneIndex/.test(EMOTIONAL_PEAK_RULE), "EMOTIONAL_PEAK_RULE demands exactly one peak in peakSceneIndex");
ok(resolvePeakSceneIndex({ scenes: [1, 2, 3, 4, 5, 6].map((n) => ({ number: n })) as EpisodeScript["scenes"], peakSceneIndex: 4 }) === 4, "resolvePeakSceneIndex uses a valid supplied index");
ok(resolvePeakSceneIndex({ scenes: [1, 2, 3, 4, 5, 6].map((n) => ({ number: n })) as EpisodeScript["scenes"] }) === 3, "resolvePeakSceneIndex defaults to the middle scene");
ok(resolvePeakSceneIndex({ scenes: [1, 2, 3, 4].map((n) => ({ number: n })) as EpisodeScript["scenes"], peakSceneIndex: 99 }) === 2, "resolvePeakSceneIndex ignores an out-of-range index");
// an out-of-range peakSceneIndex on the episode is a SOFT (advisory) problem, not HARD
{
  const ep = mkEpisode({ peakSceneIndex: 99 });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  const probs = validateEpisodeScript(norm, { characterNames: cast });
  ok(probs.some((p) => /peakSceneIndex 99/.test(p)) && hardProblems(probs).every((p) => !/peakSceneIndex/.test(p)), "out-of-range peakSceneIndex is soft, not hard");
}

/* ---------------------------------------------------------------- (g) dialogue polish rules (≤12 words, no motive-explaining) */
ok(/AT OR UNDER 12 words/i.test(DIALOGUE_POLISH_SYSTEM), "polish system: average line ≤12 words");
ok(/explains? their own motive|explain.*motive/i.test(DIALOGUE_POLISH_SYSTEM), "polish system: removes motive-explaining lines");
ok(/SUBTEXT/i.test(DIALOGUE_POLISH_SYSTEM), "polish system: favours subtext");
ok(/STRICTLY ENGLISH/i.test(DIALOGUE_POLISH_SYSTEM), "polish system: stays English");
ok(Math.abs(averageDialogueLineWords('MARA (sharp): "You were at the pier."\nDEACON (flat): "Prove it."') - 3.5) < 0.001, "averageDialogueLineWords strips cues and averages (5,2 → 3.5)");
ok(averageDialogueLineWords("[NO DIALOGUE]") === 0, "averageDialogueLineWords of a silent scene is 0");
// voiceProfiles clause appears only when supplied (Stage 2 defensive)
ok(!/VOICE PROFILES/.test(dialoguePolishUserPrompt({ scenes: mkEpisode().scenes })), "polish user prompt omits voice profiles when absent");
ok(/VOICE PROFILES/.test(dialoguePolishUserPrompt({ scenes: mkEpisode().scenes }, { "Mara Vane": "clipped, sarcastic" })), "polish user prompt includes voice profiles when supplied");

/* ---------------------------------------------------------------- (g2) polishEpisodeDialogue is defensive */
{
  const ep = mkEpisode();
  // Cyrillic reply must be rejected → original dialogue kept
  const cyr = await polishEpisodeDialogue(ep, fakeChat({ scenes: [{ number: 1, dialogue: 'МАРА: "русский текст"' }] }));
  ok(cyr.scenes[0].dialogue === ep.scenes[0].dialogue, "polishEpisodeDialogue rejects a Cyrillic rewrite (keeps original)");
  // a valid English rewrite is applied
  const good = await polishEpisodeDialogue(ep, fakeChat({ scenes: [{ number: 1, dialogue: 'MARA (cold): "You lied."' }] }));
  ok(/You lied\./.test(good.scenes[0].dialogue), "polishEpisodeDialogue applies a valid English rewrite");
  // a rewrite that would SILENCE a talking scene is ignored
  const silence = await polishEpisodeDialogue(ep, fakeChat({ scenes: [{ number: 1, dialogue: "[NO DIALOGUE]" }] }));
  ok(silence.scenes[0].dialogue === ep.scenes[0].dialogue, "polishEpisodeDialogue never silences a talking scene");
  // an error in chatJSON returns the script unchanged
  const errFn = (async () => { throw new Error("boom"); }) as ChatJSONFn;
  const onErr = await polishEpisodeDialogue(ep, errFn);
  ok(onErr.scenes.length === ep.scenes.length && onErr.scenes[0].dialogue === ep.scenes[0].dialogue, "polishEpisodeDialogue returns the input on error");
}

/* ---------------------------------------------------------------- (h) time skip enum + establishing beat */
ok(TIME_SKIP_VALUES.join(",") === "none,minutes,hours,days,weeks", "TIME_SKIP_VALUES enum is none|minutes|hours|days|weeks");
ok(isTimeSkip("days") && !isTimeSkip("years") && !isTimeSkip(undefined), "isTimeSkip guards the enum");
ok(/timeSkipBefore/.test(TIME_SKIP_RULE) && /ESTABLISHING/i.test(TIME_SKIP_RULE), "TIME_SKIP_RULE names the field + establishing beat");
ok(resolveTimeSkipBefore({ timeSkipBefore: "hours" }) === "hours", "resolveTimeSkipBefore reads the scene's own value");
ok(resolveTimeSkipBefore({ timeSkipBefore: "bogus" }) === "none", "resolveTimeSkipBefore falls back to none on a bad value");
ok(resolveTimeSkipBefore(null) === "none", "resolveTimeSkipBefore defaults to none when scene absent");
ok(resolveTimeSkipBefore(null, { episodes: [{ number: 1, scenes: [{ number: 2, timeSkipBefore: "weeks" }] }] }, { episodeNumber: 1, sceneNumber: 2 }) === "weeks", "resolveTimeSkipBefore reads the season map defensively");
ok(requiresEstablishingBeat({ timeSkipBefore: "days" }) && !requiresEstablishingBeat({ timeSkipBefore: "none" }), "requiresEstablishingBeat is true only for a non-none skip");
// normalize coerces a bad timeSkipBefore to "none" and preserves a valid one
{
  const ep = mkEpisode({
    scenes: [
      mkScene(1, 13, { hook: "h", timeSkipBefore: "weeks" }),
      ...Array.from({ length: 5 }, (_, i) => mkScene(i + 2, 13)),
    ],
  });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  ok(norm.scenes[0].timeSkipBefore === "weeks" && norm.scenes[1].timeSkipBefore === "none", "normalize keeps a valid timeSkipBefore, defaults the rest to none");
}

/* ---------------------------------------------------------------- (i) state checklist: ≥150 words + 5 items */
ok(STATE_CHECKLIST_ITEMS.length === 5, "STATE_CHECKLIST_ITEMS has exactly 5 items");
ok(countWords(STATE_CHECKLIST_TEXT) >= STATE_CHECKLIST_MIN_WORDS, `STATE_CHECKLIST_TEXT is ≥150 words (got ${countWords(STATE_CHECKLIST_TEXT)})`);
for (const heading of ["POSITION", "EMOTION", "PROP", "LIGHT / TIME", "CAMERA"]) {
  ok(STATE_CHECKLIST_TEXT.includes(heading), `STATE_CHECKLIST_TEXT covers heading ${heading}`);
}
ok(/ALL FIVE/i.test(STATE_CHECKLIST_CRITIC_SYSTEM) && /missingItem/.test(STATE_CHECKLIST_CRITIC_SYSTEM), "critic system asks for pass + missingItem over all five items");
ok(/pass\/fail|pass.*false|true\|false/i.test(STATE_CHECKLIST_CRITIC_SYSTEM), "critic system returns a pass/fail judgement (not a word count)");
ok(stateChecklistCriticUserPrompt("").includes("(empty)"), "critic user prompt handles empty state");
ok(/missing the required checklist item "PROP state"/.test(stateChecklistRetryNote("PROP state", 4)) && /scene 4/.test(stateChecklistRetryNote("PROP state", 4)), "retry note names the missing item + scene");

/* ---------------------------------------------------------------- (i2) judgeStateChecklist is defensive */
{
  const pass = await judgeStateChecklist(state("Mara"), fakeChat({ pass: true, missingItem: "" }));
  ok(pass.pass === true && !pass.missingItem, "judgeStateChecklist returns pass when the critic passes");
  const fail = await judgeStateChecklist("no camera info here", fakeChat({ pass: false, missingItem: "CAMERA" }));
  ok(fail.pass === false && fail.missingItem === "CAMERA", "judgeStateChecklist surfaces the missing item on fail");
  const empty = await judgeStateChecklist("", fakeChat({ pass: true }));
  ok(empty.pass === false && empty.missingItem === STATE_CHECKLIST_ITEMS[0], "judgeStateChecklist fails an empty state naming the first item");
  const errFn = (async () => { throw new Error("boom"); }) as ChatJSONFn;
  const onErr = await judgeStateChecklist(state("Mara"), errFn);
  ok(onErr.pass === true, "judgeStateChecklist never blocks the job on a critic error (defaults to pass)");
}

/* ---------------------------------------------------------------- (j) scene-count / total accept + reject via validator */
{
  // a valid 6-scene, in-band episode has no HARD problems
  const ep = normalizeEpisodeScript(mkEpisode(), undefined, { manual: true });
  ok(hardProblems(validateEpisodeScript(ep, { characterNames: cast })).length === 0, "a valid 6-scene 3–15 s episode has no hard problems");
  ok(sceneCountInBounds(ep.scenes.length) && episodeDurationTotalInBounds(ep.scenes.reduce((a, s) => a + s.durationSec, 0)), "the valid episode is in the 5–8 scene and 70–100 s bands");
}
// too FEW scenes (4) → HARD problem
{
  const ep = episodeScriptSchema.parse({
    visualIdentity: "photoreal cinematic", peakSceneIndex: 2,
    scenes: Array.from({ length: 4 }, (_, i) => mkScene(i + 1, 13, i === 0 ? { hook: "conflict now" } : {})),
  });
  const norm = normalizeEpisodeScript(ep, undefined, { manual: true });
  ok(hardProblems(validateEpisodeScript(norm, { characterNames: cast })).some((p) => /scene count 4 below 5/.test(p)), "4 scenes rejected (below minimum)");
}

console.log(`\nStage 166: PASS (${passed} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
