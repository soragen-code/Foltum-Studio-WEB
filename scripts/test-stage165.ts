/**
 * Stage 165 (task Stage 6) — deterministic, block-assembled scene prompt.
 *
 * The scene video prompt is assembled from NINE ordered, individually pure block functions
 * (lib/prompts/scene.ts). This suite unit-tests every block in isolation (present vs absent inputs),
 * the camera beat-table + no-repeat logic, the DIALOGUE_FRAMING_RULE / SINGLE_SPEAKER folding, the
 * defensive SeasonState-absent fallbacks, and the deterministic assembly + per-block regeneration.
 *
 * Pure/synthetic checks only — no network, no LLM, no DB, no paid generations.
 * NOTE (deviation): the repo has no vitest wiring; per the repo convention this uses the hand-written
 * pure-assertion style of the other scripts/test-stageNN.ts files.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage165.ts
 */
import {
  PROMPT_VERSION,
  styleBlock,
  locationBlock,
  characterBlocks,
  continuityInBlock,
  actionBlock,
  dialogueBlock,
  cameraBlock,
  continuityOutBlock,
  negativeBlock,
  chooseCameraMove,
  assembleScenePrompt,
  regenerateBlock,
  CAMERA_BY_BEAT,
  SCENE_BLOCK_NAMES,
  type SceneBlockInput,
} from "../lib/prompts";
import {
  DIALOGUE_FRAMING_RULE,
  SINGLE_SPEAKER_DIRECTION,
  LOCATION_INSIDE_NOTE,
  REGION_PLATE_NOTE,
} from "../lib/scene-prompt";

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

function baseInput(): SceneBlockInput {
  return {
    style: "gritty cinematic drama, muted teal palette, shallow depth of field",
    scene: {
      id: "s1",
      sceneKind: "dialogue",
      locationDesc: "INT. courthouse corridor — late afternoon, low amber light",
      videoPrompt: "Yara confronts Theo by the marble bench.",
      action: "Yara steps in front of Theo and blocks his path.",
      dialogue: "YARA: I know what you did.\nTHEO: You have no proof.",
      dialogueEn: "YARA: I know what you did.\nTHEO: You have no proof.",
      voiceover: "",
      startState: "Yara stands tense and cold, Theo guarded near the marble bench.",
      endState: "Yara turns away, Theo left staring after her, amber light unchanged.",
      continuesFrom: null,
      beatType: "humiliation",
    },
    characters: [
      { characterId: "c1", name: "Yara", tier: "LEAD", appearance: "woman, 34, dark bob, charcoal coat", age: "34", gender: "female" },
      { characterId: "c2", name: "Theo", tier: "LEAD", appearance: "man, 40, grey suit, close beard", age: "40", gender: "male" },
      { characterId: "c3", name: "Crowd", tier: "CROWD", appearance: "background bystanders", age: null, gender: null },
    ],
    location: { id: "loc1", name: "Courthouse corridor", setInventory: "marble bench; brass railing", imageUrl: "u1", imageReverse: "u2" },
    regionPlateUrl: "plate1",
    seasonState: null,
    previous: null,
    dialogueLanguage: null,
  };
}

/* ────────────────────────────── PROMPT_VERSION ────────────────────────────── */

ok(typeof PROMPT_VERSION === "string" && PROMPT_VERSION.length > 0, "PROMPT_VERSION is a non-empty string");
ok(SCENE_BLOCK_NAMES.length === 9, "there are exactly nine ordered block names");

/* ────────────────────────────── (1) STYLE ────────────────────────────── */

ok(styleBlock(baseInput()).startsWith("STYLE: gritty cinematic"), "styleBlock emits the global style line");
ok(styleBlock({ ...baseInput(), style: null }) === "", "styleBlock is empty when no style is given");
// deterministic: same input twice → identical
ok(styleBlock(baseInput()) === styleBlock(baseInput()), "styleBlock is deterministic");

/* ────────────────────────────── (2) LOCATION ────────────────────────────── */

