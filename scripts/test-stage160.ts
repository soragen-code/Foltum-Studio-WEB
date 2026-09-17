/**
 * Stage 160 — a MANUAL (author-provided) episode script preserves the author's OWN per-scene locations
 * in the rendered script (instead of collapsing every scene to the single episode location). Auto (LLM)
 * scripts stay anchored to one location, so their rendering is unchanged (Stage 157).
 *
 * Pure-logic unit test (no network, no DB, no paid generation). Verifies:
 *   (a) sceneLocationName extracts a clean place name from an "INT/EXT — place — time" descriptor.
 *   (b) episodeHasMultipleLocations is true for distinct per-scene locations, false when all share one.
 *   (c) renderEpisodeScriptText on a MULTI-location script shows each scene's own place (not one name).
 *   (d) renderEpisodeScriptText on a SINGLE-location script still shows ep.locationName (Stage 157 intact).
 *   (e) episodeScriptUserPrompt with a userScript includes the per-scene-location preservation instruction;
 *       without a userScript it does not.
 */
import {
  sceneLocationName,
  episodeHasMultipleLocations,
  renderEpisodeScriptText,
  renderScriptFromScenes,
  episodeScriptUserPrompt,
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

// ── (a) sceneLocationName ────────────────────────────────────────────────────
ok(sceneLocationName("INT — Security office — day") === "Security office", "sceneLocationName: INT — Security office — day → Security office");
ok(sceneLocationName("Open-plan office floor") === "Open-plan office floor", "sceneLocationName: no separators → text as-is (hyphenated word not split)");
ok(sceneLocationName("") === "", "sceneLocationName: empty → empty");
ok(sceneLocationName("EXT — Rooftop — night") === "Rooftop", "sceneLocationName: EXT — Rooftop — night → Rooftop");
ok(sceneLocationName("INT — Staff dining recess") === "Staff dining recess", "sceneLocationName: 2 parts with INT opener → second part");
ok(sceneLocationName("ИНТ — Кабинет охраны — день") === "Кабинет охраны", "sceneLocationName: Russian ИНТ/день stripped → place");

// ── (b) episodeHasMultipleLocations ──────────────────────────────────────────
const multiScenes = [
  { locationDesc: "INT — Open-plan office floor — day" },
  { locationDesc: "INT — Security office — day" },
  { locationDesc: "INT — Staff dining recess — day" },
];
const singleScenes = [
  { locationDesc: "INT — Security office — day" },
  { locationDesc: "INT — Security office — night" },
];
ok(episodeHasMultipleLocations(multiScenes) === true, "episodeHasMultipleLocations: true for distinct locations");
ok(episodeHasMultipleLocations(singleScenes) === false, "episodeHasMultipleLocations: false when all scenes share one place");
ok(episodeHasMultipleLocations([]) === false, "episodeHasMultipleLocations: false for no scenes");

// ── (c) renderEpisodeScriptText — MULTI-location manual script ────────────────
const EP_NAME = "Штаб";
const scriptedStart = "WORLD: at the desk.\nCAMERA: wide.";
const scriptedEnd = "WORLD: by the door.\nCAMERA: medium.";
const multiOutline = {
  number: 4,
  title: "Смена",
  logline: "Обычный день в офисе.",
  locationName: EP_NAME,
  locationDesc: "INT — Open-plan office floor — day",
  characters: ["Mark", "Anna"],
  cliffhanger: "Гаснет свет.",
} as any;
const multiScript = {
  visualIdentity: "photoreal cinematic look",
  scenes: [
    { number: 1, sceneKind: "dialogue", shotType: "medium", durationSec: 10, locationDesc: "INT — Open-plan office floor — day", action: "Mark walks in.", dialogue: 'MARK: "Morning."', startState: scriptedStart, endState: scriptedEnd },
    { number: 2, sceneKind: "dialogue", shotType: "medium", durationSec: 10, locationDesc: "INT — Security office — day", action: "Anna checks the feeds.", dialogue: 'ANNA: "All clear."', startState: scriptedStart, endState: scriptedEnd },
    { number: 3, sceneKind: "dialogue", shotType: "medium", durationSec: 10, locationDesc: "INT — Staff dining recess — day", action: "They eat lunch.", dialogue: 'MARK: "Quiet today."', startState: scriptedStart, endState: scriptedEnd },
  ],
} as any;
{
  const text = renderEpisodeScriptText(multiOutline, multiScript);
  ok(text.includes("Open-plan office floor"), "multi: scene 1 shows its own place (Open-plan office floor)");
  ok(text.includes("Security office"), "multi: scene 2 shows its own place (Security office)");
  ok(text.includes("Staff dining recess"), "multi: scene 3 shows its own place (Staff dining recess)");
  // The single episode name must NOT be forced onto every scene: it appears at most in the head list, never 3×.
  ok(text.split("Security office").length - 1 >= 1, "multi: per-scene place actually rendered in the body");
  ok(/Локация: .*Open-plan office floor.*Security office.*Staff dining recess/.test(text.replace(/\n/g, " ")),
    "multi: head lists the distinct per-scene locations");
}

// ── (c') renderScriptFromScenes — MULTI-location from persisted rows ──────────
{
  const rows = [
    { number: 1, sceneKind: "dialogue", shotType: "medium", durationSec: 10, locationDesc: "INT — Open-plan office floor — day", action: "Mark walks in.", dialogue: 'MARK: "Morning."' },
    { number: 2, sceneKind: "dialogue", shotType: "medium", durationSec: 10, locationDesc: "INT — Security office — day", action: "Anna checks the feeds.", dialogue: 'ANNA: "All clear."' },
  ];
  const text = renderScriptFromScenes({ number: 4, title: "Смена", logline: "l", locationName: EP_NAME, cliffhanger: "c" }, ["Mark", "Anna"], rows);
  ok(text.includes("Open-plan office floor") && text.includes("Security office"),
    "renderScriptFromScenes multi: each stored scene shows its own place");
}

// ── (d) renderEpisodeScriptText — SINGLE-location script (Stage 157 intact) ───
const SINGLE_NAME = "Храм Теней";
const SCENE_DESC = "INT — some place — night";
const singleOutline = { ...multiOutline, locationName: SINGLE_NAME, locationDesc: SCENE_DESC } as any;
const singleScript = {
  visualIdentity: "photoreal cinematic look",
  scenes: [
    { number: 1, sceneKind: "dialogue", shotType: "medium", durationSec: 10, locationDesc: SCENE_DESC, action: "x", dialogue: 'A: "1"', startState: scriptedStart, endState: scriptedEnd },
    { number: 2, sceneKind: "dialogue", shotType: "medium", durationSec: 10, locationDesc: SCENE_DESC, action: "y", dialogue: 'B: "2"', startState: scriptedStart, endState: scriptedEnd },
  ],
} as any;
{
  const text = renderEpisodeScriptText(singleOutline, singleScript);
  ok(text.includes(`Локация: ${SINGLE_NAME}`), "single: head shows the episode locationName");
  ok(text.split(SINGLE_NAME).length - 1 >= 3, "single: episode locationName printed per scene (Stage 157)");
  ok(!text.includes(SCENE_DESC), "single: per-scene locationDesc descriptor is NOT rendered (Stage 157)");
}

// ── (e) episodeScriptUserPrompt — location-preservation instruction ──────────
const baseInput = {
  synopsis: "A drama.",
  season: { title: "S", logline: "L", episodes: [] },
  episode: { number: 2, title: "Ep Two", arcRole: "rising", logline: "It continues.", cliffhanger: "A door opens.", locationName: "Temple", locationDesc: "INT — temple — night", characters: [] } as any,
  characters: [],
  previous: [{ number: 1, title: "Ep One", logline: "It began.", cliffhanger: "A figure appears." }],
  previousEnding: null,
};
{
  const withScript = episodeScriptUserPrompt({ ...baseInput, userScript: "SCENE 1. Office.\nMARK: Hi.\nSCENE 2. Rooftop." });
  ok(/PRESERVE THE AUTHOR'S LOCATIONS/.test(withScript), "userScript present: includes the location-preservation instruction");
  ok(/DO NOT collapse every scene into a single location/.test(withScript), "userScript present: forbids collapsing to one location");
  const withoutScript = episodeScriptUserPrompt(baseInput);
  ok(!/PRESERVE THE AUTHOR'S LOCATIONS/.test(withoutScript), "no userScript: does NOT include the location-preservation instruction");
}

console.log(`Stage 160: PASS (${passed} checks; pure logic, no network, no paid generation)`);
