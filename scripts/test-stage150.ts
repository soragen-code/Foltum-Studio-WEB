/**
 * Stage 150 — two fixes to the emitted video-clip prompt system:
 *
 *  (1) RESET-TO-AUTO REBUILDS VIA THE LIVE BUILDER. When a scene's manual promptOverride is cleared
 *      (reset to "auto"), the produced prompt must be REBUILT from scratch by the current buildScenePrompt
 *      rules — NOT the stale manually-edited text. Proven here by comparing the override path (verbatim,
 *      no auto modules) against the reset path (override=null → fresh auto assembly with current-rule
 *      markers: ASCII-only / no Cyrillic, neutralised [TRANSITION], the conditional direction modules).
 *      (The PUT /api/ai/scenes/[id]/prompt route additionally drops lookCache/lookStale on reset so the
 *       character-look rewrite is recomputed on top of the freshly rebuilt auto prompt — see route.ts.)
 *
 *  (2) PROXEMICS FOR A SHORT LINE IN PASSING (Scene-3 bug). A character who walks up to point-blank
 *      range and freezes the hero just to say ONE short line is unnatural — real people keep moving and
 *      call the line over the shoulder. A conditional PASSING_SHORT_LINE_DIRECTION module is emitted ONLY
 *      for the passing-short-line case (isPassingShortLine); normal stationary dialogue is unaffected.
 *
 * Pure/synthetic checks only — the two directive strings, the isPassingShortLine heuristic, and
 * buildScenePrompt wiring. No network, no LLM, no DB, no paid generations.
 * Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage150.ts
 */
import {
  buildScenePrompt,
  isPassingShortLine,
  PASSING_SHORT_LINE_DIRECTION,
  SHORT_LINE_MAX_WORDS,
  SINGLE_SPEAKER_DIRECTION,
  GAZE_AT_LISTENER_LINE,
  NEUTRAL_TRANSITION_LINE,
} from '../lib/scene-prompt';
import { VISUAL_STYLE_ID } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';
const hasCyrillic = (s: string) => /[\u0400-\u04FF]/.test(s);

const characters = [
  { characterId: 'c1', name: 'Kara', imageFull: url('kara'), appearance: 'grey coat', tier: 'MAIN' },
  { characterId: 'c2', name: 'Merek', imageFull: url('merek'), appearance: 'dark jacket', tier: 'MAIN' },
];
const location = {
  id: 'loc', name: 'Kitchen',
  imageUrl: url('kitchen-wide'), imageReverse: url('kitchen-layout'),
  setInventory: 'long table — center; chipped white mug — on the table, left side',
};

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 *  (1) RESET-TO-AUTO REBUILDS VIA THE LIVE BUILDER
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

// A single-speaker scene (so the auto path emits SINGLE_SPEAKER_DIRECTION) with a scripted [TRANSITION]
// that would describe the next shot (so the auto path must neutralise it).
const STALE_MARKER = 'STALE_MANUAL_MARKER_XYZ_do_not_reuse';
const baseScene = {
  id: 's1', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  continuesFrom: 'new-sequence',
  videoPrompt: '[SHOT TYPE]: medium\n[ACTION]: Kara stands by the window.\n[CHARACTER]: Kara\n[TRANSITION]: cut to Merek arriving at the door next shot',
  dialogue: 'KARA: "I never stopped waiting for this moment to arrive."',
  action: 'Kara stands by the window, still.',
  startState: 'WORLD: kitchen. Kara frame-left by the window. NOT IN FRAME: Merek. CAMERA: medium',
  endState: 'Kara lowers her gaze.',
} as any;

// --- override present: the producer's manual text is emitted verbatim, WITHOUT the auto modules. -----------
const staleOverride =
  `${STALE_MARKER}\n[SHOT TYPE]: hand-authored\n[ACTION]: старый ручной промпт (Cyrillic manual text).`;