{
  const loc = locationBlock(baseInput());
  ok(loc.includes("LOCATION: Courthouse corridor"), "locationBlock includes the location name");
  ok(loc.includes(REGION_PLATE_NOTE), "locationBlock includes the region-plate note when a plate exists");
  ok(loc.includes(LOCATION_INSIDE_NOTE), "locationBlock adds the interior note for an INT. scene");
  ok(loc.includes("marble bench"), "locationBlock lists a matched set-inventory object used in the scene");

  const noPlate = locationBlock({ ...baseInput(), regionPlateUrl: null });
  ok(!noPlate.includes(REGION_PLATE_NOTE), "locationBlock omits the region-plate note when there is no plate");

  const bare = locationBlock({ ...baseInput(), location: null, regionPlateUrl: null,
    scene: { ...baseInput().scene, locationDesc: "EXT. open field — noon" } });
  ok(bare.includes("LOCATION: EXT. open field"), "locationBlock falls back to the scene locationDesc when no location record");
  ok(!bare.includes(LOCATION_INSIDE_NOTE), "locationBlock does not add the interior note for an EXT. scene");
}

/* ────────────────────────────── (3) CHARACTER(S) ────────────────────────────── */

{
  const chars = characterBlocks(baseInput());
  ok(chars.includes("Yara") && chars.includes("Theo"), "characterBlocks lists the present named characters");
  ok(!chars.includes("Crowd"), "characterBlocks excludes CROWD tier from the named look-lock");
  ok(/woman/i.test(chars) && /man/i.test(chars), "characterBlocks preserves the gender-lock (woman / man)");
  ok(/emotion: (cold|tense|guarded)/i.test(chars), "characterBlocks reads an emotion from the startState");

  // SeasonState wardrobe/physicalState wins when present (Stage 4).
  const withState = characterBlocks({
    ...baseInput(),
    seasonState: { characters: [{ name: "Yara", wardrobe: "torn black gown", physicalState: "bleeding lip" }], lastSceneEndState: null },
  });
  ok(withState.includes("torn black gown"), "characterBlocks uses SeasonState wardrobe when available");
  ok(withState.includes("bleeding lip"), "characterBlocks uses SeasonState physicalState when available");

  // Defensive: SeasonState absent → falls back to cast appearance, never throws.
  const noState = characterBlocks({ ...baseInput(), seasonState: null });
  ok(noState.includes("charcoal coat"), "characterBlocks falls back to the cast appearance when SeasonState is absent");

  ok(characterBlocks({ ...baseInput(), characters: [] }) === "", "characterBlocks is empty when no characters are present");
}

/* ────────────────────────────── (4) CONTINUITY IN ────────────────────────────── */

{
  const withPrev = continuityInBlock({ ...baseInput(), previous: { endState: "rain still falling on the steps", cameraMove: "steady-medium" } });
  ok(withPrev.includes("rain still falling"), "continuityInBlock asserts consistency with the previous endState");

  const firstScene = continuityInBlock({
    ...baseInput(),
    scene: { ...baseInput().scene, startState: "" },
    previous: null,
    seasonState: { characters: null, lastSceneEndState: "season anchor: dusk over the harbour" },
  });
  ok(firstScene.includes("season anchor: dusk over the harbour"),
    "continuityInBlock uses SeasonState.lastSceneEndState for the first scene when there is no startState");

  const startOnly = continuityInBlock({ ...baseInput(), previous: null, seasonState: null });
  ok(startOnly.includes("Yara stands tense"), "continuityInBlock uses the scene startState when no anchor is available");
}

/* ────────────────────────────── (5) ACTION ────────────────────────────── */

ok(actionBlock(baseInput()).includes("one continuous beat"), "actionBlock marks a single continuous beat (no montage)");
ok(actionBlock({ ...baseInput(), scene: { ...baseInput().scene, action: null } }) === "", "actionBlock is empty when no action");

/* ────────────────────────────── (6) DIALOGUE ────────────────────────────── */

{
  const dlg = dialogueBlock(baseInput());
  ok(/Open on a CLOSE-UP of Yara/i.test(dlg), "dialogueBlock opens on a close-up of the first speaker");
  ok(dlg.includes("I know what you did"), "dialogueBlock carries the spoken lines");
  ok(/introduce no new speaker/i.test(dlg), "dialogueBlock constrains speakers to the character list");

  const empty = dialogueBlock({ ...baseInput(), scene: { ...baseInput().scene, dialogue: "", dialogueEn: "" } });
  ok(empty === "", "dialogueBlock is empty for a no-dialogue scene");

  const narration = dialogueBlock({
    ...baseInput(),
    scene: { ...baseInput().scene, sceneKind: "narration", voiceover: "Years later, the town still whispered her name.", dialogue: "", dialogueEn: "" },
  });
  ok(/NARRATION/.test(narration) && /whispered her name/.test(narration), "dialogueBlock emits an off-screen narration voice-over for a narration scene");

  const foreign = dialogueBlock({ ...baseInput(), dialogueLanguage: "Ukrainian" });
  ok(/spoken in Ukrainian/i.test(foreign) && /English translation/i.test(foreign),
    "dialogueBlock notes the story language + English translation for a non-English project");
}

