/**
 * Stage 41 checks — scripted START / END frame state written into every scene at script generation,
 * OPENING STATE / END STATE blocks in the Seedance prompt, auto project naming restored.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage41.ts
 */
import assert from "node:assert";
import { buildScenePrompt, resolveOpeningState, resolveEndState, OPENING_STATE_PREFIX, END_STATE_PREFIX } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";
import {
  episodeScriptSystemPrompt, sceneReviseSystemPrompt, episodeContinuityAuditSystemPrompt, episodeContinuityAuditUserPrompt,
  sceneScriptSchema, sceneReviseSchema, episodeContinuityAuditSchema, normalizeEpisodeScript, episodeScriptSchema,
  renderScriptFromScenes, renderEpisodeScriptText, START_STATE_LINE_PREFIX, END_STATE_LINE_PREFIX, START_STATE_RULE,
} from "../lib/season";
import { buildTestEpisodeRecords, normalizeTestSceneResult, testSceneSystemPrompt, testSceneResultSchema } from "../lib/test-episode";
import { deriveProjectName, resolveProjectName, isPlaceholderProjectName, PLACEHOLDER_PROJECT_NAME } from "../lib/project-name";
import { createProjectSchema } from "../lib/validations";
import { ideaResultSchema } from "../lib/idea";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const styledUrl = (name: string) => "https://media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";
const prompt9 = "[SHOT TYPE]: 0-5s wide of the kitchen / 5-15s medium two-shot\n[VISUAL STYLE]: photoreal\n[LIGHTING]: warm lamp\n[BLOCKING]: Yara at the table, Theo by the door\n[GAZE]: at each other\n[NON-VERBAL]: tense\n[ACTION]: Yara turns to Theo.\n[CHARACTER]: Yara, Theo\n[TRANSITION]: hard cut";
const start = "Yara seated at the table facing the window, Theo in the doorway, lamp on, medium shot from the sink.";
const end = "Yara stands at the window, back to the door, Theo two steps inside, lamp on, wide shot from the doorway.";
const prevEnd = "Yara seated at the table, Theo outside the open door, lamp on, medium shot from the sink.";
const actual = "Yara stands beside the table, hand on the chair back, Theo already one step inside the room, medium two-shot.";
const scene = { id: "s3", number: 3, videoPrompt: prompt9, sceneKind: null, voiceover: null, dialogue: 'YARA: "Now."', dialogueEn: 'YARA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: null, startState: start, endState: end };
const previous = { id: "s2", number: 2, locationDesc: "Kitchen", lastFrameUrl: styledUrl("s2-lastframe"), endState: prevEnd, endStateActual: null as string | null };
const cast = ["Yara", "Theo"].map(n => ({ characterId: n.toLowerCase(), name: n, tier: "MAIN", imageFront: styledUrl(n.toLowerCase()) }));
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: null, imageDetail: null };

