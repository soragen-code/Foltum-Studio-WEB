/**
 * Stage 126 — CHARACTER SCREEN-SIDE CONTINUITY (180-degree / line-of-action) + IMMUTABLE TABLE/SURFACE PROPS,
 * WITHOUT locking the camera.
 *
 * Two cross-scene continuity bugs:
 *  (A) characters swapped screen sides (frame-left ↔ frame-right) between consecutive scenes — nothing carried
 *      each character's screen side across the cut. Fix: read each character's screen side from the previous
 *      scene's actual last-frame text (openingState) and carry it into the next scene's prompt as a directive,
 *      plus a LINE OF ACTION (180-degree) rule that keeps left/right arrangement while leaving the camera free.
 *  (B) small objects on tables changed between scenes — surface props were not part of the fixed inventory.
 *      Fix: the idea location field rules now REQUIRE surface props in setInventory (location-level → identical
 *      every scene there), and every anchored shot carries a TABLE/SURFACE PROPS ARE IMMUTABLE directive.
 *
 * Pure/synthetic checks only — staging-map helpers, the two directive strings, and buildScenePrompt wiring.
 * No network, no LLM, no DB, no paid generations. Camera is NEVER locked (asserted explicitly).
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage126.ts
 */
import {
  detectScreenSide,
  buildStagingMap,
  stagingCarryLine,
  stagingContinuityBlock,
  LINE_OF_ACTION_LINE,
} from '../lib/staging-map';
import {
  buildScenePrompt,
  SURFACE_PROPS_IMMUTABLE_LINE,
  GAZE_AT_LISTENER_LINE,
  LOCATION_ANCHOR_LINE,
} from '../lib/scene-prompt';
import { LOCATION_FIELD_RULES_TEXT_FOR_TESTS } from '../lib/idea';
import { REFERENCE_ASPECT_RATIO } from '../lib/visual-style';
import { VISUAL_STYLE_ID } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';

// A realistic previous-scene last-frame description (as lib/frame-state.ts writes it: frame-left / frame-right).
const PREV_STATE =
  'WORLD: the kitchen. Kara stands frame-left by the window, a mug in her hand; Merek is on the right of ' +
  'frame near the door. CAMERA: medium two-shot.';

// ── (A1) detectScreenSide — reads the screen side of each named character ────────────────────────────────
ok(detectScreenSide(PREV_STATE, 'Kara') === 'left', 'detectScreenSide: Kara reads as frame-left');
ok(detectScreenSide(PREV_STATE, 'Merek') === 'right', 'detectScreenSide: Merek reads as frame-right');
ok(detectScreenSide(PREV_STATE, 'Nobody') === null, 'detectScreenSide: an absent name → null (no guess)');
ok(detectScreenSide('', 'Kara') === null, 'detectScreenSide: empty text → null');
ok(detectScreenSide('Kara stands dead-centre of the frame.', 'Kara') === 'center',
  'detectScreenSide: centre wording → center');
// nearest keyword wins when two names each have their own side cue
ok(detectScreenSide('Merek on the left, Kara on the right.', 'Kara') === 'right',
  'detectScreenSide: nearest side keyword to the name wins (Kara → right here)');

// ── (A2) buildStagingMap — only characters whose side can be read, deduped, in order ─────────────────────
const map = buildStagingMap(PREV_STATE, ['Kara', 'Merek', 'Ghost']);
ok(map.length === 2, 'buildStagingMap: only characters with a readable side are included (Ghost dropped)');
ok(map[0].name === 'Kara' && map[0].side === 'left', 'buildStagingMap: Kara → left, order preserved');
ok(map[1].name === 'Merek' && map[1].side === 'right', 'buildStagingMap: Merek → right');
ok(buildStagingMap(PREV_STATE, ['Kara', 'kara']).length === 1, 'buildStagingMap: names are de-duplicated case-insensitively');

// ── (A3) stagingCarryLine — names who stays on which side, empty when nothing detected ───────────────────
const carry = stagingCarryLine(map);
ok(/Kara stays on the LEFT of frame/.test(carry) && /Merek stays on the RIGHT of frame/.test(carry),
  'stagingCarryLine: names each character with the screen side carried over');
ok(/carry over from the previous shot/i.test(carry) && /SAME left-to-right arrangement/i.test(carry),
  'stagingCarryLine: states the sides are carried over and kept in the same arrangement');
ok(stagingCarryLine([]) === '', 'stagingCarryLine: empty map → empty string (nothing to say)');

// ── (A4) LINE_OF_ACTION_LINE — 180-degree rule that KEEPS the camera free (no camera lock) ───────────────
ok(/180-degree rule/.test(LINE_OF_ACTION_LINE) && /line of action/i.test(LINE_OF_ACTION_LINE),
  'LINE_OF_ACTION_LINE: names the 180-degree rule / line of action');
