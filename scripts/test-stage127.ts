/**
 * Stage 127 — STORYBOARD production mode (pure/synthetic checks).
 *
 * A SECOND episode production mode, chosen AFTER the story is built, alternative to SCENES. The story is
 * split into 12–15 KEYFRAME BOARDS (one shot change each = one action beat OR one dialogue pair); every
 * board frame (9:16 still) is ANIMATED into a 4–6s image-to-video clip (board frame = clip START frame),
 * and the clips are stitched into one ~90s cut. The keyframe/i2v ban is LIFTED for STORYBOARD only —
 * SCENES keeps its text-to-video / no-start-frame rules.
 *
 * These checks are PURE (no network, no LLM, no DB, no paid generations):
 *   - board-count & duration maths (12–15 boards, each ∈ [3,6], ~90s total, ordered, one beat each)
 *   - the single flowing through-line has NO "first-30 / last-30" (SHOT 1 / SHOT 2) split markers
 *   - the board FRAME prompt is 9:16, carries the gender-lock, eyelines (dialogue) & no-frontal lines,
 *     and is camera-free (never locked)
 *   - SCENES regression: the classic reference grammar is untouched (still 9:16, keyframe ban wording)
 *
 * Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage127.ts
 */
import {
  STORYBOARD_MIN_BOARDS,
  STORYBOARD_MAX_BOARDS,
  STORYBOARD_MIN_BOARD_SEC,
  STORYBOARD_MAX_BOARD_SEC,
  STORYBOARD_TARGET_TOTAL_SEC,
  distributeBoardDurations,
  normalizeBoards,
  validateBoards,
  totalBoardSeconds,
  detailedEpisodeStory,
  hasSplitMarkers,
  storyboardBoardsSystemPrompt,
  type RawBoard,
} from '../lib/storyboard';
import {
  buildBoardFramePrompt,
  buildBoardMotionPrompt,
  isDialogueBoard,
  type BoardCharacterLink,
} from '../lib/storyboard-prompt';
import { REFERENCE_ASPECT_RATIO } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// ── (A) duration distribution ──────────────────────────────────────────────────────────────────────────
for (let n = STORYBOARD_MIN_BOARDS; n <= STORYBOARD_MAX_BOARDS; n++) {
  const d = distributeBoardDurations(n);
  ok(d.length === n, `distributeBoardDurations(${n}) returns ${n} durations`);
  ok(d.every((s) => s >= 3 && s <= 6), `distributeBoardDurations(${n}): every board is a 3–6s shot change`);
  ok(d.every((s) => s >= STORYBOARD_MIN_BOARD_SEC && s <= STORYBOARD_MAX_BOARD_SEC), `distributeBoardDurations(${n}): rendered window [4,6] (i2v floor)`);
}
ok(distributeBoardDurations(15).reduce((a, b) => a + b, 0) === STORYBOARD_TARGET_TOTAL_SEC, '15 boards hit ~90s exactly');
{
  const total12 = distributeBoardDurations(12).reduce((a, b) => a + b, 0);
  ok(total12 >= 48 && total12 <= 72, `12 boards land in a ~1–1.5 min cut (${total12}s)`);
}

// ── (B) normalizeBoards + validateBoards ────────────────────────────────────────────────────────────────
const raw: RawBoard[] = [];
for (let i = 0; i < 14; i++) raw.push({ actionOrDialogue: `Beat ${i + 1}: something happens.`, motion: `subject moves ${i}` });
raw.push({ actionOrDialogue: '   ' }); // empty -> dropped
raw.push({ actionOrDialogue: 'Extra 1' });
raw.push({ actionOrDialogue: 'Extra 2' });
raw.push({ actionOrDialogue: 'Extra 3' }); // Stage 148 — no longer trimmed: the count is content-derived
const norm = normalizeBoards(raw);
// Stage 148 — normalizeBoards no longer slices to a fixed 12–15 window; it keeps EVERY non-empty board
// (14 beats + 3 extras = 17; the one blank board is still dropped). The count follows the content.
ok(norm.length === 17, `normalizeBoards keeps every non-empty board (17), no slice to a fixed max (got ${norm.length})`);
ok(norm.length > STORYBOARD_MAX_BOARDS, 'normalizeBoards drops empties but keeps the overflow beyond the old 15-board max');
ok(norm.every((b, i) => b.index === i), 'normalizeBoards assigns strict 0-based order');
ok(norm.every((b) => b.actionOrDialogue.trim().length > 0), 'normalizeBoards keeps only non-empty beats');
ok(norm.every((b) => b.durationSec >= STORYBOARD_MIN_BOARD_SEC && b.durationSec <= STORYBOARD_MAX_BOARD_SEC), 'every normalized board duration ∈ [4,6]');
ok(validateBoards(norm).length === 0, 'validateBoards: a well-formed board list has no problems (any count ≥ 1 is valid — Stage 148)');
ok(totalBoardSeconds(norm) >= 3 * norm.length, 'totalBoardSeconds sums the cut length');

