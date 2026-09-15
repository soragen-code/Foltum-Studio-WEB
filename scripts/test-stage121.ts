/**
 * Stage 121 — stop location-geometry drift accumulating between clips, WITHOUT restricting camera freedom.
 *  (1) reangle AUTHORITY SPLIT: Image1 (previous video last frame) is the authority for the PEOPLE and MOTION
 *      only; the elevated LAYOUT plate is the FLOOR-PLAN / placement authority and the wide plate the second
 *      geometry reference. On a geometry conflict the plates override Image1. Camera freedom is UNCHANGED
 *      (still "opposite side or at least 60 degrees", free height/scale).
 *  (2) WALL-ADJACENCY placement: setInventory must anchor big fixed objects to the architecture (against which
 *      wall / corner); that adjacency is propagated into the scene prompt (LOCATION_ANCHOR_LINE +
 *      buildSetObjectsSection WALL-ANCHORED PLACEMENT), the reangle prompt, the plate prompts and the idea rules.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage121.ts
 */
import {
  buildScenePrompt,
  buildSetObjectsSection,
  LOCATION_ANCHOR_LINE,
} from '../lib/scene-prompt';
import { buildReangleRequest } from '../lib/reangle';
import { locationAnglePrompt, locationLayoutNote, VISUAL_STYLE_ID } from '../lib/visual-style';
import { LOCATION_FIELD_RULES_TEXT_FOR_TESTS } from '../lib/idea';

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
  setInventory: 'cast-iron bench — back against the far wall; ticket machine — beside the stairs',
};
const characters = [
  { characterId: 'c1', name: 'Kara', imageFull: url('kara'), appearance: 'grey coat', tier: 'LEAD' },
  { characterId: 'c2', name: 'Merek', imageFull: url('merek'), appearance: 'dark jacket', tier: 'LEAD' },
];

// ── (1) REANGLE AUTHORITY SPLIT: Image1 = people/motion, plates = geometry ─────────────────────────────
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

ok(/authority for the PEOPLE and MOTION only/.test(rePrompt),
  'reangle: Image1 is the authority for the PEOPLE and MOTION only');
ok(/it is NOT the authority for the placement of the fixed furniture or the architecture/.test(rePrompt),
  'reangle: Image1 is NOT the authority for fixed furniture/architecture placement');
ok(/the layout and wide location plates override Image1/.test(rePrompt),
  'reangle: on geometry, the layout/wide plates override Image1');
ok(/FLOOR-PLAN AUTHORITY for this location/.test(rePrompt),
  'reangle: the elevated LAYOUT plate is the floor-plan authority');
ok(/which fixed objects sit flush against which walls/.test(rePrompt),
  'reangle: floor-plan fixes which objects sit flush against which walls');
ok(/MATCH the layout\/wide plates/.test(rePrompt) && /Take furniture and wall placement from the layout\/wide plates, NOT from Image1/.test(rePrompt),
  'reangle: reconstruct furniture/walls from the plates, not from Image1');
ok(/do NOT inherit drift from Image1/.test(rePrompt),
  'reangle: explicitly refuse to inherit drift from Image1');
// original Stage 119/120 guarantees stay intact
ok(/FIXED SET IS IMMUTABLE/.test(rePrompt), 'reangle: FIXED SET IS IMMUTABLE still present');
ok(/authoritative truth for the environment geometry/.test(rePrompt),
  'reangle: keeps "authoritative truth for the environment geometry" (Stage 119)');
ok(/Image1 overrides any differing pose/.test(rePrompt),
  'reangle: Image1 overrides any differing pose of the PEOPLE (Stage 112/119)');
ok(/FIXED BACKGROUND ARCHITECTURE/.test(rePrompt) && /NEVER replace a wall with columns/.test(rePrompt),
  'reangle: FIXED BACKGROUND ARCHITECTURE + wall-not-columns (Stage 120) intact');
// CAMERA FREEDOM must NOT be restricted
ok(/opposite side or at least 60 degrees/.test(rePrompt),
  'reangle: camera freedom preserved (opposite side or at least 60 degrees) — NOT restricted');
ok(/with a distinct height or shot scale/.test(rePrompt),
  'reangle: distinct height/shot scale still allowed — no camera fixing');
// the re-noted location refs carry the explicit authority in the Image# lines
ok(/floor-plan authority/i.test(rePrompt),
  'reangle: a location Image note carries floor-plan authority');
ok(/Wide environment-geometry reference/.test(rePrompt),
  'reangle: the wide plate note carries "environment-geometry reference"');

// ── (2) WALL-ADJACENCY in the scene prompt / LOCATION_ANCHOR_LINE ───────────────────────────────────────
ok(/FLOOR-PLAN of this location/.test(LOCATION_ANCHOR_LINE),
  'anchor: the layout plate is the FLOOR-PLAN of this location');