ok(/the camera stays free/i.test(LINE_OF_ACTION_LINE) && /may move to any new angle, height, distance or shot scale/i.test(LINE_OF_ACTION_LINE),
  'LINE_OF_ACTION_LINE: the camera stays FREE — any angle, height, distance, shot scale');
ok(/push in, pull out, arc or track/i.test(LINE_OF_ACTION_LINE),
  'LINE_OF_ACTION_LINE: the camera may push in / pull out / arc / track (movement not restricted)');
// It restricts only the axis crossing that swaps sides — NOT the camera angle.
ok(/NOT do is jump across the line of action/i.test(LINE_OF_ACTION_LINE) && /swaps their left\/right places/i.test(LINE_OF_ACTION_LINE),
  'LINE_OF_ACTION_LINE: only forbids crossing the axis so people swap sides');
ok(/change sides ONLY when their own on-screen movement shows it/i.test(LINE_OF_ACTION_LINE),
  'LINE_OF_ACTION_LINE: a side change is allowed ONLY via on-screen character movement');
// CRITICAL: no camera lock language anywhere in the directive.
ok(!/camera is fixed|locked camera|static camera|do not move the camera|no camera movement|keep the same camera angle|same framing/i.test(LINE_OF_ACTION_LINE),
  'LINE_OF_ACTION_LINE: contains NO camera-lock language (camera is not restricted)');
// Does not break eyelines / turn anyone frontal.
ok(/keeping eyelines connected/i.test(LINE_OF_ACTION_LINE) && /never makes anyone face the viewer/i.test(LINE_OF_ACTION_LINE),
  'LINE_OF_ACTION_LINE: preserves EYELINES CONNECT and never turns anyone frontal');

// ── (B1) SURFACE_PROPS_IMMUTABLE_LINE — table/surface props are fixed, camera still free ─────────────────
ok(/TABLE\/SURFACE PROPS ARE IMMUTABLE/.test(SURFACE_PROPS_IMMUTABLE_LINE),
  'SURFACE_PROPS_IMMUTABLE_LINE: names the immutable table/surface props rule');
ok(/Do NOT add, remove, swap, restyle, resize, recolour or rearrange anything sitting on a surface/i.test(SURFACE_PROPS_IMMUTABLE_LINE),
  'SURFACE_PROPS_IMMUTABLE_LINE: forbids adding/removing/swapping/rearranging surface objects between shots');
ok(/re-invent what is on a table from scratch each scene/i.test(SURFACE_PROPS_IMMUTABLE_LINE),
  'SURFACE_PROPS_IMMUTABLE_LINE: forbids re-inventing table contents each scene');
ok(/changes ONLY when this scene's action shows it changing on screen/i.test(SURFACE_PROPS_IMMUTABLE_LINE),
  'SURFACE_PROPS_IMMUTABLE_LINE: a surface object changes only when on-screen action moves it');
ok(/The camera is free to frame these surfaces from any new angle, height or distance/i.test(SURFACE_PROPS_IMMUTABLE_LINE),
  'SURFACE_PROPS_IMMUTABLE_LINE: the camera stays FREE (surfaces framed from any angle)');
ok(!/camera is fixed|locked camera|static camera|do not move the camera/i.test(SURFACE_PROPS_IMMUTABLE_LINE),
  'SURFACE_PROPS_IMMUTABLE_LINE: contains NO camera-lock language');

