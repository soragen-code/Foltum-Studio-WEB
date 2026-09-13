/**
 * Stage 44 checks — MATCH CUT ON ACTION at every seam (same WORLD, new CAMERA), no mid-sentence
 * cuts, identical location text on continuous seams, six-shot location photo plan, characters
 * INSIDE the photographed location. Pure assertions, no I/O.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage44.ts
 */
import assert from "node:assert";
import {
  splitState, joinState, pickDifferentCamera, CAMERA_VARIATION, seamBreaks,
  START_STATE_RULE, END_STATE_RULE, FRAME_STATE_ASPECTS,
  normalizeEpisodeScript, episodeScriptSchema, episodeScriptSystemPrompt, sceneReviseSystemPrompt,
  SCENE_MAX_SECONDS,
} from "../lib/season";
import {
  buildScenePrompt, OPENING_STATE_PREFIX, NEW_CAMERA_ON_CUT_LINE, SPEECH_BEFORE_CUT_LINE, LOCATION_INSIDE_NOTE,
} from "../lib/scene-prompt";
import {
  VISUAL_STYLE_ID, LOCATION_SHOT_PLAN, LOCATION_EXTRA_LABELS, locationExtraLabel, locationExtraAnglePrompt, locationAnglePrompt,
} from "../lib/visual-style";
import { LOCATION_TOTAL_MIN, desiredTotalFrames, desiredExtraFrames } from "../lib/location-scale";
import { extraJobImageInputs, EXTRA_JOB_IMAGE_INPUT_CAP } from "../lib/workers/location-extra-image-job";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const styledUrl = (name: string) => "https://media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";

// ── A. splitState / joinState ────────────────────────────────────────────────────────────────────
{
  const st = splitState("WORLD: Anna stands by the window, hand halfway to the latch.\nCAMERA: Wide shot, low height, three-quarter angle.");
  ok(st.world === "Anna stands by the window, hand halfway to the latch." && st.camera === "Wide shot, low height, three-quarter angle.", "A: splitState separates WORLD and CAMERA blocks");
  const legacy = splitState("Anna stands by the window. Medium shot.");
  ok(legacy.world === "Anna stands by the window. Medium shot." && legacy.camera === "", "A: unlabelled legacy state → all WORLD, empty camera");
  ok(splitState("").world === "" && splitState(null).camera === "", "A: empty / null → empty blocks");
  const lower = splitState("world: a\ncamera: b");
  ok(lower.world === "a" && lower.camera === "b", "A: labels are case-insensitive");
  ok(joinState("w", "c") === "WORLD: w\nCAMERA: c" && joinState("w", "") === "WORLD: w", "A: joinState reassembles labelled text");
  ok(seamBreaks("location-change") && seamBreaks("New-Sequence") && !seamBreaks("same-location-continuation") && !seamBreaks(null), "A: seamBreaks mirrors SEQUENCE_BREAK_LINKS");
}

// ── B. CAMERA_VARIATION / pickDifferentCamera ────────────────────────────────────────────────────
{
  ok(CAMERA_VARIATION.length >= 4 && new Set(CAMERA_VARIATION.map((v) => v.text)).size === CAMERA_VARIATION.length, "B: camera variation table has ≥4 distinct setups");
  for (let i = 0; i < CAMERA_VARIATION.length; i++) for (let j = i + 1; j < CAMERA_VARIATION.length; j++) {
    const a = CAMERA_VARIATION[i], b = CAMERA_VARIATION[j];
    const diff = (a.scale !== b.scale ? 1 : 0) + (a.height !== b.height ? 1 : 0) + (a.angle !== b.angle ? 1 : 0);
    assert(diff >= 2, `B: variation ${i} vs ${j} differ in ≥2 params`);
  }
  ok(true, "B: every pair of variations differs in ≥2 of scale / height / angle");
  const prev = CAMERA_VARIATION[0].text;
  const picked = pickDifferentCamera(prev, 0);
  ok(picked !== prev, "B: pickDifferentCamera never returns the same setup as the previous camera");
  ok(pickDifferentCamera("Medium shot, eye-level, frontal", 3) === pickDifferentCamera("Medium shot, eye-level, frontal", 3), "B: pickDifferentCamera is deterministic");
}

