/**
 * Stage 161 — a MANUAL (author-provided) episode script may keep a purely SILENT atmospheric/establishing
 * scene (no spoken lines) instead of having dialogue forced onto it or the scene dropped. Gated STRICTLY to
 * the manual path: the AUTO (LLM) path keeps MAX_SILENT_SCENES = 0 and silent stays a HARD failure.
 *
 * Pure-logic unit test (no network, no DB, no paid generation). Verifies:
 *   (a) validateEpisodeScript on a script with ONE silent scene + normal dialogue scenes:
 *         - allowSilent:true  → NO hard problems (silent problem is soft:).
 *         - allowSilent:false → hard problems present AND include the silent-scene message (AUTO unchanged).
 *   (b) an ALL-silent script fails HARD even with allowSilent:true ("no dialogue in episode" stays hard).
 *   (c) episodeScriptUserPrompt with a userScript includes the "KEEP IT SILENT" instruction; without it, does not.
 *   (d) normalizeEpisodeScript with {manual:true} keeps every authored scene (>EPISODE_SCENE_COUNT); the
 *       AUTO path (no opts) still truncates to EPISODE_SCENE_COUNT.
 */
import {
  validateEpisodeScript,
  hardProblems,
  normalizeEpisodeScript,
  episodeScriptUserPrompt,
  episodeScriptSchema,
  EPISODE_SCENE_COUNT,
  type EpisodeScript,
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

// A complete videoPrompt carrying all nine required tags (PROMPT_LINES).
const VP =
  "[SHOT TYPE]: wide establishing. [VISUAL STYLE]: photoreal cinematic. [LIGHTING]: neon dusk glow. " +
  "[BLOCKING]: camera drifts over the skyline. [GAZE]: none. [NON-VERBAL]: distant traffic. " +
  "[ACTION]: the megacity hums. [CHARACTER]: none on camera. [TRANSITION]: slow dissolve.";

const STATE = "WORLD: the city at dusk, towers glinting.\nCAMERA: high wide drone shot.";

function talkScene(n: number) {
  return {
    number: n,
    sceneKind: "dialogue",
    shotType: "medium",
    durationSec: 12,
    locationDesc: "INT — Security office — day",
    characters: ["Mark", "Anna"],
    action: "Mark and Anna review the feeds.",
    dialogue: `MARK: "The perimeter is clear."\nANNA: "Keep watching the east gate."`,
    videoPrompt: VP,
    startState: STATE,
    endState: STATE,
  };
}

function silentScene(n: number) {
  return {
    number: n,
    sceneKind: "dialogue",
    shotType: "wide",
    durationSec: 10,
    locationDesc: "EXT — megacity skyline — dusk",
    characters: [],
    action: "The camera drifts over the neon skyline; the city hums, no one speaks.",
    dialogue: "[NO DIALOGUE]",
    videoPrompt: VP,
    startState: STATE,
    endState: STATE,
  };
}

const cast = ["Mark", "Anna"];

// ── (a) one silent scene + 8 dialogue scenes ─────────────────────────────────
{
  const scenes = [silentScene(1), ...Array.from({ length: 8 }, (_, i) => talkScene(i + 2))];
  const script = { visualIdentity: "photoreal cinematic look", scenes } as unknown as EpisodeScript;

  const soft = validateEpisodeScript(script, { characterNames: cast, allowSilent: true });
  ok(hardProblems(soft).length === 0, "allowSilent:true → no hard problems for a script with one silent scene");

  const hard = validateEpisodeScript(script, { characterNames: cast, allowSilent: false });
  const hardOnly = hardProblems(hard);
  ok(hardOnly.length > 0, "allowSilent:false → hard problems present (AUTO path unchanged)");
  ok(hardOnly.some((p) => /silent scene\(s\) 1/.test(p)), "allowSilent:false → hard problems include the silent-scene message");
  // The soft run must still REPORT the silent scene, only prefixed soft:.
  ok(soft.some((p) => /^soft: silent scene\(s\) 1/.test(p)), "allowSilent:true → silent problem is retained as a soft: warning");
}

// ── (b) all-silent script still fails HARD even with allowSilent:true ─────────
{
  const scenes = Array.from({ length: 9 }, (_, i) => silentScene(i + 1));
  const script = { visualIdentity: "photoreal cinematic look", scenes } as unknown as EpisodeScript;
  const problems = validateEpisodeScript(script, { characterNames: cast, allowSilent: true });
  const hard = hardProblems(problems);
  ok(hard.length > 0, "all-silent + allowSilent:true → still fails HARD");
  ok(hard.some((p) => /no dialogue in episode/.test(p)), "all-silent → 'no dialogue in episode' stays a HARD problem");
}

// ── (c) episodeScriptUserPrompt — KEEP IT SILENT instruction ─────────────────
{
  const baseInput = {
    synopsis: "A drama.",
    season: { title: "S", logline: "L", episodes: [] },
    episode: { number: 2, title: "Ep Two", arcRole: "rising", logline: "It continues.", cliffhanger: "A door opens.", locationName: "Temple", locationDesc: "INT — temple — night", characters: [] } as any,
    characters: [],
    previous: [{ number: 1, title: "Ep One", logline: "It began.", cliffhanger: "A figure appears." }],
    previousEnding: null,
  };
  const withScript = episodeScriptUserPrompt({ ...baseInput, userScript: "SCENE 0. Megacity skyline (без диалогов).\nSCENE 1. Office.\nMARK: Hi." });
  ok(/KEEP IT SILENT/.test(withScript), "userScript present: includes the KEEP IT SILENT instruction");
  const withoutScript = episodeScriptUserPrompt(baseInput);
  ok(!/KEEP IT SILENT/.test(withoutScript), "no userScript: does NOT include the KEEP IT SILENT instruction");
}

// ── (d) normalizeEpisodeScript scene-count preservation (part 6) ──────────────
{
  // 10 authored scenes (a silent Scene 0 + 9 beats): manual keeps all 10, auto truncates to EPISODE_SCENE_COUNT.
  const scenes10 = [silentScene(1), ...Array.from({ length: 9 }, (_, i) => talkScene(i + 2))];
  const raw = { visualIdentity: "photoreal cinematic look", scenes: scenes10 };
  const parsed = episodeScriptSchema.parse(raw); // must PARSE (schema max raised for the extra scene)
  ok(parsed.scenes.length === 10, "episodeScriptSchema parses a 10-scene manual script (schema headroom)");

  const manual = normalizeEpisodeScript(parsed, [], { manual: true });
  ok(manual.scenes.length === 10, "normalizeEpisodeScript {manual:true} keeps all 10 authored scenes");

  const auto = normalizeEpisodeScript(parsed, []);
  ok(auto.scenes.length === EPISODE_SCENE_COUNT, `normalizeEpisodeScript auto truncates to EPISODE_SCENE_COUNT (=${EPISODE_SCENE_COUNT})`);
}

console.log(`Stage 161: PASS (${passed} checks; pure logic, no network, no paid generation)`);
