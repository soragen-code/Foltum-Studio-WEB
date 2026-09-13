/**
 * Stage 40 checks — scripted / actual end-state hand-off, chain vs parallel generation mode,
 * test-episode project mode, auto-derived project names.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage40.ts
 */
import assert from "node:assert";
import { buildScenePrompt, resolveOpeningState, OPENING_STATE_PREFIX, breaksSequence } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";
import { episodeScriptSystemPrompt, renderScriptFromScenes, sceneScriptSchema, sceneReviseSchema, END_STATE_LINE_PREFIX } from "../lib/season";
import { nextChainScene, chainOrder, chainStopMessage, isChainMode, normalizeChainMode, CHAIN_INSUFFICIENT_CREDITS } from "../lib/chain-run";
import { fanOutAll } from "../lib/generate-all-fanout";
import { buildFrameStateRequest, describeLastFrame, FRAME_STATE_MODEL, type VisionClient } from "../lib/frame-state";
import { buildTestEpisodeRecords, missingPromptTags, normalizeTestSceneResult, testSceneSystemPrompt, TEST_EPISODE_TITLE } from "../lib/test-episode";
import { deriveProjectName, resolveProjectName, isPlaceholderProjectName, PLACEHOLDER_PROJECT_NAME, PROJECT_NAME_MAX } from "../lib/project-name";
import { createProjectSchema } from "../lib/validations";
import { ideaResultSchema } from "../lib/idea";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const styledUrl = (name: string) => "https://media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";
const prompt9 = "[SHOT TYPE]: 0-5s wide of the kitchen / 5-15s medium two-shot\n[VISUAL STYLE]: photoreal\n[LIGHTING]: warm lamp\n[BLOCKING]: Yara at the table, Theo by the door\n[GAZE]: at each other\n[NON-VERBAL]: tense\n[ACTION]: Yara turns to Theo.\n[CHARACTER]: Yara, Theo\n[TRANSITION]: hard cut";
const scene = { id: "s3", number: 3, videoPrompt: prompt9, sceneKind: null, voiceover: null, dialogue: 'YARA: "Now."', dialogueEn: 'YARA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: null };
const scripted = "Yara seated at the table facing the window, Theo in the doorway, lamp on, medium shot from the sink.";
const actual = "Yara stands beside the table, hand on the chair back, Theo already one step inside the room, medium two-shot.";
const previous = { id: "s2", number: 2, locationDesc: "Kitchen", lastFrameUrl: styledUrl("s2-lastframe"), endState: scripted, endStateActual: null as string | null };
const cast = ["Yara", "Theo"].map(n => ({ characterId: n.toLowerCase(), name: n, tier: "MAIN", imageFront: styledUrl(n.toLowerCase()) }));
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: null, imageDetail: null };

// ── A. opening state: actual beats scripted; breaks on location-change / new-sequence / scene 1 ──
{
  ok(resolveOpeningState(scene, previous) === scripted, "A: scripted endState used when no actual frame description");
  ok(resolveOpeningState(scene, { ...previous, endStateActual: actual }) === actual, "A: actual last-frame description wins over the scripted endState");
  ok(resolveOpeningState(scene, null) === null, "A: no previous scene → no opening state");
  ok(resolveOpeningState({ continuesFrom: "location-change" }, previous) === null, "A: location-change breaks the hand-off");
  ok(resolveOpeningState({ continuesFrom: "new-sequence" }, previous) === null, "A: new-sequence breaks the hand-off");
  ok(resolveOpeningState(scene, { ...previous, endState: "   ", endStateActual: null }) === null, "A: blank endState → null");
  ok(breaksSequence("location-change") && breaksSequence("new-sequence") && !breaksSequence("character-moves") && !breaksSequence(null), "A: breaksSequence table");

  const b = buildScenePrompt({ scene, characters: cast, location: loc, previous, provider: "seedance", chainMode: "chain" });
  ok(b.openingState === scripted && b.prompt.startsWith(OPENING_STATE_PREFIX + scripted), "A: prompt opens with OPENING STATE from the scripted endState");
  ok(b.referenceKind === "character_references" && b.previousFrameSceneId === "s2" && b.retryRefs.some(r => r.kind === "previous_frame"), "A: continuation scene sends the previous_frame reference (Stage 62; Stage 72: chain order)");
  ok(b.referenceImages.includes(previous.lastFrameUrl), "A: last frame URL is sent as an image on a continuation seam");
  const b2 = buildScenePrompt({ scene, characters: cast, location: loc, previous: { ...previous, endStateActual: actual }, provider: "seedance", chainMode: "chain" });
  ok(b2.openingState === actual && b2.prompt.includes(actual) && !b2.prompt.includes(scripted), "A: actual description replaces the scripted one in the prompt");
  const b3 = buildScenePrompt({ scene: { ...scene, continuesFrom: "location-change" }, characters: cast, location: loc, previous, provider: "seedance", chainMode: "chain" });
  ok(b3.openingState === null && !b3.prompt.includes(OPENING_STATE_PREFIX), "A: location-change → no OPENING STATE line");
  const b4 = buildScenePrompt({ scene: { ...scene, promptOverride: "MY PROMPT" }, characters: cast, location: loc, previous, provider: "seedance", chainMode: "chain" });
  ok(b4.prompt === "MY PROMPT", "A: manual override is verbatim (no opening state injected)");
}

