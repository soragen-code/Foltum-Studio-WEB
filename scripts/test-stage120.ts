/**
 * Stage 120 — four targeted prompt/UI edits:
 *  (B) GAZE: in a dialogue shot the speaker looks AT the addressed listener and the listener looks back
 *      (eyelines connect), via turning head/eyes, NEVER frontal-to-camera, NEVER a static face-to-face
 *      stand-off. Present in scene-prompt.ts (GAZE_AT_LISTENER_LINE) and in season.ts PACE_DIRECTION.
 *  (C) LOCATION: forbid inventing/substituting background architecture — a wall stays a wall, never replaced
 *      by columns/pillars/passage/opening/escalator/open space, never add structure not on the plates.
 *      Present in scene-prompt.ts (LOCATION_ANCHOR_LINE) and in reangle.ts (FIXED BACKGROUND ARCHITECTURE).
 *  (D) ACTION CONTINUES ACROSS THE CUT: on a continuing seam the motion is not reset — it continues from the
 *      same phase/direction with the same items in the same hands, no restart/pause/freeze, no skipped action,
 *      dialogue may continue, transition stays a HARD CUT (no fade). Present in scene-prompt.ts.
 *  (A) UI-only (removed the "last frame" button in episode-view.tsx) — covered by tsc / next build, not here.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage120.ts
 */
import {
  buildScenePrompt,
  GAZE_AT_LISTENER_LINE,
  ACTION_CONTINUES_ACROSS_CUT_LINE,
  LOCATION_ANCHOR_LINE,
} from '../lib/scene-prompt';
import { buildReangleRequest } from '../lib/reangle';
import { PACE_DIRECTION } from '../lib/season';
import { VISUAL_STYLE_ID } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';

const location = {
  id: 'loc', name: 'Subway station',
  imageUrl: url('station-wide'), imageReverse: url('station-layout'),
  setInventory: 'cast-iron bench — against the far wall; ticket machine — beside the stairs',
};
const characters = [
  { characterId: 'c1', name: 'Kara', imageFull: url('kara'), appearance: 'grey coat', tier: 'LEAD' },
  { characterId: 'c2', name: 'Merek', imageFull: url('merek'), appearance: 'dark jacket', tier: 'LEAD' },
];

// ── (B) GAZE: eyelines connect in a dialogue shot ─────────────────────────────────────────────────────
ok(typeof GAZE_AT_LISTENER_LINE === 'string' && GAZE_AT_LISTENER_LINE.length > 0,
  'GAZE_AT_LISTENER_LINE is exported');
ok(/EYELINES CONNECT/.test(GAZE_AT_LISTENER_LINE), 'gaze line: EYELINES CONNECT header');
ok(/looks AT the person they address/.test(GAZE_AT_LISTENER_LINE), 'gaze line: speaker looks AT the addressed');
ok(/looks back at the speaker/.test(GAZE_AT_LISTENER_LINE), 'gaze line: listener looks back');
ok(/NEVER have anyone turn to face the viewer/.test(GAZE_AT_LISTENER_LINE),
  'gaze line: never frontal to camera (no Stage 116 conflict)');
ok(/static, symmetrical face-to-face stand-off/.test(GAZE_AT_LISTENER_LINE),
  'gaze line: no static face-to-face stand-off');

const dialogueScene = {
  id: 's-dlg', number: 3, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  videoPrompt: '[SHOT TYPE]: medium two-shot\n[ACTION]: Kara turns to Merek by the bench.\n[TRANSITION]: hard cut',
  dialogue: 'KARA: "You said you would come alone."\nMEREK: "I lied."',
  action: 'Kara faces Merek across the platform bench.',
  startState: 'WORLD: platform.\nCAMERA: medium two-shot', endState: 'They hold each other\'s gaze.',
} as any;
const dlgBuilt = buildScenePrompt({ scene: dialogueScene, characters, location, previous: null } as any);
ok(dlgBuilt.prompt.includes(GAZE_AT_LISTENER_LINE),
  'a dialogue scene carries the GAZE (eyelines connect) directive in the prompt body');

// a narration scene (no dialogue) must NOT get the gaze line
const narrationScene = { ...dialogueScene, id: 's-nar', sceneKind: 'narration', dialogue: '' } as any;
const narBuilt = buildScenePrompt({ scene: narrationScene, characters, location, previous: null } as any);
ok(!narBuilt.prompt.includes(GAZE_AT_LISTENER_LINE), 'a narration scene does NOT get the gaze line');

// season.ts PACE_DIRECTION carries both the anti-static-frontal-duel prohibition AND the eyeline requirement
ok(/never two people simply standing face to face talking/.test(PACE_DIRECTION),
  'PACE_DIRECTION keeps the anti-static face-to-face prohibition');
ok(/never a static, symmetrical face-to-face stand-off/.test(PACE_DIRECTION),
  'PACE_DIRECTION forbids a static symmetrical face-to-face stand-off');
ok(/EYELINES:/.test(PACE_DIRECTION) && /LOOKS AT the person they are addressing/.test(PACE_DIRECTION),
  'PACE_DIRECTION requires the speaker to look at the addressed character');
