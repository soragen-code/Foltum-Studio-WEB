/**
 * Stage 157 — the rendered episode script shows the episode's LOCATION NAME per scene (not the
 * per-scene "INT/EXT — place — time" descriptor), and the action prose is a bit more detailed.
 *
 * Pure-logic unit test (no network, no DB, no paid generation). Verifies:
 *   1. renderEpisodeScriptText prints the episode locationName per scene and NOT the per-scene
 *      locationDesc descriptor; the head still shows "Локация: <name>"; action / dialogue / state
 *      lines still render.
 *   2. renderScriptFromScenes does the same from persisted Scene rows.
 *   3. Fallback: when the episode has no locationName, the per-scene locationDesc is still shown.
 *   4. The S3 generation prompt and the single-scene revise prompt now ask for a bit more detailed
 *      action ("3–4 sentences").
 */
import {
  renderEpisodeScriptText,
  renderScriptFromScenes,
  episodeScriptSystemPrompt,
  sceneReviseSystemPrompt,
  START_STATE_LINE_PREFIX,
  END_STATE_LINE_PREFIX,
} from "../lib/season";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok: ${msg}`);
}

const LOCATION_NAME = "Храм Теней";
const SCENE_DESC = "INT — some place — night"; // per-scene locationDesc descriptor — must NOT appear in the reader-facing text

const scriptedStart = "WORLD: Yara in the doorway.\nCAMERA: wide from the corner.";
const scriptedEnd = "WORLD: Yara by the altar.\nCAMERA: medium from the aisle.";

const outline = {
  number: 3,
  title: "Испытание",
  logline: "Яра входит в храм.",
  locationName: LOCATION_NAME,
  locationDesc: "A vast shadowed temple of black basalt.",
  characters: ["Yara", "Theo"],
  cliffhanger: "Дверь закрывается.",
} as any;

const script = {
  visualIdentity: "photoreal cinematic look",
  scenes: [
    {
      number: 1,
      sceneKind: "dialogue",
      shotType: "medium",
      durationSec: 12,
      locationDesc: SCENE_DESC,
      action: "Yara steps through the arch.",
      dialogue: 'YARA: "We are here."',
      startState: scriptedStart,
      endState: scriptedEnd,
    },
    {
      number: 2,
      sceneKind: "action",
      shotType: "low wide",
      durationSec: 14,
      locationDesc: SCENE_DESC,
      action: "Theo lunges forward.",
      dialogue: 'THEO: "Move!"',
      startState: scriptedStart,
      endState: scriptedEnd,
    },
  ],
} as any;

// ── 1: renderEpisodeScriptText ──────────────────────────────────────────────
{
  const text = renderEpisodeScriptText(outline, script);
  ok(text.includes(`Локация: ${LOCATION_NAME}`), "head shows «Локация: Храм Теней»");
  // The location NAME appears per scene: head line + 2 scene lines = 3 occurrences.
  ok(text.split(LOCATION_NAME).length - 1 >= 3, "location name printed per scene (head + each scene)");
  ok(!text.includes(SCENE_DESC), "per-scene locationDesc descriptor is NOT in the rendered script");
  ok(text.includes("Yara steps through the arch.") && text.includes("Theo lunges forward."), "action prose still renders");
  ok(text.includes('YARA: "We are here."') && text.includes('THEO: "Move!"'), "dialogue still renders");
  ok(text.includes(START_STATE_LINE_PREFIX) && text.includes(END_STATE_LINE_PREFIX), "start/end frame state lines still render");
  ok(text.includes("СЦЕНА 2 · ЭКШЕН"), "action-scene badge still renders");
}

// ── 2: renderScriptFromScenes ───────────────────────────────────────────────
{
  const rows = [
    { number: 1, sceneKind: "dialogue", shotType: "medium", durationSec: 12, locationDesc: SCENE_DESC, action: "Yara steps through the arch.", dialogue: 'YARA: "We are here."', startState: scriptedStart, endState: scriptedEnd },
    { number: 2, sceneKind: "action", shotType: "low wide", durationSec: 14, locationDesc: SCENE_DESC, action: "Theo lunges forward.", dialogue: 'THEO: "Move!"', startState: scriptedStart, endState: scriptedEnd },
  ];
  const text = renderScriptFromScenes({ number: 3, title: "Испытание", logline: "l", locationName: LOCATION_NAME, cliffhanger: "c" }, ["Yara", "Theo"], rows);
  ok(text.includes(`Локация: ${LOCATION_NAME}`), "renderScriptFromScenes head shows «Локация: <name>»");
  ok(text.split(LOCATION_NAME).length - 1 >= 3, "renderScriptFromScenes: location name printed per scene");
  ok(!text.includes(SCENE_DESC), "renderScriptFromScenes: per-scene locationDesc descriptor is NOT rendered");
  ok(text.includes("Yara steps through the arch.") && text.includes('THEO: "Move!"'), "renderScriptFromScenes: action + dialogue still render");
  ok(text.includes(START_STATE_LINE_PREFIX) && text.includes(END_STATE_LINE_PREFIX), "renderScriptFromScenes: state lines still render");
}

// ── 3: fallback to locationDesc when the episode has no locationName ─────────
{
  const noNameOutline = { ...outline, locationName: "" } as any;
  const text = renderEpisodeScriptText(noNameOutline, script);
  ok(text.includes(SCENE_DESC), "fallback: per-scene locationDesc is shown when locationName is empty");

  const rows = [{ number: 1, sceneKind: "dialogue", shotType: "medium", durationSec: 12, locationDesc: SCENE_DESC, action: "x", dialogue: "y" }];
  const text2 = renderScriptFromScenes({ number: 1, title: "T", locationName: "" }, ["Yara"], rows);
  ok(text2.includes(SCENE_DESC), "renderScriptFromScenes fallback: locationDesc shown when locationName empty");
}

// ── 4: prompts ask for a bit more detailed action ───────────────────────────
{
  const s3 = episodeScriptSystemPrompt("ru", 1);
  ok(s3.includes('"action" (4–6 rich sentences'), "S3 prompt asks for maximum-detail action (4–6 rich sentences)");
  ok(!s3.includes('"action" (2–3 sentences') && !s3.includes('"action" (3–4 sentences'), "S3 prompt no longer says 2–3 or 3–4 sentences");
  // Existing constraints preserved.
  ok(s3.includes("ONE continuous beat of unbroken motion that runs until the cut"), "S3 keeps the continuous-beat constraint");

  const rev = sceneReviseSystemPrompt("ru");
  ok(/"action":\s*string\s*\([^)]*3–4 sentences/.test(rev), "revise prompt asks for 3–4 sentences of action");
  ok(/a bit more detailed/.test(rev), "revise prompt asks for a bit more detailed action");
}

console.log(`Stage 157: PASS (${passed} checks; pure logic, no network, no paid generation)`);