// ── A. prompt: OPENING STATE from scene.startState, END STATE from scene.endState ─────────────────
{
  ok(resolveOpeningState(scene, previous) === start, "A: own startState beats the previous scripted endState");
  ok(resolveOpeningState(scene, { ...previous, endStateActual: actual }) === actual, "A: previous endStateActual (chain mode) overrides startState");
  ok(resolveOpeningState(scene, null) === start, "A: scene 1 opens from its own startState");
  ok(resolveOpeningState({ ...scene, continuesFrom: "location-change" }, { ...previous, endStateActual: actual }) === start, "A: on a sequence break the actual frame is ignored, own startState describes the fresh opening");
  ok(resolveOpeningState({ ...scene, startState: null }, previous) === prevEnd, "A: legacy scene without startState falls back to the previous endState");
  ok(resolveOpeningState({ ...scene, startState: "  " }, null) === null, "A: nothing available → null");
  ok(resolveEndState(scene) === end && resolveEndState({ endState: " " }) === null, "A: resolveEndState trims / nulls");

  const b = buildScenePrompt({ scene, characters: cast, location: loc, previous, provider: "seedance" });
  ok(b.openingState === start && b.endState === end, "A: result carries both states");
  ok(b.prompt.startsWith(`${OPENING_STATE_PREFIX}${start}\n${END_STATE_PREFIX}${end}\n\n[SHOT TYPE]`), "A: OPENING STATE then END STATE right before the 9-line prompt");
  const b2 = buildScenePrompt({ scene, characters: cast, location: loc, previous: { ...previous, endStateActual: actual }, provider: "seedance" });
  ok(b2.openingState === actual && b2.prompt.includes(OPENING_STATE_PREFIX + actual) && !b2.prompt.includes(start) && b2.prompt.includes(END_STATE_PREFIX + end), "A: actual last frame replaces startState, END STATE stays");
  const b3 = buildScenePrompt({ scene: { ...scene, startState: null, endState: null }, characters: cast, location: loc, previous: null, provider: "seedance" });
  ok(b3.openingState === null && b3.endState === null && !b3.prompt.includes(OPENING_STATE_PREFIX) && !b3.prompt.includes(END_STATE_PREFIX) && b3.prompt.startsWith("[SHOT TYPE]"), "A: no states → no blocks");
  const b4 = buildScenePrompt({ scene: { ...scene, startState: null }, characters: cast, location: loc, previous: null, provider: "seedance" });
  ok(b4.prompt.startsWith(END_STATE_PREFIX + end), "A: END STATE alone when there is no opening state");
  const b5 = buildScenePrompt({ scene: { ...scene, promptOverride: "MY PROMPT" }, characters: cast, location: loc, previous, provider: "seedance" });
  ok(b5.prompt === "MY PROMPT", "A: manual override stays verbatim");
}