// ── (B2) idea location field rules now REQUIRE surface props in setInventory ─────────────────────────────
ok(/SURFACE PROPS ARE MANDATORY/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules: setInventory must now include surface props (SURFACE PROPS ARE MANDATORY)');
ok(/NAMES the surface it sits on/i.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules: each surface prop placement must name the surface it sits on');
ok(/must never be re-invented per shot/i.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules: surface props are fixed dressing, never re-invented per shot');
// Regression: the existing setInventory rule (12-30, wall-adjacency) is untouched (Stage 113/121).
ok(/"setInventory"/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS) && /12-30/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules regression: still the setInventory field, still 12-30 entries (Stage 113)');
ok(/WALL-ADJACENCY IS MANDATORY/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules regression: wall-adjacency rule still present (Stage 121)');

// ── (C) buildScenePrompt integration — a CONTINUING dialogue scene in an anchored location ───────────────
const location = {
  id: 'loc', name: 'Kitchen',
  imageUrl: url('kitchen-wide'), imageReverse: url('kitchen-layout'),
  setInventory: 'long table — center; chipped white mug — on the table, left side; stack of papers — on the table, right corner',
};
const characters = [
  { characterId: 'c1', name: 'Kara', imageFull: url('kara'), appearance: 'grey coat', tier: 'MAIN' },
  { characterId: 'c2', name: 'Merek', imageFull: url('merek'), appearance: 'dark jacket', tier: 'MAIN' },
];
const previous = {
  id: 'p1', number: 1, videoUrl: url('prev-video'), lastFrameUrl: url('prev-frame'),
  status: 'generated', endStateActual: PREV_STATE,
} as any;
const scene2 = {
  id: 's2', number: 2, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  continuesFrom: 's1',
  videoPrompt: '[SHOT TYPE]: medium two-shot\n[ACTION]: Kara turns to Merek.\n[TRANSITION]: hard cut',
  dialogue: 'KARA: "You stayed."\nMEREK: "I did."',
  action: 'Kara faces Merek across the table.',
  startState: 'WORLD: kitchen.\nCAMERA: medium two-shot', endState: 'They hold each other\'s gaze.',
} as any;

const built2 = buildScenePrompt({ scene: scene2, characters, location, previous } as any).prompt;
ok(built2.includes('Kara stays on the LEFT of frame') && built2.includes('Merek stays on the RIGHT of frame'),
  'scene: the continuing shot carries the screen sides from the previous last frame (Kara left, Merek right)');
ok(built2.includes(LINE_OF_ACTION_LINE),
  'scene: the LINE OF ACTION (180-degree) directive is present on the continuing shot');
ok(built2.includes(SURFACE_PROPS_IMMUTABLE_LINE),
  'scene: the TABLE/SURFACE PROPS ARE IMMUTABLE directive is present (location anchored)');
ok(built2.includes(GAZE_AT_LISTENER_LINE),
  'scene: EYELINES CONNECT is still present in a dialogue shot (not broken by the axis rule)');
ok(built2.includes(LOCATION_ANCHOR_LINE),
  'scene: the location anchor line is still present (no region plate here)');
// CRITICAL end-to-end: the assembled prompt imposes NO camera lock.
ok(!/camera is fixed|locked camera|static camera|do not move the camera|no camera movement|keep the same camera angle/i.test(built2),
  'scene: the assembled prompt contains NO camera-lock language (camera stays free)');

// ── (C2) surface props carry between two scenes of the SAME location (location-level → identical) ─────────
const scene3 = { ...scene2, id: 's3', number: 3, continuesFrom: 's2',
  previousId: 's2' } as any;
const previous2 = {
  id: 's2', number: 2, videoUrl: url('v2'), lastFrameUrl: url('f2'), status: 'generated',
  endStateActual: 'WORLD: kitchen. Kara frame-left, Merek on the right. CAMERA: closer two-shot.',
} as any;
const built3 = buildScenePrompt({ scene: scene3, characters, location, previous: previous2 } as any).prompt;
ok(built3.includes(SURFACE_PROPS_IMMUTABLE_LINE),
  'scene 3 (same location): the immutable surface-props directive is present again — identical set carried across scenes');
ok(built3.includes('Kara stays on the LEFT of frame') && built3.includes('Merek stays on the RIGHT of frame'),
  'scene 3: screen sides still carried (Kara left, Merek right) — no swap across the cut');

// ── (C3) a scene that does NOT continue (fresh sequence) gets no staging carry ───────────────────────────
const sceneFresh = { ...scene2, id: 'sf', number: 1, continuesFrom: 'new-sequence' } as any;
const builtFresh = buildScenePrompt({ scene: sceneFresh, characters, location, previous: null } as any).prompt;
ok(!builtFresh.includes('stays on the LEFT of frame') && !builtFresh.includes(LINE_OF_ACTION_LINE),
  'fresh scene (no previous): no screen-side carry and no line-of-action block');
ok(builtFresh.includes(SURFACE_PROPS_IMMUTABLE_LINE),
  'fresh scene: surface props are still immutable (location anchored) even on a non-continuing shot');

// ── (D) stagingContinuityBlock — carry line + axis rule, or just the axis rule when nothing detected ─────
const block = stagingContinuityBlock(PREV_STATE, ['Kara', 'Merek']);
ok(block.includes('Kara stays on the LEFT of frame') && block.includes(LINE_OF_ACTION_LINE),
  'stagingContinuityBlock: combines the carry line with the line-of-action directive');
ok(stagingContinuityBlock('', ['Kara']) === LINE_OF_ACTION_LINE,
  'stagingContinuityBlock: with no readable sides it still emits the axis rule (defensive)');

// ── (E) untouched-stage regression (in-file sanity) ──────────────────────────────────────────────────────
ok(REFERENCE_ASPECT_RATIO === '9:16', 'regression: reference aspect ratio is still 9:16 (Stage 124)');

console.log(`Stage 126: PASS (${passed} checks)`);