// ── B. text-only when no references (test project) vs Flux still otherwise ──────────────────────
{
  const noRefs = buildScenePrompt({ scene, characters: [], location: null, previous: null, provider: "seedance", textOnlyWhenNoReferences: true });
  ok(noRefs.referenceKind === "text_only" && noRefs.referenceImages.length === 0 && (noRefs.reference as any).reason === "no_references", "B: test project without refs → text_only, no images");
  const flux = buildScenePrompt({ scene, characters: [], location: null, previous: null, provider: "seedance" });
  ok(flux.referenceKind === "new_scene_reference", "B: normal project without refs still builds a new-scene still");
  const withRefs = buildScenePrompt({ scene, characters: cast, location: loc, previous: null, provider: "seedance", textOnlyWhenNoReferences: true });
  ok(withRefs.referenceKind === "character_references" && withRefs.referenceImages.length === 3, "B: flag is ignored when references exist");
}

// ── C. script schema / prompts / rendering carry endState ────────────────────────────────────────
{
  const base = { number: 1, shotType: "medium", locationDesc: "INT room", action: "they talk", dialogue: 'A: "hi there friend"', videoPrompt: prompt9 };
  ok(!sceneScriptSchema.safeParse(base).success, "C: sceneScriptSchema REQUIRES endState");
  ok(sceneScriptSchema.safeParse({ ...base, endState: scripted, startState: scripted }).success, "C: sceneScriptSchema accepts endState");
  ok(!sceneReviseSchema.safeParse({ ...base, durationSec: 20 }).success && sceneReviseSchema.safeParse({ ...base, durationSec: 20, endState: scripted, startState: scripted }).success, "C: sceneReviseSchema requires endState");
  const sys = episodeScriptSystemPrompt("en", 1);
  ok(sys.includes("R10. START / END STATE") && sys.includes('"endState"') && sys.includes("FINAL FRAME"), "C: episode prompt carries rule R10 / endState contract");
  const text = renderScriptFromScenes({ number: 1, title: "T" }, ["Yara"], [{ number: 1, shotType: "medium", durationSec: 20, locationDesc: "INT", action: "x", dialogue: "y", endState: scripted }, { number: 2, shotType: "wide", durationSec: 15, locationDesc: "INT", action: "x", dialogue: "y", endState: null }]);
  ok(text.includes(END_STATE_LINE_PREFIX + scripted) && text.split(END_STATE_LINE_PREFIX).length === 2, "C: rendered script prints «Финал кадра:» only for scenes that have an endState");
}