const overriddenScene = { ...baseScene, promptOverride: staleOverride } as any;
const builtOverride = buildScenePrompt({ scene: overriddenScene, characters, location, previous: null } as any);
ok(builtOverride.hasOverride === true, 'override: hasOverride is true when promptOverride is set');
ok(builtOverride.prompt.includes(STALE_MARKER), 'override: the emitted prompt carries the manual marker verbatim');
ok(!builtOverride.prompt.includes(SINGLE_SPEAKER_DIRECTION),
  'override: the auto SINGLE_SPEAKER_DIRECTION module is NOT appended to a manual override');
ok(!hasCyrillic(builtOverride.prompt),
  'override: even a manual override is transliterated to ASCII on emit (Stage 149 finalize)');

// --- reset to auto (promptOverride = null): rebuild from scratch via the current buildScenePrompt rules. ---
const resetScene = { ...baseScene, promptOverride: null } as any;
const builtReset = buildScenePrompt({ scene: resetScene, characters, location, previous: null } as any);
ok(builtReset.hasOverride === false, 'reset: hasOverride is false after clearing the override');
ok(!builtReset.prompt.includes(STALE_MARKER),
  'reset: the rebuilt auto prompt does NOT equal / reuse the stale manual text');
ok(builtReset.prompt !== builtOverride.prompt,
  'reset: the auto prompt differs from the previously overridden prompt');
ok(builtReset.prompt.includes(SINGLE_SPEAKER_DIRECTION),
  'reset: current-rule marker present — SINGLE_SPEAKER_DIRECTION module rebuilt (Stage 149 modular gating)');
ok(builtReset.prompt.includes(NEUTRAL_TRANSITION_LINE),
  'reset: current-rule marker present — scripted [TRANSITION] neutralised (Stage 149)');
ok(!hasCyrillic(builtReset.prompt),
  'reset: current-rule marker present — emitted prompt is ASCII-only, no Cyrillic (Stage 149)');
ok(!/NOT\s+IN\s+FRAME/i.test(builtReset.prompt),
  'reset: current-rule marker present — the "NOT IN FRAME" roster clause is stripped (Stage 149)');

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 *  (2) PROXEMICS FOR A SHORT LINE IN PASSING
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

// --- the directive string ---------------------------------------------------------------------------------
ok(/PROXEMICS \(short line in passing\)/.test(PASSING_SHORT_LINE_DIRECTION),
  'PASSING_SHORT_LINE_DIRECTION: names the short-line-in-passing proxemics rule');
ok(/does NOT close to point-blank range/i.test(PASSING_SHORT_LINE_DIRECTION) &&
   /does NOT stop to stand face-to-face/i.test(PASSING_SHORT_LINE_DIRECTION),
  'PASSING_SHORT_LINE_DIRECTION: forbids closing to point-blank and stopping face-to-face for the line');
ok(/over the shoulder or after them/i.test(PASSING_SHORT_LINE_DIRECTION) &&
   /keep moving/i.test(PASSING_SHORT_LINE_DIRECTION),
  'PASSING_SHORT_LINE_DIRECTION: the speaker keeps moving and calls the line over the shoulder');
ok(/does NOT freeze into a face-off/i.test(PASSING_SHORT_LINE_DIRECTION) &&
   /point-blank convergence/i.test(PASSING_SHORT_LINE_DIRECTION),
  'PASSING_SHORT_LINE_DIRECTION: the other character does not freeze / no forced point-blank convergence');
// CRITICAL: no camera-lock language (regression guard, consistent with Stage 126).
ok(!/camera is fixed|locked camera|static camera|do not move the camera|no camera movement|keep the same camera angle|same framing/i.test(PASSING_SHORT_LINE_DIRECTION),
  'PASSING_SHORT_LINE_DIRECTION: contains NO camera-lock language');

// --- isPassingShortLine heuristic -------------------------------------------------------------------------
ok(isPassingShortLine({ dialogue: 'KARA: "Not now."', action: 'Kara walks past Merek toward the door.' }) === true,
  'isPassingShortLine: TRUE for a short single line while walking past');