// Stage 148 — a single board is now a VALID list (count is content-derived, no 12-board floor).
const oneBoard = normalizeBoards([{ actionOrDialogue: 'only one' }]);
ok(validateBoards(oneBoard).length === 0, 'validateBoards: a 1-board list is valid (no below-minimum floor — Stage 148)');
// The only count problem left is producing NO boards at all.
ok(validateBoards([]).some((p) => /at least/.test(p)), 'validateBoards flags an empty board list (need at least one)');

// duration clamp: a model over/under-shoot is pulled into [4,6]
const clamped = normalizeBoards([{ actionOrDialogue: 'x', durationSec: 99 }, { actionOrDialogue: 'y', durationSec: 1 }]);
ok(clamped[0].durationSec === STORYBOARD_MAX_BOARD_SEC && clamped[1].durationSec === STORYBOARD_MIN_BOARD_SEC, 'normalizeBoards clamps out-of-range durations into [4,6]');

// ── (C) single flowing through-line — NO 30/30 split markers ─────────────────────────────────────────────
const footage = 'SHOT 1: Opens on: a tired nurse enters a dim ward at night. She checks a sleeping patient. SHOT 2: The monitor flatlines and she fights to revive him. CLIFFHANGER: A shadow moves behind the curtain.';
const story = detailedEpisodeStory(footage);
ok(story.length > 0, 'detailedEpisodeStory produces a non-empty through-line');
for (const marker of ['SHOT 1', 'SHOT 2', 'CLIFFHANGER', 'Opens on', 'first 30', 'last 30']) {
  ok(!new RegExp(marker.replace(/\s+/g, '\\s*'), 'i').test(story), `through-line drops the "${marker}" split marker`);
}
ok(/nurse/i.test(story) && /flatlines/i.test(story), 'through-line still carries the merged story events');
// hasSplitMarkers (fresh strings each call — SPLIT_MARKER_RE is global/stateful, never reuse one string)
ok(hasSplitMarkers('the film opens on a rainy street') === true, 'hasSplitMarkers detects a split marker in raw text');
ok(hasSplitMarkers('a single continuous chase through the market') === false, 'hasSplitMarkers passes a clean through-line');
ok(!hasSplitMarkers(detailedEpisodeStory('SHOT 1: a. SHOT 2: b. CLIFFHANGER: c.')), 'derived through-line has no residual split markers');

// plain (non-footage) description: stray markers stripped, body kept
const plain = detailedEpisodeStory('A lonely barista, beat 1: she brews coffee, and later confronts her ex.');
ok(!/beat\s*1/i.test(plain) && /barista/i.test(plain), 'detailedEpisodeStory strips stray markers from a plain description');