ok(/the listener looks back at the speaker/.test(PACE_DIRECTION),
  'PACE_DIRECTION: the listener looks back (eyelines connect)');
ok(/NEVER by both turning frontally to the camera/.test(PACE_DIRECTION),
  'PACE_DIRECTION: never achieve eyelines by turning frontally to the camera');

// ── (C) LOCATION: no invented/substituted background architecture ─────────────────────────────────────
ok(/stays a solid wall/.test(LOCATION_ANCHOR_LINE), 'anchor line: a solid wall stays a solid wall');
ok(/NEVER replaced by columns, pillars, a passage/.test(LOCATION_ANCHOR_LINE),
  'anchor line: never replace a wall with columns/pillars/passage');
ok(/not present in the location plates/.test(LOCATION_ANCHOR_LINE),
  'anchor line: never add structure not present in the plates');
ok(/reconstruct it strictly from the plates/.test(LOCATION_ANCHOR_LINE),
  'anchor line: reveal occluded surfaces strictly from the plates');
ok(dlgBuilt.prompt.includes(LOCATION_ANCHOR_LINE),
  'a scene with location plates still carries the LOCATION_ANCHOR directive');

const predecessor = {
  id: 'p1', number: 2, videoUrl: url('prev-video'), lastFrameUrl: url('prev-frame'),
  status: 'generated', endStateActual: 'WORLD: platform, Kara mid-turn.\nCAMERA: wide',
};
const reReq = buildReangleRequest({
  sceneId: 's4', number: 4, startState: 'CAMERA: low angle', videoPrompt: '[SHOT TYPE]: low angle',
  previous: predecessor as any,
  refs: [
    { url: url('station-wide'), kind: 'location', note: 'wide location plate' },
    { url: url('station-layout'), kind: 'location', note: 'layout location plate' },
  ] as any,
});
const rePrompt = reReq.body.prompt as string;
ok(/FIXED BACKGROUND ARCHITECTURE/.test(rePrompt), 're-angle prompt: FIXED BACKGROUND ARCHITECTURE header');
ok(/stays a solid wall/.test(rePrompt), 're-angle prompt: a solid wall stays a solid wall');
ok(/NEVER replace a wall with columns/.test(rePrompt),
  're-angle prompt: never replace a wall with columns');
ok(/not present in the location plates/.test(rePrompt),
  're-angle prompt: never add structure not present in the plates');
// the original FIXED SET guarantees remain intact
ok(/FIXED SET IS IMMUTABLE/.test(rePrompt), 're-angle prompt: FIXED SET IS IMMUTABLE still present');

// ── (D) ACTION CONTINUES ACROSS THE CUT on a continuing seam ─────────────────────────────────────────
ok(typeof ACTION_CONTINUES_ACROSS_CUT_LINE === 'string' && ACTION_CONTINUES_ACROSS_CUT_LINE.length > 0,
  'ACTION_CONTINUES_ACROSS_CUT_LINE is exported');
ok(/ACTION CONTINUES ACROSS THE CUT/.test(ACTION_CONTINUES_ACROSS_CUT_LINE),
  'action line: ACTION CONTINUES ACROSS THE CUT header');
ok(/same motion phase/i.test(ACTION_CONTINUES_ACROSS_CUT_LINE), 'action line: same motion phase');
ok(/same items in the same hands/.test(ACTION_CONTINUES_ACROSS_CUT_LINE),
  'action line: same items in the same hands');
ok(/Do NOT restart/.test(ACTION_CONTINUES_ACROSS_CUT_LINE), 'action line: do not restart the action');
ok(/do NOT pause, freeze or reset/.test(ACTION_CONTINUES_ACROSS_CUT_LINE),
  'action line: do not pause/freeze/reset');
ok(/HARD CUT with no fade/.test(ACTION_CONTINUES_ACROSS_CUT_LINE) && /never a fade/.test(ACTION_CONTINUES_ACROSS_CUT_LINE),
  'action line: transition stays a hard cut, never a fade');

const continuingScene = {
  id: 's-cont', number: 3, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  continuesFrom: 'same-location-continuation',
  videoPrompt: '[SHOT TYPE]: low wide\n[ACTION]: Kara keeps turning as she speaks.\n[TRANSITION]: hard cut',
  dialogue: 'KARA: "Then we do it now."',
  action: 'Kara continues her turn from the previous shot.',
  startState: 'WORLD: platform, Kara mid-turn.\nCAMERA: low wide', endState: 'Kara faces Merek.',
} as any;
const contBuilt = buildScenePrompt({ scene: continuingScene, characters, location, previous: predecessor as any } as any);
ok(contBuilt.prompt.includes(ACTION_CONTINUES_ACROSS_CUT_LINE),
  'a continuing seam carries the ACTION CONTINUES ACROSS THE CUT directive');

// a fresh (non-continuing) scene with no previous must NOT get the action-continues line
ok(!dlgBuilt.prompt.includes(ACTION_CONTINUES_ACROSS_CUT_LINE),
  'a scene with no previous does NOT get the action-continues line');

console.log(`Stage 120: PASS (${passed} checks)`);