// ── B. script writer contract: startState + endState required; rendered script lines ─────────────
{
  const base = { number: 1, shotType: "medium", durationSec: 20, locationDesc: "INT kitchen", characters: ["Yara"], action: "Yara turns.", dialogue: 'YARA: "Now."', videoPrompt: prompt9 };
  ok(!sceneScriptSchema.safeParse({ ...base, endState: end }).success, "B: sceneScriptSchema REQUIRES startState");
  ok(!sceneScriptSchema.safeParse({ ...base, startState: start }).success, "B: sceneScriptSchema REQUIRES endState");
  ok(sceneScriptSchema.safeParse({ ...base, startState: start, endState: end }).success, "B: sceneScriptSchema accepts both");
  ok(!sceneReviseSchema.safeParse({ ...base, endState: end }).success && sceneReviseSchema.safeParse({ ...base, startState: start, endState: end }).success, "B: sceneReviseSchema requires startState");
  const ep = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: Array.from({ length: 6 }, (_, i) => ({ ...base, number: i + 1, startState: ` ${start} `, endState: end })) }));
  // Stage 42 — scene 1 keeps its own trimmed startState; scenes 2..N inherit the previous endState (here === end).
  ok(ep.scenes[0].startState === start && ep.scenes.every(s => s.endState === end) && ep.scenes.slice(1).every(s => s.startState === end), "B: normalizeEpisodeScript trims + hands off startState[i]=endState[i-1]");

  const sys = episodeScriptSystemPrompt("en", 1);
  ok(sys.includes('"startState": string, "endState": string') && sys.includes("R10. START / END STATE HAND-OFF") && sys.includes("CHAIN RULE") && sys.includes(START_STATE_RULE), "B: episode script prompt asks for startState + endState with the chain rule");
  const rev = sceneReviseSystemPrompt("en");
  ok(rev.includes('"startState": string, "endState": string') && rev.includes(START_STATE_RULE), "B: scene revise prompt asks for startState + endState");
  const audit = episodeContinuityAuditSystemPrompt("en");
  ok(audit.includes('"correctedStartState"') && audit.includes('"correctedEndState"') && audit.includes("START / END STATE CHAIN"), "B: continuity audit returns correctedStartState / correctedEndState");
  const auditUser = episodeContinuityAuditUserPrompt([{ number: 1, startState: start, endState: end, videoPrompt: prompt9 }]);
  ok(auditUser.includes(`startState: ${start}`) && auditUser.includes(`endState: ${end}`), "B: audit input lists both states per scene");
  ok(episodeContinuityAuditSchema.safeParse({ scenes: [{ number: 1, hasIssue: true, issue: "x", correctedVideoPrompt: prompt9, correctedStartState: start, correctedEndState: end }] }).success, "B: audit schema accepts correctedStartState");

  const text = renderScriptFromScenes({ number: 1, title: "T" }, ["Yara"], [
    { number: 1, shotType: "medium", durationSec: 20, locationDesc: "INT", action: "x", dialogue: "y", startState: start, endState: end },
    { number: 2, shotType: "wide", durationSec: 15, locationDesc: "INT", action: "x", dialogue: "y", startState: null, endState: null },
  ]);
  ok(text.includes(`${START_STATE_LINE_PREFIX}${start}\n${END_STATE_LINE_PREFIX}${end}`) && text.split(START_STATE_LINE_PREFIX).length === 2, "B: rendered script prints «Старт кадра» above «Финал кадра», only where present");
  const full = renderEpisodeScriptText({ number: 1, title: "T", logline: "l", locationName: "K", locationDesc: "kitchen", characters: ["Yara"] } as any, ep);
  ok(full.split(START_STATE_LINE_PREFIX).length === 7 && full.split(END_STATE_LINE_PREFIX).length === 7, "B: Episode.script text carries both lines for every scene");

  // test-scene flow
  ok(!testSceneResultSchema.safeParse({ title: "Спор", locationDesc: "EXT pier", videoPrompt: prompt9, dialogue: 'A: "hi"', action: "They argue on the pier.", durationSec: 10, endState: end }).success, "B: test-scene result requires startState");
  const n = normalizeTestSceneResult({ projectTitle: "Пирс", title: "Спор", locationDesc: "EXT pier", videoPrompt: prompt9, dialogue: 'A: "hi"', action: "They argue on the pier.", durationSec: 10, startState: start, endState: end });
  ok(n.startState === start && n.endState === end, "B: normalizeTestSceneResult keeps startState");
  ok(testSceneSystemPrompt().includes('"startState": string, "endState": string'), "B: test-scene prompt asks for both states");
  const r = buildTestEpisodeRecords({ prompt: prompt9, startState: start, endState: end, language: "ru" });
  ok(r.scene.startState === start && r.scene.endState === end && r.episode.script.includes(START_STATE_LINE_PREFIX + start) && r.episode.script.includes(END_STATE_LINE_PREFIX + end), "B: test episode persists startState and renders both lines");
  ok(buildTestEpisodeRecords({ prompt: prompt9 }).scene.startState === null, "B: test episode without startState stores null");
}

// ── C. auto project naming restored ─────────────────────────────────────────────────────────────
{
  ok(isPlaceholderProjectName(PLACEHOLDER_PROJECT_NAME) && isPlaceholderProjectName("") && !isPlaceholderProjectName("Маяк"), "C: placeholder detection");
  ok(resolveProjectName("«Свет маяка»", "whatever") === "Свет маяка", "C: LLM title is cleaned and preferred");
  ok(resolveProjectName(null, "двое рыбаков спорят на пирсе о пропавшей лодке") !== PLACEHOLDER_PROJECT_NAME, "C: falls back to the plot text");
  ok(resolveProjectName(null, "") === PLACEHOLDER_PROJECT_NAME, "C: nothing → placeholder");
  ok(deriveProjectName("молодая смотрительница маяка находит дневник").split(" ").length <= 5, "C: deriveProjectName is short");
  ok(createProjectSchema.safeParse({ powerTier: "MEDIUM" }).success && createProjectSchema.safeParse({}).success, "C: POST /api/projects schema accepts no name");
  ok(createProjectSchema.safeParse({ name: "Маяк", powerTier: "HIGH" }).success, "C: an explicit name is still accepted");
  ok(ideaResultSchema.shape.title !== undefined, "C: ideaResultSchema asks for the series title again");
  ok(buildTestEpisodeRecords({ prompt: prompt9, projectTitle: "Кухонный спор" }).project.name === "Кухонный спор", "C: test episode names the project from the LLM title");
}

console.log(`\nStage 41: ${pass} checks passed.`);