// ── C. normalizeEpisodeScript: WORLD copied, CAMERA differs, location inherited, duration floor ───
const talk = 'ANNA (quietly): "You knew he was not coming back and you still sent the boat out there? I waited on the pier until morning."\nMARK (not looking): "I sent the boat because otherwise we would have lost both of them, and you know it."';
const prompt = "[SHOT TYPE]: 0-6s wide → 6-14s medium two-shot → 14-22s over-the-shoulder\n[VISUAL STYLE]: photoreal\n[LIGHTING]: warm lamp\n[BLOCKING]: Anna at the table, Mark by the door\n[GAZE]: at each other\n[NON-VERBAL]: tense\n[ACTION]: Anna turns to Mark.\n[CHARACTER]: Anna, Mark\n[TRANSITION]: hard cut";
const CAM_A = "Wide shot from a LOW camera height, three-quarter angle across the room.";
const CAM_B = "Medium shot from a HIGH camera height, profile to the characters.";
const mk = (n: number, opts: { continuesFrom?: (string | undefined)[]; startCamera?: (string | undefined)[]; locationDesc?: string[] } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    shotType: "Medium shot",
    durationSec: 15,
    locationDesc: opts.locationDesc?.[i] ?? "INT — Office — day",
    characters: ["Anna", "Mark"],
    action: "Anna and Mark talk.",
    dialogue: talk,
    videoPrompt: prompt,
    continuesFrom: opts.continuesFrom?.[i],
    startState: `WORLD: START-WORLD-${i + 1} Anna mid-step toward the door.\nCAMERA: ${opts.startCamera?.[i] ?? CAM_B}`,
    endState: `WORLD: END-WORLD-${i + 1} Anna mid-step toward the door, Mark rising from the chair.\nCAMERA: ${CAM_A}`,
  }));
{
  const ep = normalizeEpisodeScript(episodeScriptSchema.parse({
    visualIdentity: "photoreal cinematic",
    scenes: mk(6, { continuesFrom: [undefined, undefined, undefined, "location-change", undefined, undefined], startCamera: [CAM_B, CAM_A, CAM_B, CAM_B, undefined, CAM_B], locationDesc: ["INT — Office — day", "INT — Office — day (corner)", "INT — Office — day", "EXT — Yard — day", "EXT — Yard — day", "EXT — Yard — day (gate)"] }),
  }));
  const s = ep.scenes;
  ok(s[0].startState.includes("START-WORLD-1") && s[0].continuesFrom === "new-sequence", "C: scene 1 keeps its own startState");
  // scene 2: LLM camera equals prev end camera → deterministic different camera
  const s2 = splitState(s[1].startState);
  ok(s2.world === splitState(s[0].endState).world, "C: scene 2 WORLD === scene 1 endState WORLD");
  ok(s2.camera !== CAM_A && s2.camera.length > 0 && CAMERA_VARIATION.some((v) => v.text === s2.camera), "C: scene 2 camera repeated the previous framing → replaced by a CAMERA_VARIATION setup");
  // scene 3: LLM camera differs → kept
  const s3 = splitState(s[2].startState);
  ok(s3.world === splitState(s[1].endState).world && s3.camera === CAM_B, "C: scene 3 keeps the LLM's own (different) camera, WORLD copied");
  ok(s[1].locationDesc === s[0].locationDesc && s[2].locationDesc === s[0].locationDesc, "C: locationDesc inherited verbatim on continuous seams");
  // scene 4: location-change keeps everything of its own
  ok(s[3].startState.includes("START-WORLD-4") && s[3].locationDesc === "EXT — Yard — day", "C: location-change scene keeps its own WORLD, camera and locationDesc");
  // scene 5: empty LLM camera while previous has one → deterministic camera
  const s5 = splitState(s[4].startState);
  ok(s5.world === splitState(s[3].endState).world && s5.camera !== "" && s5.camera !== CAM_A, "C: missing opening camera → deterministic different camera");
  ok(s[4].locationDesc === "EXT — Yard — day" && s[5].locationDesc === "EXT — Yard — day", "C: location inherited after the location-change too");
  ok(s.every((sc) => /^WORLD: /.test(sc.startState)), "C: every startState is reassembled as labelled WORLD/CAMERA text");
  // duration floor: words / 2.1 + 2
  const words = talk.split(/\n/).map((l) => l.replace(/^[^:]+:\s*/, "").replace(/"/g, "")).join(" ").split(/\s+/).filter(Boolean).length;
  ok(s.every((sc) => sc.durationSec >= Math.min(SCENE_MAX_SECONDS, Math.ceil(words / 2.1) + 2)), "C: durationSec ≥ ceil(words/2.1)+2 for talking scenes (speech finishes before the cut)");
  ok(s.every((sc) => sc.durationSec <= SCENE_MAX_SECONDS), "C: durationSec clamped to SCENE_MAX_SECONDS");
}

// ── D. rule / prompt wording ─────────────────────────────────────────────────────────────────────
{
  for (const [n, r] of [["START", START_STATE_RULE], ["END", END_STATE_RULE]] as const) {
    ok(!/frozen still|no motion/i.test(r) && /continuing motion/i.test(r), `D: ${n}_STATE_RULE has no frozen-still wording, poses are an instant of continuing motion`);
    ok(/WORLD/.test(r) && /CAMERA/.test(r) && /at least TWO of the three/i.test(r) && /never repeat the previous framing/i.test(r), `D: ${n}_STATE_RULE: same WORLD, camera differs in ≥2 of 3`);
    ok(/mid-word or mid-sentence/i.test(r) && /never split across two scenes/i.test(r) && !/~1 second before the cut/i.test(r), `D: ${n}_STATE_RULE carries the speech rule (Stage 78: a line may end on the cut, no silent beat)`);
    ok(/AT LEAST 300 words/.test(r), `D: ${n}_STATE_RULE carries the (Stage 45 doubled) ≥300 words requirement`);
  }
  ok(/architecture, materials, surfaces/i.test(FRAME_STATE_ASPECTS), "D: WORLD block demands a detailed location description");
  const sys = episodeScriptSystemPrompt("en", 1);
  ok(/MATCH CUT ON ACTION/.test(sys) && /Repeating the previous framing is an error/.test(sys), "D: R10 rewritten to same-WORLD / new-CAMERA semantics");
  ok(!/equals the previous scene's endState exactly/.test(sys) && /startState WORLD equals the previous scene's endState WORLD/.test(sys) && /never split across two scenes; characters never fall silent or freeze before the cut/.test(sys), "D: final checklist: WORLD equal, CAMERA differs, no split lines (Stage 78 wording)");
  ok(/flat backdrop with figures in front of it is an ERROR/.test(sys) && /DIFFERENT from the previous scene's final camera/.test(sys), "D: [SHOT TYPE]/[BLOCKING]: characters inside the space, opening scale differs from previous end");
  const revise = sceneReviseSystemPrompt("en");
  ok(/WORLD block must still equal the PREVIOUS shot's endState WORLD/.test(revise) && /CAMERA block is a DIFFERENT setup/.test(revise), "D: scene-revise prompt uses WORLD-same / CAMERA-different semantics");
  ok(/NEW camera/.test(OPENING_STATE_PREFIX) && /different angle, shot scale and height/.test(OPENING_STATE_PREFIX) && !/continue exactly from here/.test(OPENING_STATE_PREFIX), "D: OPENING_STATE_PREFIX asks for a new camera on the same instant");
}

// ── E. buildScenePrompt: directive lines ─────────────────────────────────────────────────────────
{
  const cast = ["Anna", "Mark"].map((n) => ({ characterId: n.toLowerCase(), name: n, tier: "MAIN", imageFront: styledUrl(n.toLowerCase()) }));
  const extras = [styledUrl("k-x0"), styledUrl("k-x1"), styledUrl("k-x2")];
  const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-rev"), imageDetail: styledUrl("k-det"), imageExtra: JSON.stringify(extras) };
  const start = "WORLD: Anna mid-step toward the door, Mark rising from the chair.\nCAMERA: Medium shot from a HIGH camera height, profile.";
  const end = "WORLD: Anna at the door, hand on the handle, mouth closed.\nCAMERA: Wide shot, low, three-quarter.";
  const scene1 = { id: "s1", number: 1, videoPrompt: prompt, sceneKind: null, voiceover: null, dialogue: 'ANNA: "Now."', dialogueEn: 'ANNA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: "new-sequence", startState: start, endState: end };
  const scene2 = { ...scene1, id: "s2", number: 2, continuesFrom: "same-location-continuation" };
  const previous = { id: "s1", number: 1, locationDesc: "Kitchen", lastFrameUrl: styledUrl("s1-last"), endState: end, endStateActual: null as string | null };
  const b1 = buildScenePrompt({ scene: scene1, characters: cast, location: loc, previous: null, provider: "seedance" });
  const b2 = buildScenePrompt({ scene: scene2, characters: cast, location: loc, previous, provider: "seedance" });
  ok(!b1.prompt.includes(NEW_CAMERA_ON_CUT_LINE), "E: scene 1 has no NEW CAMERA ON THE CUT line");
  ok(b2.prompt.includes(NEW_CAMERA_ON_CUT_LINE) && b2.prompt.includes("Anna mid-step toward the door"), "E: scene 2 (continuous) carries NEW CAMERA ON THE CUT + the WORLD text");
  ok(b2.prompt.indexOf(OPENING_STATE_PREFIX) < b2.prompt.indexOf(NEW_CAMERA_ON_CUT_LINE) && b2.prompt.indexOf(NEW_CAMERA_ON_CUT_LINE) < b2.prompt.indexOf("[SHOT TYPE]"), "E: directive sits right after OPENING STATE, before the 9-line prompt");
  ok(b1.prompt.includes(SPEECH_BEFORE_CUT_LINE) && b2.prompt.includes(SPEECH_BEFORE_CUT_LINE) && /mid-word or mid-sentence/.test(SPEECH_BEFORE_CUT_LINE), "E: every scene carries the speech-before-cut line");
  const b3 = buildScenePrompt({ scene: { ...scene2, continuesFrom: "location-change" }, characters: cast, location: loc, previous, provider: "seedance" });
  ok(!b3.prompt.includes(NEW_CAMERA_ON_CUT_LINE), "E: location-change scene has no NEW CAMERA line");
  // Stage 62 (Variant A) — on a same-location continuation seam the previous scene's last frame IS sent
  // as a continuity reference; on the location-change seam (b3) it is not.
  ok(b2.referenceImages.includes(previous.lastFrameUrl), "E: previous scene's last frame is sent as a reference on the continuation seam (Stage 62)");
  ok(!b3.referenceImages.includes(previous.lastFrameUrl), "E: previous scene's last frame is NOT sent on the location-change seam");
  // location refs include the extras + INSIDE note
  ok(extras.every((u) => b2.referenceImages.includes(u)) && b2.referenceImages.includes(loc.imageUrl), "E: extra location angles are sent as references alongside the base angles");
  ok(b2.prompt.includes(LOCATION_INSIDE_NOTE) && /INSIDE this space/.test(LOCATION_INSIDE_NOTE) && /never as figures placed in front of a picture of the place/.test(LOCATION_INSIDE_NOTE), "E: prompt carries the 'characters INSIDE this space' note");
  ok(b2.prompt.includes(`— ${locationExtraLabel(0)} angle`), "E: extra reference notes name the plan slot");
}

// ── F. six-shot location plan ────────────────────────────────────────────────────────────────────
{
  ok(LOCATION_SHOT_PLAN.length === 6 && LOCATION_EXTRA_LABELS.length === 6, "F: fixed six-slot extra plan");
  ok(new Set(LOCATION_SHOT_PLAN.map((p) => p.prompt)).size === 6 && new Set(LOCATION_EXTRA_LABELS).size === 6, "F: all six slots and labels are unique");
  const texts = LOCATION_SHOT_PLAN.map((p) => p.prompt.toLowerCase());
  ok(/high|bird/.test(texts[0]) && /whole/.test(texts[0]), "F: slot 0 — high bird's-eye over the whole space");
  ok(/low/.test(texts[1]) && /far|opposite/.test(texts[1]), "F: slot 1 — low angle from the far / opposite edge");
  ok(/separate zone|corner/.test(texts[2]) && /90/.test(texts[2]), "F: slot 2 — separate zone from the 90° side");
  ok(/threshold|doorway/.test(texts[3]) && /entrance/.test(texts[3]), "F: slot 3 — threshold view from the entrance");
  ok(/length/.test(texts[4]) && /end/.test(texts[4]), "F: slot 4 — long shot down the length");
  ok(/light source|window/.test(texts[5]) && /toward/.test(texts[5]), "F: slot 5 — toward the light source");
  ok(LOCATION_EXTRA_LABELS.join("|") === "Сверху|С дальнего края|Другая зона|От входа|Вдоль пространства|К источнику света" && locationExtraLabel(7) === "С дальнего края", "F: Russian labels in plan order, wrapping index");
  for (let i = 0; i < 6; i++) {
    const p = locationExtraAnglePrompt("a wooden cabin interior", "Cabin", i);
    assert(/The reference image IS this location, already photographed/.test(p) && /do not invent new architecture, materials or layout/.test(p) && /no people/.test(p) && /Lighting is FIXED/.test(p), `F: extra prompt ${i} anchors to the photographed place`);
  }
  ok(true, "F: every extra prompt anchors to the photographed reference image (LIGHT_LOCK + no people kept)");
  ok(/IS this location, already photographed/.test(locationAnglePrompt("cabin", "Cabin", "reverse")) && /medium shot 45° from the side, the action zone/.test(locationAnglePrompt("cabin", "Cabin", "detail")), "F: reverse / detail base prompts use the same anchor and wording");
  ok(LOCATION_TOTAL_MIN === 4 && desiredTotalFrames({ name: "Кабинет", detailLevel: "low" }) === 4 && desiredTotalFrames({ name: "Кабинет", detailLevel: "medium" }) === 6 && desiredExtraFrames({ name: "Кабинет", detailLevel: "medium" }) === 3 && desiredTotalFrames({ name: "Ночной город", detailLevel: "high" }) === 9, "F: LOCATION_TOTAL_MIN = 4; detail low/medium/high → 4/6/9 (not size)");
}

// ── G. extra plate job always attaches the photographs, master first ─────────────────────────────
{
  const loc = { imageUrl: styledUrl("m"), imageReverse: styledUrl("r"), imageDetail: styledUrl("d") };
  const none = extraJobImageInputs(loc, []);
  ok(none[0] === loc.imageUrl && none.length === 3, "G: no extras yet → master + reverse + detail, master first");
  const some = extraJobImageInputs(loc, [styledUrl("x0"), styledUrl("x1")]);
  ok(some[0] === loc.imageUrl && some.includes(styledUrl("x1")) && some.length === 5, "G: existing extras appended after the base angles");
  const many = extraJobImageInputs(loc, Array.from({ length: 10 }, (_, i) => styledUrl("x" + i)));
  ok(many.length === EXTRA_JOB_IMAGE_INPUT_CAP && many[0] === loc.imageUrl, "G: capped, master always first");
  ok(extraJobImageInputs({ imageUrl: loc.imageUrl, imageReverse: null, imageDetail: loc.imageUrl }, []).length === 1, "G: duplicates / nulls removed; never empty when the master exists");
  for (let i = 0; i < 8; i++) assert(extraJobImageInputs(loc, []).length > 0, "G: image_input never empty for any slot");
  ok(true, "G: image_input is attached for EVERY extra slot (no more every-3rd rule)");
}

console.log(`\nStage 44: all ${pass} checks passed`);
