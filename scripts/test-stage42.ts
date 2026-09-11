/**
 * Stage 42 checks — 5x more detailed frame-state descriptions + deterministic parallel-mode hand-off
 * (startState[i] === endState[i-1]). Run: npx tsx --tsconfig tsconfig.json scripts/test-stage42.ts
 */
import assert from "node:assert";
import {
  START_STATE_RULE, END_STATE_RULE, normalizeEpisodeScript, episodeScriptSchema,
  renderEpisodeScriptText, renderScriptFromScenes, START_STATE_LINE_PREFIX, END_STATE_LINE_PREFIX,
} from "../lib/season";
import { buildScenePrompt, resolveOpeningState, OPENING_STATE_PREFIX } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const styledUrl = (name: string) => "https://media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";

const prompt = "[SHOT TYPE]: 0-5s wide / 5-15s medium two-shot\n[VISUAL STYLE]: photoreal\n[LIGHTING]: warm lamp\n[BLOCKING]: Anna at the table, Mark by the door\n[GAZE]: at each other\n[NON-VERBAL]: tense\n[ACTION]: Anna turns to Mark.\n[CHARACTER]: Anna, Mark\n[TRANSITION]: hard cut";
const talk = 'ANNA (softly): "You knew from the very start and stayed silent all this time? Every night you looked me in the eye."\nMARK (sharply): "I stayed silent because otherwise you would have left back then, that winter, in the cold."';

// ── A. rule text carries the strengthened detail contract ────────────────────────────────────────
function ruleChecks() {
  for (const [name, rule] of [["START", START_STATE_RULE], ["END", END_STATE_RULE]] as const) {
    ok(/150 words/.test(rule) && /12.?20 sentences/.test(rule), `A: ${name}_STATE_RULE demands 12-20 sentences / >=150 words`);
    ok(rule.includes("STATIC still frame") && rule.includes("present tense"), `A: ${name}_STATE_RULE demands one static still, present tense`);
    for (const kw of ["CAMERA", "LIGHTING", "COMPOSITION", "posture", "colour palette", "wardrobe"].map(k => k)) {
      ok(rule.includes(kw), `A: ${name}_STATE_RULE mentions ${kw}`);
    }
  }
  ok(START_STATE_RULE.includes("CHAIN RULE") && END_STATE_RULE.includes("HAND-OFF RULE"), "A: hand-off / chain rules preserved");
}

// ── B. normalizeEpisodeScript rewrites startState[i] = endState[i-1] verbatim ─────────────────────
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
  number: i + 1,
  shotType: "Medium shot",
  durationSec: 30,
  locationDesc: "INT — Office — day",
  characters: ["Anna", "Mark"],
  action: "Anna and Mark talk.",
  dialogue: talk,
  videoPrompt: prompt,
  startState: `SCRIPTED-START-${i + 1}: Anna and Mark posed in the office, frame 1 of scene ${i + 1}.`,
  endState: `SCRIPTED-END-${i + 1}: Anna and Mark posed in the office, final frame of scene ${i + 1}.`,
}));

function handoffChecks() {
  const ep = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6) }));
  ok(ep.scenes.length >= 3, "B: episode has >=3 scenes");
  ok(ep.scenes[0].startState === "SCRIPTED-START-1: Anna and Mark posed in the office, frame 1 of scene 1.", "B: scene 1 keeps its own startState");
  let allChained = true;
  for (let i = 1; i < ep.scenes.length; i++) {
    if (ep.scenes[i].startState !== ep.scenes[i - 1].endState) allChained = false;
  }
  ok(allChained, "B: startState[i] === endState[i-1] for every i>=2 (verbatim hand-off)");
  // endState values themselves are untouched by the hand-off pass.
  ok(ep.scenes[2].endState === "SCRIPTED-END-3: Anna and Mark posed in the office, final frame of scene 3.", "B: endState is not mutated by the hand-off");
}

// ── C. parallel vs chain opening state ───────────────────────────────────────────────────────────
function openingStateChecks() {
  const ep = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6) }));
  const s3 = ep.scenes[2]; // startState now == endState of scene 2
  const cast = ["Anna", "Mark"].map(n => ({ characterId: n.toLowerCase(), name: n, tier: "MAIN", imageFront: styledUrl(n.toLowerCase()) }));
  const loc = { id: "office", name: "Office", imageUrl: styledUrl("office") };
  // Parallel mode: no endStateActual → OPENING STATE is scene.startState (== previous endState).
  const prevParallel = { id: "s2", number: 2, locationDesc: "Office", lastFrameUrl: styledUrl("s2-last"), endState: ep.scenes[1].endState, endStateActual: null as string | null };
  const bp = buildScenePrompt({ scene: s3 as any, characters: cast, location: loc, previous: prevParallel, provider: "seedance" });
  ok(bp.openingState === s3.startState && bp.prompt.startsWith(OPENING_STATE_PREFIX + s3.startState), "C: parallel OPENING STATE == scene.startState");
  ok(bp.openingState === ep.scenes[1].endState, "C: parallel OPENING STATE == previous scene endState (butt-join)");
  ok(resolveOpeningState(s3 as any, prevParallel) === s3.startState, "C: resolveOpeningState (parallel) prefers scene.startState");
  // Chain mode: endStateActual (real vision frame) still wins.
  const actual = "REAL-FRAME: Anna mid-step near the door, medium two-shot from the sink.";
  ok(resolveOpeningState(s3 as any, { ...prevParallel, endStateActual: actual }) === actual, "C: chain mode still prefers previous.endStateActual");
}

// ── D. rendering survives long descriptions ──────────────────────────────────────────────────────
function renderChecks() {
  const ep = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6) }));
  const outline = { number: 1, title: "T", logline: "l", locationName: "Office", locationDesc: "office", characters: ["Anna", "Mark"], cliffhanger: "c" } as any;
  const txt = renderEpisodeScriptText(outline, ep as any);
  ok(txt.includes(START_STATE_LINE_PREFIX) && txt.includes(END_STATE_LINE_PREFIX), "D: renderEpisodeScriptText shows start/end frame lines");
  const fromScenes = renderScriptFromScenes({ number: 1, title: "T" }, ["Anna", "Mark"], ep.scenes.map(s => ({ number: s.number, sceneKind: s.sceneKind, shotType: s.shotType, durationSec: s.durationSec, locationDesc: s.locationDesc, action: s.action, dialogue: s.dialogue, startState: s.startState, endState: s.endState })));
  ok(fromScenes.includes(START_STATE_LINE_PREFIX) && fromScenes.includes(END_STATE_LINE_PREFIX), "D: renderScriptFromScenes shows start/end frame lines");
}

ruleChecks();
handoffChecks();
openingStateChecks();
renderChecks();
console.log(`\nStage 42: ${pass} checks passed.`);