/* ────────────────────────────── (7) CAMERA ────────────────────────────── */

{
  // Beat table maps correctly.
  ok(CAMERA_BY_BEAT.humiliation.move === "slow-push-in" && /push-in/.test(CAMERA_BY_BEAT.humiliation.movement),
    "camera table: humiliation → slow push-in on the face");
  ok(CAMERA_BY_BEAT.reveal.move === "rack-focus", "camera table: reveal → rack focus / whip");
  ok(CAMERA_BY_BEAT.threat.move === "low-angle", "camera table: threat → low angle");

  // Legacy scene with no beatType falls back to default (no throw).
  ok(chooseCameraMove(undefined).move === CAMERA_BY_BEAT.default.move,
    "chooseCameraMove falls back to the default beat when beatType is missing");
  ok(chooseCameraMove("nonsense").move === CAMERA_BY_BEAT.default.move, "chooseCameraMove falls back to default for an unknown beatType");

  // No-repeat: when the beat's move equals the previous scene's move, a different move is chosen.
  const repeat = chooseCameraMove("humiliation", "slow-push-in");
  ok(repeat.move !== "slow-push-in", "chooseCameraMove avoids repeating the previous scene's camera move");
  // ...and when it differs it keeps the beat's natural move.
  ok(chooseCameraMove("humiliation", "low-angle").move === "slow-push-in", "chooseCameraMove keeps the beat move when it does not repeat");

  // Talking scene folds in the Stage 164 rule + single-speaker direction.
  const twoSpeaker = cameraBlock(baseInput());
  ok(twoSpeaker.includes(DIALOGUE_FRAMING_RULE), "cameraBlock folds in the Stage 164 DIALOGUE_FRAMING_RULE for a talking scene");
  ok(!twoSpeaker.includes(SINGLE_SPEAKER_DIRECTION), "cameraBlock omits SINGLE_SPEAKER_DIRECTION when two people speak");

  const oneSpeaker = cameraBlock({ ...baseInput(), scene: { ...baseInput().scene, dialogue: "YARA: I am done here.", dialogueEn: "YARA: I am done here." } });
  ok(oneSpeaker.includes(SINGLE_SPEAKER_DIRECTION), "cameraBlock adds SINGLE_SPEAKER_DIRECTION for a single speaker");

  // Action scene keeps the plain beat framing, no dialogue rule.
  const action = cameraBlock({ ...baseInput(), scene: { ...baseInput().scene, sceneKind: "action" } });
  ok(!action.includes(DIALOGUE_FRAMING_RULE), "cameraBlock does not fold the dialogue rule into an action scene");
}

/* ────────────────────────────── (8) CONTINUITY OUT ────────────────────────────── */

ok(continuityOutBlock(baseInput()).includes("Yara turns away"), "continuityOutBlock carries the endState");
ok(continuityOutBlock({ ...baseInput(), scene: { ...baseInput().scene, endState: "" } }) === "", "continuityOutBlock is empty with no endState");

/* ────────────────────────────── (9) NEGATIVE ────────────────────────────── */

{
  const neg = negativeBlock(baseInput());
  ok(/no wardrobe change/i.test(neg), "negativeBlock forbids wardrobe change");
  ok(/no new characters/i.test(neg), "negativeBlock forbids new characters");
  ok(/no change of time of day/i.test(neg), "negativeBlock forbids a time-of-day change");
  ok(/while any character is speaking/i.test(neg), "negativeBlock adds the no-wide-shot-while-speaking ban for a talking scene");

  const actionNeg = negativeBlock({ ...baseInput(), scene: { ...baseInput().scene, sceneKind: "action" } });
  ok(!/while any character is speaking/i.test(actionNeg), "negativeBlock omits the speaking framing ban for a non-talking scene");
}

/* ────────────────────────────── assemble ────────────────────────────── */