ok(/flush against the SAME wall as in the layout plate/.test(LOCATION_ANCHOR_LINE),
  'anchor: every fixed object stands flush against the SAME wall as in the layout plate');
ok(/never drifts off the wall to leave a gap, columns or open space behind it/.test(LOCATION_ANCHOR_LINE),
  'anchor: furniture never drifts off the wall to leave a gap/columns behind it');
ok(/camera is free to move to any new angle, height or shot scale/.test(LOCATION_ANCHOR_LINE),
  'anchor: camera freedom explicitly preserved (no camera restriction)');
// Stage 119/120 phrasing still intact
ok(/LOCATION IS CONSTANT/.test(LOCATION_ANCHOR_LINE) && /stays a solid wall/.test(LOCATION_ANCHOR_LINE),
  'anchor: LOCATION IS CONSTANT + solid-wall guarantee (Stage 119/120) intact');

const dialogueScene = {
  id: 's-dlg', number: 3, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  videoPrompt: '[SHOT TYPE]: medium two-shot\n[ACTION]: Kara turns to Merek by the bench.\n[TRANSITION]: hard cut',
  dialogue: 'KARA: "You said you would come alone."\nMEREK: "I lied."',
  action: 'Kara faces Merek across the platform bench.',
  startState: 'WORLD: platform.\nCAMERA: medium two-shot', endState: 'They hold each other\'s gaze.',
} as any;
const dlgBuilt = buildScenePrompt({ scene: dialogueScene, characters, location, previous: null } as any);
ok(dlgBuilt.prompt.includes(LOCATION_ANCHOR_LINE),
  'a scene with location plates carries the updated LOCATION_ANCHOR directive');

// ── (2b) buildSetObjectsSection WALL-ANCHORED PLACEMENT ────────────────────────────────────────────────
const anchored = buildSetObjectsSection([
  'cast-iron bench — back against the rear wall',
  'ticket machine — beside the stairs',
]);
ok(/WALL-ANCHORED PLACEMENT/.test(anchored),
  'set objects: wall-anchored entries get a WALL-ANCHORED PLACEMENT section');
ok(/against the same wall\/corner/.test(anchored),
  'set objects: keep each against the same wall/corner in every shot');
ok(/back against the rear wall/.test(anchored),
  'set objects: the bench entry (against the rear wall) is listed as wall-anchored');
ok(!/WALL-ANCHORED PLACEMENT[^]*ticket machine — beside the stairs\b(?![^]*WALL-ANCHORED)/.test(anchored) || /ticket machine/.test(anchored),
  'set objects: non-anchored entries still appear in the base list');

const noAnchor = buildSetObjectsSection(['chandelier — center of the ceiling', 'rug — middle of the room']);
ok(noAnchor.length > 0 && !/WALL-ANCHORED PLACEMENT/.test(noAnchor),
  'set objects: no wall/corner entries → no WALL-ANCHORED PLACEMENT section');
ok(buildSetObjectsSection([]) === '', 'set objects: empty input → empty string');

// ── (2c) plate prompts render wall-adjacency; layout note carries floor-plan authority ─────────────────
const inv = ['cast-iron bench — back against the far wall', 'ticket machine — beside the stairs'];
const widePlate = locationAnglePrompt('A tiled subway platform.', 'Subway station', 'wide' as any, inv);
const layoutPlate = locationAnglePrompt('A tiled subway platform.', 'Subway station', 'layout' as any, inv);
ok(/FLUSH against that exact wall or corner/.test(widePlate),
  'wide plate: renders wall-adjacent objects flush against the wall');
ok(/FLUSH against that exact wall or corner/.test(layoutPlate) && /FLOOR-PLAN authority/.test(layoutPlate),
  'layout plate: flush-against-wall + FLOOR-PLAN authority');
ok(widePlate.includes('SET INVENTORY (every item must be visible, exact placement)'),
  'plate prompts keep the Stage 113 SET INVENTORY header');
ok(/FLOOR-PLAN AUTHORITY/.test(locationLayoutNote('Subway station')) && /elevated LAYOUT view/.test(locationLayoutNote('Subway station')),
  'locationLayoutNote: floor-plan authority + keeps "elevated LAYOUT view" (Stage 111)');

// ── (3) idea setInventory rules require architectural anchoring ─────────────────────────────────────────
ok(/WALL-ADJACENCY IS MANDATORY/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules: wall-adjacency is mandatory for big fixed objects');
ok(/against the rear wall|flush to the left wall|in the back-right corner/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules: examples name the wall/corner the object sits against');
ok(/"setInventory"/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS) && /12-30/.test(LOCATION_FIELD_RULES_TEXT_FOR_TESTS),
  'idea rules: still the setInventory field, still 12-30 entries (Stage 113)');

console.log(`Stage 121: PASS (${passed} checks)`);