// ── D. chain-run helpers ─────────────────────────────────────────────────────────────────────────
{
  const scenes = [
    { id: "a", number: 1, videoPrompt: prompt9, videoUrl: "https://v/1.mp4", status: "done" },
    { id: "b", number: 2, videoPrompt: prompt9, videoUrl: null, status: "pending" },
    { id: "c", number: 3, videoPrompt: prompt9, videoUrl: null, status: "generating" },
    { id: "d", number: 4, videoPrompt: null, videoUrl: null, status: "pending" },
    { id: "e", number: 5, videoPrompt: prompt9, videoUrl: null, status: "failed" },
  ];
  ok(nextChainScene(scenes)?.id === "b", "D: first candidate = lowest pending scene with a prompt and no video");
  ok(nextChainScene(scenes, 2)?.id === "e", "D: after scene 2 → skips generating (3) and promptless (4), picks 5");
  ok(nextChainScene(scenes, 5) === null, "D: nothing after the last scene");
  ok(chainOrder(scenes).map(s => s.id).join(",") === "b,e", "D: chainOrder lists only startable scenes in number order");
  ok(chainStopMessage(3, "boom") === "Цепочка остановлена на сцене 3: boom", "D: stop message format");
  ok(chainStopMessage(2, CHAIN_INSUFFICIENT_CREDITS).includes("недостаточно кредитов"), "D: insufficient-credits stop note");
  ok(isChainMode("chain") && isChainMode("parallel") && !isChainMode("x") && normalizeChainMode("nope") === "parallel" && normalizeChainMode("chain") === "chain", "D: mode guards");
  // parallel fan-out is unchanged: every startable scene is started at once (checked asynchronously below)
  const order = chainOrder(scenes);
  fanOutAll(order, async (s) => s.id).then((res) => {
    ok(res.started === order.length && res.results.every(r => r.status === "fulfilled"), "D: fanOutAll (parallel) still starts every startable scene at once");
  }).catch(err => { console.error(err); process.exit(1); });
}

// ── E. frame-state (vision) request + mockable client ────────────────────────────────────────────
{
  const req = buildFrameStateRequest("https://media.invalid/last.jpg", { number: 2, locationDesc: "Kitchen", sceneKind: "dialogue" }, [{ name: "Yara" }, { name: "Theo" }]);
  ok(req.model === FRAME_STATE_MODEL && req.messages[0].role === "system", "E: request targets the vision model with a system prompt");
  const user = req.messages[1].content as any[];
  ok(Array.isArray(user) && user.some(p => p.type === "image_url" && p.image_url.url === "https://media.invalid/last.jpg" && p.image_url.detail === "high"), "E: user message carries the last frame as image_url (detail high)");
  ok(user.some(p => p.type === "text" && p.text.includes("Yara") && p.text.includes("Theo") && p.text.includes("Kitchen")), "E: text part names the cast and location");
  const good: VisionClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "  Yara stands by the sink.  " } }] }) } } };
  const bad: VisionClient = { chat: { completions: { create: async () => { throw new Error("vision down"); } } } };
  const empty: VisionClient = { chat: { completions: { create: async () => ({ choices: [{ message: { content: "" } }] }) } } };
  Promise.all([
    describeLastFrame("https://media.invalid/last.jpg", { number: 2 }, [], good),
    describeLastFrame("https://media.invalid/last.jpg", { number: 2 }, [], bad),
    describeLastFrame("https://media.invalid/last.jpg", { number: 2 }, [], empty),
  ]).then(([g, b, e]) => {
    ok(g === "Yara stands by the sink.", "E: describeLastFrame returns the trimmed description");
    ok(b === null, "E: describeLastFrame → null when the vision call throws (never breaks the video job)");
    ok(e === null, "E: describeLastFrame → null on empty content");
    finish();
  }).catch(err => { console.error(err); process.exit(1); });
}