// ── (D) board FRAME prompt — 9:16, gender-lock, eyelines, no-frontal, camera-free ────────────────────────
const cast: BoardCharacterLink[] = [
  { name: 'Mara', appearance: 'a nurse in blue scrubs', age: '32', gender: 'female', role: 'protagonist' },
  { name: 'Doctor Vane', appearance: 'a stern doctor', age: '50', gender: 'male', role: 'antagonist' },
];
const dlgFrame = buildBoardFramePrompt({
  board: { index: 3, actionOrDialogue: 'Mara says "He is crashing!" and Vane answers "Move aside."', motion: 'she leans over the bed' },
  characters: cast,
  locationName: 'Night ward',
  locationDesc: 'a dim hospital room',
});
ok(dlgFrame.aspectRatio === '9:16', 'board frame aspect ratio is 9:16');
ok(dlgFrame.prompt.includes('9:16'), 'board frame prompt text states 9:16');
ok(/clearly female/i.test(dlgFrame.prompt) && /do NOT render as a man/i.test(dlgFrame.prompt), 'board frame carries the female gender-lock (Stage 125)');
// Stage 143 (preserved invariant): only the VISIBLE cast of a board gets an identity/gender-lock line, so the
// male lock is asserted on a board where the male character (Vane) is the one in frame — not on the Mara board above.
const maleFrame = buildBoardFramePrompt({
  board: { index: 5, actionOrDialogue: 'Vane says "Move aside." and steps to the bed.', motion: 'he strides forward' },
  characters: [cast[1]],
  locationName: 'Night ward',
  locationDesc: 'a dim hospital room',
});
ok(/clearly male/i.test(maleFrame.prompt) && /do NOT render as a woman/i.test(maleFrame.prompt), 'board frame carries the male gender-lock (Stage 125) for the visible male character');
ok(/camera is NOT locked/i.test(dlgFrame.prompt) && /no fixed camera/i.test(dlgFrame.prompt), 'board frame is camera-free (never locked)');
ok(/never a flat frontal line-up/i.test(dlgFrame.prompt), 'board frame keeps the no-frontal-line-up rule');
ok(isDialogueBoard('Mara says "He is crashing!"') === true, 'isDialogueBoard detects quoted speech');

const actFrame = buildBoardFramePrompt({
  board: { index: 0, actionOrDialogue: 'Mara sprints down the corridor.', motion: 'fast dolly follow' },
  characters: [cast[0]],
  locationName: 'Corridor',
});
ok(isDialogueBoard('Mara sprints down the corridor.') === false, 'isDialogueBoard: an action beat is not dialogue');
ok(actFrame.prompt.includes('ACTION beat'), 'action board frame is labelled an ACTION beat');
ok(dlgFrame.prompt.includes('DIALOGUE beat'), 'dialogue board frame is labelled a DIALOGUE beat');

// ── (E) board MOTION prompt (image-to-video) ─────────────────────────────────────────────────────────────
const motion = buildBoardMotionPrompt({ actionOrDialogue: 'Mara revives the patient.', motion: 'chest compressions, handheld push-in' });
ok(motion.trim().length > 0, 'buildBoardMotionPrompt produces a non-empty i2v motion prompt');
ok(/3-6 second/i.test(motion), 'motion prompt targets a 3–6s clip animated from the start frame');
ok(buildBoardMotionPrompt({ actionOrDialogue: 'She turns to leave.' }).trim().length > 0, 'motion prompt falls back to the action text when no explicit motion');

// ── (F) split prompt covers whole story in as-many-as-needed ordered boards, one beat each ────────────────
const sys = storyboardBoardsSystemPrompt();
// Stage 148 — the prompt no longer asks for a fixed 12–15; the board count is content-derived.
ok(/as many/i.test(sys) && /no fixed board count/i.test(sys), 'split system prompt asks for as many boards as the content needs (no fixed count — Stage 148)');
ok(!/12-15/.test(sys) && !/12–15/.test(sys), 'split system prompt no longer hard-codes a 12–15 board target');
ok(/1 board = 1 SHOT CHANGE/i.test(sys), 'split prompt: 1 board = 1 shot change');
ok(/every 3-6 seconds/i.test(sys), 'split prompt: a shot change every 3–6s');
ok(/one physical action beat OR one pair of dialogue lines/i.test(sys), 'split prompt: each board = one action beat OR one dialogue pair (never both)');
ok(/chronological order/i.test(sys) && /WHOLE story/i.test(sys), 'split prompt: strict order covering the whole story');

// ── (G) SCENES regression — classic grammar untouched ────────────────────────────────────────────────────
ok(REFERENCE_ASPECT_RATIO === '9:16', 'regression: reference aspect ratio is still 9:16 (Stage 124)');
{
  // The Scenes keyframe/i2v ban wording must still exist in scene-prompt (only Storyboard lifts it).
  const scenePrompt = require('../lib/scene-prompt');
  ok(typeof scenePrompt.buildScenePrompt === 'function', 'regression: buildScenePrompt still present (Scenes pipeline intact)');
  ok(typeof scenePrompt.GAZE_AT_LISTENER_LINE === 'string' && scenePrompt.GAZE_AT_LISTENER_LINE.length > 0, 'regression: eyelines line still exported for Scenes');
}

console.log(`Stage 127: PASS (${passed} checks)`);