ok(isPassingShortLine({ dialogue: 'KARA: "Catch you later."', action: 'Kara strides past without stopping.' }) === true,
  'isPassingShortLine: TRUE for a short line with "strides past" / "without stopping"');
ok(isPassingShortLine({ dialogue: 'KARA: "Later."', videoPrompt: '[ACTION]: Kara passes by on her way out.' }) === true,
  'isPassingShortLine: TRUE reading passing motion from the videoPrompt');
// FALSE cases
ok(isPassingShortLine({ dialogue: 'KARA: "You stayed."\nMEREK: "I did."', action: 'Kara walks past Merek.' }) === false,
  'isPassingShortLine: FALSE for a multi-line exchange (not a single line)');
ok(isPassingShortLine({ dialogue: 'KARA: "I never stopped waiting for this exact moment to arrive here today."', action: 'Kara walks past Merek.' }) === false,
  'isPassingShortLine: FALSE for a long single line (over the word threshold)');
ok(isPassingShortLine({ dialogue: 'KARA: "Not now."', action: 'Kara stops and turns to Merek.' }) === false,
  'isPassingShortLine: FALSE when the beat is an explicit stop-to-talk');
ok(isPassingShortLine({ dialogue: 'KARA: "Not now."', action: 'Kara faces Merek across the table.' }) === false,
  'isPassingShortLine: FALSE for a short line with NO passing/walking evidence (stationary)');
ok(isPassingShortLine({ dialogue: '', action: 'Kara walks past Merek.' }) === false,
  'isPassingShortLine: FALSE with no dialogue at all');
ok(SHORT_LINE_MAX_WORDS >= 3 && SHORT_LINE_MAX_WORDS <= 10,
  'SHORT_LINE_MAX_WORDS: conservative small word threshold');

// --- buildScenePrompt integration: PRESENT for a passing short line ---------------------------------------
const passingScene = {
  id: 'sp', number: 3, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  continuesFrom: 'new-sequence',
  videoPrompt: '[SHOT TYPE]: tracking medium\n[ACTION]: Kara walks past Merek toward the door.\n[CHARACTER]: Kara\n[TRANSITION]: cut',
  dialogue: 'KARA: "Not now, Merek."',
  action: 'Kara walks past Merek toward the door without stopping.',
  startState: 'WORLD: kitchen. Kara mid-stride. CAMERA: tracking medium',
  endState: 'Kara reaches the door.',
} as any;
const builtPassing = buildScenePrompt({ scene: passingScene, characters, location, previous: null } as any).prompt;
ok(builtPassing.includes(PASSING_SHORT_LINE_DIRECTION),
  'scene: PASSING_SHORT_LINE_DIRECTION is emitted for a short line delivered while passing');

// --- buildScenePrompt integration: ABSENT for normal stationary multi-line dialogue -----------------------
const stationaryScene = {
  id: 'ss', number: 4, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  continuesFrom: 'new-sequence',
  videoPrompt: '[SHOT TYPE]: medium two-shot\n[ACTION]: Kara faces Merek across the table.\n[TRANSITION]: cut',
  dialogue: 'KARA: "You stayed."\nMEREK: "I did."',
  action: 'Kara faces Merek across the table, both standing still.',
  startState: 'WORLD: kitchen. Kara frame-left, Merek frame-right. CAMERA: medium two-shot',
  endState: 'They hold each other\'s gaze.',
} as any;
const builtStationary = buildScenePrompt({ scene: stationaryScene, characters, location, previous: null } as any).prompt;
ok(!builtStationary.includes(PASSING_SHORT_LINE_DIRECTION),
  'scene: PASSING_SHORT_LINE_DIRECTION is ABSENT for normal stationary multi-line dialogue');
ok(builtStationary.includes(GAZE_AT_LISTENER_LINE),
  'scene: regression — two-party stationary dialogue still emits EYELINES CONNECT');

console.log(`Stage 150: PASS (${passed} checks)`);