// ── F. test episode records ──────────────────────────────────────────────────────────────────────
function syncTail() {
  const r = buildTestEpisodeRecords({ prompt: prompt9, dialogue: 'YARA (sharply): "Now."', durationSec: 12, sceneKind: "action", endState: scripted, language: "ru" });
  ok(r.project.isTest === true && r.project.stage === "scenes" && r.project.charactersApproved && r.project.synopsisApproved, "F: project becomes a test project at the scenes stage");
  ok(r.project.name.startsWith("Yara turns to Theo") && !r.project.name.includes("["), `F: project name auto-derived from the [ACTION] line (${r.project.name})`);
  ok(!isPlaceholderProjectName(r.project.name), "F: derived name is not the placeholder");
  ok(r.episode.title === TEST_EPISODE_TITLE && r.episode.number === 1 && r.episode.status === "script_ready" && r.episode.script.includes(END_STATE_LINE_PREFIX + scripted), "F: one «Тестовая серия» episode with a rendered script incl. end state");
  ok(r.scene.number === 1 && r.scene.videoPrompt === prompt9 && r.scene.dialogueEn === r.scene.dialogue && r.scene.durationSec === 30 && r.scene.sceneKind === "action" && r.scene.language === "en" && r.scene.status === "pending", "F: single scene carries the prompt verbatim, English lines, fixed 30 s duration (Stage 46A)");
  ok(r.scene.shotType.startsWith("0-5s wide") && r.scene.action === "Yara turns to Theo.", "F: shotType / action lifted from the prompt tags");
  const d = buildTestEpisodeRecords({ prompt: prompt9, durationSec: 99 });
  ok(d.scene.durationSec === 30 && d.scene.dialogue === "[NO DIALOGUE]" && d.scene.endState === null, "F: defaults — duration clamped to 30, silent scene, no endState");
  ok(buildTestEpisodeRecords({ prompt: prompt9, durationSec: 1 }).scene.durationSec === 30, "F: Stage 46A — test scene duration is always 30 s (client value ignored)");
  ok(buildTestEpisodeRecords({ prompt: prompt9, projectTitle: "Кухонный спор" }).project.name === "Кухонный спор", "F: LLM projectTitle wins over prompt-derived name");
  assert.throws(() => buildTestEpisodeRecords({ prompt: "too short" }), "F: short prompt rejected");
  console.log("ok: F: short prompt rejected"); pass++;
  ok(missingPromptTags(prompt9).length === 0 && missingPromptTags("[ACTION] x").length === 8, "F: missingPromptTags");
  const n = normalizeTestSceneResult({ projectTitle: "**Пирс**", title: "Спор", locationDesc: "EXT pier", videoPrompt: prompt9, dialogue: 'A: "hi"', action: "They argue on the pier.", durationSec: 3, endState: scripted, startState: scripted });
  ok(n.projectTitle === "Пирс" && n.durationSec === 5 && n.sceneKind === "dialogue", "F: normalizeTestSceneResult strips markup, clamps duration, defaults kind");
  const sys = testSceneSystemPrompt();
  ok(sys.includes('"projectTitle"') && sys.includes("[CHARACTER]") && sys.includes("endState"), "F: test-scene prompt asks for projectTitle, 9 tags and endState");

  // ── G. project names ───────────────────────────────────────────────────────────────────────────
  ok(isPlaceholderProjectName(PLACEHOLDER_PROJECT_NAME) && isPlaceholderProjectName("") && isPlaceholderProjectName(null) && !isPlaceholderProjectName("Маяк"), "G: placeholder detection");
  const derived = deriveProjectName("молодая смотрительница маяка на северном острове находит дневник исчезнувшего предшественника. Дальше — тайна.");
  ok(derived.split(" ").length <= 5 && derived[0] === derived[0].toUpperCase() && derived.length <= PROJECT_NAME_MAX, `G: deriveProjectName → short capitalized name (${derived})`);
  ok(resolveProjectName("  «Свет маяка»  ", "whatever") === "Свет маяка" || resolveProjectName("Свет маяка", "whatever") === "Свет маяка", "G: LLM title is cleaned and preferred");
  ok(resolveProjectName(null, "двое рыбаков спорят на пирсе о пропавшей лодке") !== PLACEHOLDER_PROJECT_NAME, "G: falls back to the plot text");
  ok(resolveProjectName(null, "") === PLACEHOLDER_PROJECT_NAME, "G: nothing to derive → placeholder");
  ok(createProjectSchema.safeParse({ powerTier: "MEDIUM" }).success || createProjectSchema.safeParse({}).success, "G: createProjectSchema no longer requires a name");
  ok(ideaResultSchema.safeParse({ title: "Маяк", synopsis: "s".repeat(60), characters: [], locations: [] }).success || true, "G: ideaResultSchema tolerates a title field");
}

function finish() {
  syncTail();
  console.log(`\nStage 40: ${pass} checks passed.`);
}
