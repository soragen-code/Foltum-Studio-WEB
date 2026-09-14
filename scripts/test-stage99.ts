/**
 * Stage 99 — per-scene "Scene Script" viewer.
 *
 * The screenplay text is assembled by a pure, DB-free helper (lib/scene-script.ts), so it is
 * unit-tested directly. Core requirement: each scene's script OPENS exactly where the previous scene
 * ENDED — for a continuous seam the opening block IS the previous scene's ending; scene 1 / a
 * sequence break open on the scene's own startState and do NOT claim to continue a previous scene.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { assembleSceneScript, isContinuousSeam, previousEndingText } from "../lib/scene-script";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const root = process.cwd();
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// Unique sentinels so we can prove exactly which text landed in the opening block.
const PREV_END = "PREV_ENDING_SENTINEL: Anna frozen mid-step at the workbench, hammer raised, lamp glaring from the left.";
const PREV_END_ACTUAL = "PREV_ACTUAL_SENTINEL: Anna caught mid-swing, sparks still in the air, warm rim-light behind her.";
const OWN_START = "OWN_START_SENTINEL: a cold empty courtyard at dawn, gate shut, no one in frame yet.";
const OWN_END = "OWN_END_SENTINEL: Victor slams the door, Anna alone in the dark.";

const prev = { number: 2, endState: PREV_END, endStateActual: null };
const prevWithActual = { number: 2, endState: PREV_END, endStateActual: PREV_END_ACTUAL };

// ── (a) scene N>1, continuous seam → opening = the PREVIOUS scene's ending ────
{
  const scene = {
    number: 3,
    sceneKind: "dialogue",
    durationSec: 30,
    continuesFrom: "same-location-continuation",
    locationDesc: "INT — workshop — night",
    dialogueEn: "ANNA: You came back.",
    startState: OWN_START,
    endState: OWN_END,
    characters: ["Anna", "Victor"],
  };
  const script = assembleSceneScript(scene, prev);
  ok(script.includes(PREV_END), "a: continuous seam — the OPENING contains the previous scene's endState text");
  ok(/OPENING — continues from Scene 2/.test(script), "a: opening explicitly says it continues from the previous scene");
  // The opening block (before LOCATION) is where the previous ending appears, i.e. the script BEGINS there.
  const openingBlock = script.slice(0, script.indexOf("LOCATION:"));
  ok(openingBlock.includes(PREV_END), "a: the previous ending is in the OPENING block (script begins where prev ended)");
  ok(script.includes(OWN_END), "a: the scene's own END STATE is still shown at the bottom");
}

// ── (a2) endStateActual (chain-mode real last frame) wins over scripted endState ──
{
  const scene = {
    number: 3,
    continuesFrom: "character-moves",
    action: "Anna turns to face Victor.",
    startState: OWN_START,
    endState: OWN_END,
  };
  const script = assembleSceneScript(scene, prevWithActual);
  ok(script.includes(PREV_END_ACTUAL) && !script.includes(PREV_END),
    "a2: the opening uses the previous scene's ACTUAL last-frame description over the scripted endState");
}

// ── (b) scene 1 → own startState, does NOT claim to continue a previous scene ──
{
  const scene = {
    number: 1,
    sceneKind: "narration",
    continuesFrom: "new-sequence",
    voiceover: "Long ago, the town forgot her name.",
    startState: OWN_START,
    endState: OWN_END,
  };
  const script = assembleSceneScript(scene, null);
  ok(script.includes(OWN_START), "b: scene 1 opens on its OWN startState");
  ok(!/continues from Scene/i.test(script), "b: scene 1 does NOT claim to continue a previous scene");
  ok(/fresh start of a new sequence/i.test(script), "b: scene 1 opening is labelled a fresh start");
  ok(script.includes("VOICE-OVER"), "b: a narration scene renders its VOICE-OVER");
}

// ── (c) location-change seam → does NOT inject the previous endState as the opening ──
{
  const scene = {
    number: 4,
    continuesFrom: "location-change",
    action: "Anna steps out into the street.",
    startState: OWN_START,
    endState: OWN_END,
  };
  const script = assembleSceneScript(scene, prev);
  ok(!script.includes(PREV_END), "c: location-change — the previous scene's endState is NOT injected as the opening");
  ok(script.includes(OWN_START), "c: location-change opens on the scene's own startState (fresh opening)");
  ok(!/continues from Scene/i.test(script), "c: location-change does NOT claim to continue the previous scene");
}

// ── seam classification helper ────────────────────────────────────────────────
ok(isContinuousSeam("same-location-continuation") === true, "seam: same-location-continuation is continuous");
ok(isContinuousSeam("character-moves") === true, "seam: character-moves is continuous");
ok(isContinuousSeam("location-change") === false, "seam: location-change breaks the sequence");
ok(isContinuousSeam("new-sequence") === false, "seam: new-sequence breaks the sequence");
ok(isContinuousSeam(null) === false, "seam: null is not a continuous seam");
ok(previousEndingText(prevWithActual) === PREV_END_ACTUAL, "seam: previousEndingText prefers the actual last frame");

// ── read-only wiring: endpoint + button + modal exist, no generation is triggered ──
{
  const routeText = read("app/api/ai/scenes/[id]/script/route.ts");
  ok(/export async function GET/.test(routeText), "wire: script route exposes a GET handler");
  ok(!/export async function (POST|PUT|DELETE|PATCH)/.test(routeText), "wire: script route is read-only (no mutating handlers)");
  ok(/project: \{ userId: session\.user\.id \}/.test(routeText), "wire: script route enforces project ownership");
  ok(/assembleSceneScript/.test(routeText), "wire: script route uses the pure assembler");

  const stage = read("app/project/[id]/_components/scenes-stage.tsx");
  ok(/Scene Script/.test(stage) && /SceneScriptModal/.test(stage), "wire: scenes-stage renders the Scene Script button + modal");

  const modal = read("app/project/[id]/_components/scene-script-modal.tsx");
  ok(/\/api\/ai\/scenes\/\$\{sceneId\}\/script/.test(modal), "wire: modal fetches the script endpoint");
  ok(!/method:\s*'(POST|PUT|DELETE)'/.test(modal), "wire: modal never mutates (read-only)");
}

console.log(`\nPASS — ${pass} assertions`);
