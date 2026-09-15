/**
 * Stage 119 — location continuity anchor: stop the environment/location drifting between clips.
 *  1) The master location plates (wide + layout) are NON-DROPPABLE references in every clip: even under the
 *     reference cap, background-crowd extras are trimmed first while both location plates always survive.
 *  2) The video prompt carries a LOCATION_ANCHOR directive: the fixed set (bench/seating, floor, columns, walls,
 *     fixtures, large props) is IDENTICAL across shots — no swapping a solid cast bench for a perforated one, etc.
 *  3) buildSetObjectsSection wording marks the set objects as FIXED / immutable across shots.
 *  4) The re-angle (Seedream Edit) prompt requires the fixed set to be reconstructed IDENTICALLY from the plates.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage119.ts
 */
import {
  buildScenePrompt,
  buildSetObjectsSection,
  LOCATION_ANCHOR_LINE,
} from '../lib/scene-prompt';
import { buildReangleRequest } from '../lib/reangle';
import { VISUAL_STYLE_ID } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';

// ── (a) master location plates are non-droppable; background crowds trimmed first at the cap ──────────
const location = {
  id: 'loc', name: 'Subway station',
  imageUrl: url('station-wide'), imageReverse: url('station-layout'),
  setInventory: 'cast-iron bench — against the far wall; ticket machine — beside the stairs',
};
// 25 named leads + 2 location plates = 27 non-droppable anchors; 10 background crowds are droppable.
const leads = Array.from({ length: 25 }, (_, i) => ({
  characterId: 'c' + i, name: 'Lead' + i, imageFull: url('lead' + i),
  appearance: 'plain clothes', tier: 'SUPPORT',
}));
const bgCrowds = Array.from({ length: 10 }, (_, i) => ({
  characterId: 'g' + i, name: 'commuter group ' + i, imageFull: url('crowd' + i),
  appearance: 'commuters', tier: 'CROWD',
}));
const dialogueScene = {
  id: 's-cap', number: 2, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  videoPrompt: '[SHOT TYPE]: medium\n[ACTION]: The leads wait on the platform by the cast-iron bench.\n[TRANSITION]: cut',
  dialogue: 'LEAD0: "The train is late again."',
  action: 'The leads stand near the cast-iron bench on the platform.',
  startState: 'WORLD: platform.\nCAMERA: medium', endState: 'The leads wait.',
} as any;
const capBuilt = buildScenePrompt({ scene: dialogueScene, characters: [...leads, ...bgCrowds], location, previous: null } as any);

const locRefs = capBuilt.fallbackRefs.filter(r => r.kind === 'location');
ok(locRefs.length === 2, `both master location plates survive the cap (${locRefs.length} location refs)`);
ok(capBuilt.fallbackRefs.length <= 30, `reference set respects the cap (${capBuilt.fallbackRefs.length} <= 30)`);
const bgInFallback = capBuilt.fallbackRefs.filter(r => r.kind === 'crowd').length;
ok(bgInFallback < bgCrowds.length,
  `background crowds are trimmed first, not the location plates (${bgInFallback} of ${bgCrowds.length} crowds kept)`);
ok(capBuilt.retryRefs.filter(r => r.kind === 'location').length === 2,
  'retryRefs also always carry both location plates');

// ── (b) the video prompt carries the LOCATION_ANCHOR directive ───────────────────────────────────────
ok(typeof LOCATION_ANCHOR_LINE === 'string' && LOCATION_ANCHOR_LINE.length > 0,
  'LOCATION_ANCHOR_LINE is exported');
ok(/LOCATION IS CONSTANT/.test(LOCATION_ANCHOR_LINE), 'anchor line: location is constant');
ok(/SAME bench/.test(LOCATION_ANCHOR_LINE) && /SAME floor/.test(LOCATION_ANCHOR_LINE),
  'anchor line: same bench / same floor');
ok(/solid cast bench into a perforated one/.test(LOCATION_ANCHOR_LINE),
  'anchor line: names the exact drift (solid cast → perforated bench)');
ok(/the room itself is constant/.test(LOCATION_ANCHOR_LINE), 'anchor line: only camera + actions change');
ok(capBuilt.prompt.includes(LOCATION_ANCHOR_LINE),
  'a scene with location plates carries the LOCATION_ANCHOR directive in the prompt body');

// a scene without a location must NOT get the anchor line (no plates to anchor to)
const noLocBuilt = buildScenePrompt({ scene: dialogueScene, characters: leads, location: null, previous: null } as any);
ok(!noLocBuilt.prompt.includes(LOCATION_ANCHOR_LINE),
  'no location → no anchor line (nothing to anchor to)');

// ── (c) buildSetObjectsSection marks the set objects as FIXED / immutable ─────────────────────────────
const setSection = buildSetObjectsSection(['cast-iron bench — against the far wall', 'ticket machine — beside the stairs']);
ok(/FIXED objects/.test(setSection), 'set section: objects are FIXED objects of the location');
ok(/IDENTICAL/.test(setSection), 'set section: keep each one IDENTICAL');
ok(/do not swap/.test(setSection) && /rearrange/.test(setSection),
  'set section: do not swap / restyle / rearrange them');
ok(setSection.includes('cast-iron bench'), 'set section: lists the actual inventory objects');

// ── (d) the re-angle (Seedream Edit) prompt requires an identical fixed set ───────────────────────────
const predecessor = {
  id: 'p1', number: 1, videoUrl: url('prev-video'), lastFrameUrl: url('prev-frame'),
  status: 'generated', endStateActual: 'CAMERA: wide static',
};
const reReq = buildReangleRequest({
  sceneId: 's2', number: 2, startState: 'CAMERA: low angle', videoPrompt: '[SHOT TYPE]: low angle',
  previous: predecessor as any,
  refs: [
    { url: url('station-wide'), kind: 'location', note: 'wide location plate' },
    { url: url('station-layout'), kind: 'location', note: 'layout location plate' },
  ] as any,
});
ok(/FIXED SET IS IMMUTABLE/.test((reReq.body.prompt as string)), 're-angle prompt: fixed set is immutable header');
ok(/reconstructed IDENTICALLY/.test((reReq.body.prompt as string)), 're-angle prompt: fixed set reconstructed identically');
ok(/solid cast bench into a perforated one/.test((reReq.body.prompt as string)),
  're-angle prompt: names the exact substitution to avoid');
ok(/only the CAMERA moves/.test((reReq.body.prompt as string)), 're-angle prompt: only the camera moves');
ok(/authoritative truth for the environment geometry/.test((reReq.body.prompt as string)),
  're-angle prompt: wide/layout plates are the authoritative environment geometry');
// the original camera-only guarantees remain intact
ok(/CAMERA-ONLY EDIT of Image1/.test((reReq.body.prompt as string)), 're-angle prompt: still a camera-only edit of Image1');
ok(/Image1 overrides any differing pose/.test((reReq.body.prompt as string)),
  're-angle prompt: Image1 still authoritative for people / poses / light');

console.log(`Stage 119: PASS (${passed} checks)`);