{
  const asm = assembleScenePrompt(baseInput());
  // Fixed order: STYLE before LOCATION before CHARACTERS before ... before NEGATIVE.
  const iStyle = asm.prompt.indexOf("STYLE:");
  const iLoc = asm.prompt.indexOf("LOCATION:");
  const iChar = asm.prompt.indexOf("CHARACTERS");
  const iDlg = asm.prompt.indexOf("DIALOGUE:");
  const iNeg = asm.prompt.indexOf("NEGATIVE (also forbidden)");
  ok(iStyle >= 0 && iStyle < iLoc && iLoc < iChar && iChar < iDlg && iDlg < iNeg,
    "assembleScenePrompt concatenates blocks in the fixed 1..9 order");
  ok(asm.cameraMove === "slow-push-in", "assembleScenePrompt returns the resolved camera move");
  ok(Object.keys(asm.blocks).length === 9, "assembleScenePrompt returns all nine block strings");
  ok(asm.prompt === assembleScenePrompt(baseInput()).prompt, "assembleScenePrompt is deterministic (identical inputs → identical output)");

  // Empty blocks are dropped from the joined prompt.
  const noAction = assembleScenePrompt({ ...baseInput(), scene: { ...baseInput().scene, action: null } });
  ok(!noAction.prompt.includes("ACTION ("), "assembleScenePrompt drops an empty block from the joined prompt");
  ok(noAction.blocks.action === "", "assembleScenePrompt still records the empty block in the blocks map");
}

/* ────────────────────────────── backward compat ────────────────────────────── */

{
  // Legacy scene: no beatType, no SeasonState, no gender, no voiceProfile — must still assemble, never throw.
  const legacy: SceneBlockInput = {
    scene: { id: "old", sceneKind: null, locationDesc: "a dim room", videoPrompt: "two people talk", action: "they sit",
      dialogue: "A: hi\nB: hey", dialogueEn: "", voiceover: "", startState: "", endState: "", continuesFrom: null },
    characters: [{ characterId: "x", name: "A", tier: null, appearance: "person", age: null, gender: null }],
  };
  const legacyAsm = assembleScenePrompt(legacy);
  ok(typeof legacyAsm.prompt === "string" && legacyAsm.prompt.length > 0, "assembleScenePrompt produces a valid prompt for a legacy scene (graceful fallbacks)");
  ok(legacyAsm.cameraMove === CAMERA_BY_BEAT.default.move, "legacy scene (no beatType) resolves the default camera move");
}

/* ────────────────────────────── per-block regeneration ────────────────────────────── */

{
  const input = baseInput();
  const full = assembleScenePrompt(input);
  // Stored blocks, but with a stale ACTION block that regeneration of "action" must refresh.
  const stored = { ...full.blocks, action: "ACTION (one continuous beat, no internal montage cuts within the clip): STALE placeholder" };
  const regen = regenerateBlock(input, "action", stored);
  ok(regen.blocks.action === full.blocks.action, "regenerateBlock recomputes the requested block fresh");
  ok(!regen.prompt.includes("STALE placeholder"), "regenerateBlock drops the stale stored value of the recomputed block");

  // Every OTHER block is carried over verbatim from the stored blocks (splice, not full rebuild).
  const storedCustom = { ...full.blocks, style: "STYLE: CUSTOM-EDITED STYLE LINE" };
  const regen2 = regenerateBlock(input, "action", storedCustom);
  ok(regen2.blocks.style === "STYLE: CUSTOM-EDITED STYLE LINE", "regenerateBlock carries other stored blocks over verbatim");
  ok(regen2.prompt.includes("CUSTOM-EDITED STYLE LINE"), "regenerateBlock keeps the spliced result in the assembled prompt");

  // Order preserved after a splice.
  const iStyle = regen2.prompt.indexOf("STYLE:");
  const iNeg = regen2.prompt.indexOf("NEGATIVE (also forbidden)");
  ok(iStyle >= 0 && iStyle < iNeg, "regenerateBlock preserves the fixed block order after splicing");

  // No stored blocks → best-effort full recompute (never throws).
  const regen3 = regenerateBlock(input, "camera", null);
  ok(regen3.blocks.camera.includes(DIALOGUE_FRAMING_RULE), "regenerateBlock recomputes cleanly when nothing was stored");
}

console.log(`Stage 165: PASS (${passed} checks; deterministic block-assembled scene prompts + per-block regen + PROMPT_VERSION)`);
