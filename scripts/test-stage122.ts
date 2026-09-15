/**
 * Stage 122 — SCENE REGION PLATES: pre-generate a separate ENVIRONMENT reference of the specific part of the
 * location where a scene happens (a controlled Seedream EDIT of the master LAYOUT plate — "move the camera to
 * frame THIS part of the location" while preserving all master geometry) and pass it as the PRIMARY
 * geometry/background reference into that scene's video clips and its camera re-angle. The last-frame re-angle
 * STAYS but only carries people/motion continuity. No camera restriction; region plate is NOT a keyframe.
 *
 *  (1) buildRegionPlateRequest: controlled camera-move EDIT of the master plates, preserves geometry, no people,
 *      forbids add/remove furniture and wall→columns, imposes NO camera restriction, throws without inputs.
 *  (2) cache helpers: deriveRegionKey / regionPlateCacheKey / resolveRegionPlate / putRegionPlate (reuse).
 *  (3) buildScenePrompt with regionPlateUrl: the plate leads the location tier (primary env authority), masters
 *      kept, REGION_PLATE_ANCHOR_LINE replaces LOCATION_ANCHOR_LINE (no double env block), camera free, no keyframe.
 *  (4) buildReangleRequest with regionPlateUrl: region ref (kind "region") after state_source, region line added,
 *      Stage 121 guarantees intact; WITHOUT it the prompt is byte-identical to Stage 121 (cache-stable).
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage122.ts
 */
import {
  buildScenePrompt,
  LOCATION_ANCHOR_LINE,
  REGION_PLATE_ANCHOR_LINE,
  REGION_PLATE_NOTE,
} from '../lib/scene-prompt';
import { buildReangleRequest } from '../lib/reangle';
import {
  buildRegionPlateRequest,
  deriveRegionKey,
  regionPlateCacheKey,
  resolveRegionPlate,
  putRegionPlate,
} from '../lib/region-plate';
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
  setInventory: 'cast-iron bench — back against the far wall; ticket machine — beside the stairs',
};
const characters = [
  { characterId: 'c1', name: 'Kara', imageFull: url('kara'), appearance: 'grey coat', tier: 'LEAD' },
  { characterId: 'c2', name: 'Merek', imageFull: url('merek'), appearance: 'dark jacket', tier: 'LEAD' },
];

// ── (1) buildRegionPlateRequest — controlled camera-move EDIT of the master plates ──────────────────────
const region = 'the far corner by the cast-iron bench';
const req = buildRegionPlateRequest({ location, regionDesc: region });
ok(req.base === location.imageReverse,
  'region plate: base of the edit is the master LAYOUT plate (imageReverse) when present');
ok(req.image_input[0] === location.imageReverse && req.image_input.includes(location.imageUrl),
  'region plate: image_input leads with the layout plate and also includes the wide plate as geometry truth');
ok(new Set(req.image_input).size === req.image_input.length,
  'region plate: image_input is de-duplicated');
ok(typeof req.slug === 'string' && !!req.body && typeof (req.body as any).prompt === 'string',
  'region plate: returns a WaveSpeed image request (slug + body.prompt)');
ok(req.prompt.includes('move the camera to frame THIS part of the location'),
  'region plate: prompt is a controlled camera re-frame ("move the camera to frame THIS part of the location")');
ok(req.prompt.includes(region),
  'region plate: prompt names the requested region');
ok(/SAME walls/.test(req.prompt) && /SAME fixed furniture at the SAME places/.test(req.prompt),
  'region plate: prompt preserves the same walls and the same fixed furniture placement');
ok(/FLUSH against that same wall/.test(req.prompt),
  'region plate: wall-adjacent furniture stays flush against its wall');
ok(/Do NOT add, remove, resize, restyle, duplicate or rearrange any furniture/.test(req.prompt),
  'region plate: forbids adding/removing/rearranging furniture');
ok(/do NOT replace a wall with columns, pillars, a passage, an archway, an opening, a doorway, a window, an escalator or open space/.test(req.prompt),
  'region plate: forbids replacing a wall with columns/openings/etc.');
ok(/no people/.test(req.prompt),
  'region plate: EMPTY SET — no people');
ok(/cast-iron bench/.test(req.prompt) && /ticket machine/.test(req.prompt),
  'region plate: the location set inventory is reinforced in the prompt');
// NO camera restriction is imposed by the plate (it fixes environment only).
ok(!/do not move the camera|camera is fixed|locked camera|static camera|no camera movement/i.test(req.prompt),
  'region plate: NO camera restriction imposed (environment-only edit)');
ok((req.body as any).size === '1440*2560' && Array.isArray((req.body as any).images) && (req.body as any).images.length === req.image_input.length,
  'region plate: request is a vertical 9:16 (1440*2560) Seedream edit carrying the image_input as body.images');
// base falls back to the wide plate when the layout is missing
const reqNoLayout = buildRegionPlateRequest({ location: { id: 'loc', imageUrl: url('w'), imageReverse: null }, regionDesc: region });
ok(reqNoLayout.base === url('w'),
  'region plate: base falls back to the WIDE plate when the layout plate is absent');
// throws without a region description or without any master plate
let threwNoRegion = false;
try { buildRegionPlateRequest({ location, regionDesc: '   ' }); } catch { threwNoRegion = true; }
ok(threwNoRegion, 'region plate: throws when no region description is given');
let threwNoPlate = false;
try { buildRegionPlateRequest({ location: { id: 'x', imageUrl: null, imageReverse: null }, regionDesc: region }); } catch { threwNoPlate = true; }
ok(threwNoPlate, 'region plate: throws when the location has no master plate to edit from');

// ── (2) cache helpers — reuse across scenes in the same region ──────────────────────────────────────────
ok(deriveRegionKey('The Far Corner, by the Bench!') === deriveRegionKey('the far corner by the bench'),
  'cache: deriveRegionKey normalizes case/punctuation so matching wording shares a key');
ok(deriveRegionKey('the far corner by the bench') !== deriveRegionKey('the stairs landing'),
  'cache: different regions produce different keys');
ok(deriveRegionKey('   ') === '', 'cache: blank region → empty key');
ok(regionPlateCacheKey('loc', region) === `loc::${deriveRegionKey(region)}`,
  'cache: regionPlateCacheKey combines locationId + normalized region');
ok(regionPlateCacheKey('loc', '  ') === '', 'cache: blank region → empty cache key');
const stored = putRegionPlate(null, region, url('region-far-corner'));
ok(resolveRegionPlate(stored, region) === url('region-far-corner'),
  'cache: putRegionPlate → resolveRegionPlate round-trips the URL');
ok(resolveRegionPlate(stored, 'THE Far Corner, by the CAST-IRON Bench!') === url('region-far-corner'),
  'cache: a matching (differently-cased/punctuated) region resolves the same cached plate — reuse');
ok(resolveRegionPlate(stored, 'the stairs landing') === null,
  'cache: a different region is a cache miss');
const two = putRegionPlate(stored, 'the stairs landing', url('region-stairs'));
ok(resolveRegionPlate(two, region) === url('region-far-corner') && resolveRegionPlate(two, 'the stairs landing') === url('region-stairs'),
  'cache: multiple regions coexist in the same location cache');
ok(resolveRegionPlate('not json', region) === null,
  'cache: malformed cache JSON resolves to null (tolerant)');

// ── (3) buildScenePrompt WITH a region plate — primary environment authority ────────────────────────────
const scene = {
  id: 's-dlg', number: 3, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
  videoPrompt: '[SHOT TYPE]: medium two-shot\n[ACTION]: Kara turns to Merek by the bench.\n[TRANSITION]: hard cut',
  dialogue: 'KARA: "You said you would come alone."\nMEREK: "I lied."',
  action: 'Kara faces Merek by the bench.',
  startState: 'WORLD: platform.\nCAMERA: medium two-shot', endState: 'They hold each other\'s gaze.',
} as any;
const regionUrl = url('region-far-corner');
const withPlate = buildScenePrompt({ scene, characters, location, previous: null, regionPlateUrl: regionUrl } as any);
ok(withPlate.referenceImages.includes(regionUrl),
  'scene+plate: the region plate is attached as a reference image');
// region plate leads the location tier: before the master wide/layout plates
const idxRegion = withPlate.referenceImages.indexOf(regionUrl);
const idxWide = withPlate.referenceImages.indexOf(location.imageUrl);
const idxLayout = withPlate.referenceImages.indexOf(location.imageReverse);
ok(idxRegion >= 0 && idxWide >= 0 && idxLayout >= 0 && idxRegion < idxWide && idxRegion < idxLayout,
  'scene+plate: the region plate leads the location tier (before the master wide/layout plates)');
ok(withPlate.retryRefs.some((r: any) => r.url === regionUrl && r.note === REGION_PLATE_NOTE),
  'scene+plate: the region plate ref carries REGION_PLATE_NOTE');
// masters are NOT dropped
ok(withPlate.referenceImages.includes(location.imageUrl) && withPlate.referenceImages.includes(location.imageReverse),
  'scene+plate: the master wide/layout plates are still attached (not dropped)');
// characters still lead the whole list (leads before the location tier)
ok(withPlate.referenceImages.indexOf(url('kara')) < idxRegion,
  'scene+plate: character leads still come before the region plate');
// the region anchor line REPLACES the master anchor line (no double environment block)
ok(withPlate.prompt.includes(REGION_PLATE_ANCHOR_LINE),
  'scene+plate: REGION_PLATE_ANCHOR_LINE is present in the prompt');
ok(!withPlate.prompt.includes(LOCATION_ANCHOR_LINE),
  'scene+plate: LOCATION_ANCHOR_LINE is NOT also present (region line replaces it — no double env block)');
ok(/camera is free to move to any angle, height or shot scale/.test(REGION_PLATE_ANCHOR_LINE),
  'scene+plate: the region anchor line preserves camera freedom (no restriction)');
ok(/take the PEOPLE and MOTION from it but take the BACKGROUND, LAYOUT and GEOMETRY from this region plate/.test(REGION_PLATE_ANCHOR_LINE),
  'scene+plate: when a re-angle frame is also attached, people/motion come from it but geometry from the region plate');
ok(/does NOT impose any character's pose/.test(REGION_PLATE_ANCHOR_LINE) && /it is NOT the camera angle/.test(REGION_PLATE_ANCHOR_LINE),
  'scene+plate: the region plate is NOT a keyframe (no pose, not the camera angle)');
// no keyframe / first-frame was produced
ok(withPlate.referenceKind === 'character_references',
  'scene+plate: still a reference-mode submission (no first-frame keyframe returned)');

// ── (3b) buildScenePrompt WITHOUT a region plate — Stage 121 fallback ───────────────────────────────────
const noPlate = buildScenePrompt({ scene, characters, location, previous: null } as any);
ok(noPlate.prompt.includes(LOCATION_ANCHOR_LINE) && !noPlate.prompt.includes(REGION_PLATE_ANCHOR_LINE),
  'scene−plate: falls back to LOCATION_ANCHOR_LINE, no region anchor line');
ok(!noPlate.retryRefs.some((r: any) => r.note === REGION_PLATE_NOTE),
  'scene−plate: no region plate reference is attached');

// ── (3c) region plate not duplicated when it collides with the re-angle frame / is forbidden ────────────
const collide = buildScenePrompt({ scene, characters, location, previous: null, reangleUrl: regionUrl, regionPlateUrl: regionUrl } as any);
ok(collide.retryRefs.filter((r: any) => r.url === regionUrl).length === 1,
  'scene: a region plate equal to the re-angle URL is not attached twice');
const forbiddenPlate = buildScenePrompt({ scene, characters, location, previous: null, regionPlateUrl: regionUrl, forbiddenReferenceUrls: [regionUrl] } as any);
ok(!forbiddenPlate.retryRefs.some((r: any) => r.url === regionUrl),
  'scene: a forbidden region plate URL is not attached');

// ── (4) buildReangleRequest WITH a region plate — primary environment authority, people from Image1 ──────
const predecessor = {
  id: 'p1', number: 2, videoUrl: url('prev-video'), lastFrameUrl: url('prev-frame'),
  status: 'generated', endStateActual: 'WORLD: platform, Kara mid-turn.\nCAMERA: wide',
};
const supportRefs = [
  { url: url('station-wide'), kind: 'location', note: 'wide location plate' },
  { url: url('station-layout'), kind: 'location', note: 'layout location plate' },
];
const reReqPlate = buildReangleRequest({
  sceneId: 's4', number: 4, startState: 'CAMERA: low angle', videoPrompt: '[SHOT TYPE]: low angle',
  previous: predecessor as any, refs: supportRefs as any, regionPlateUrl: regionUrl,
});
const rePromptPlate = reReqPlate.body.prompt as string;
ok(reReqPlate.refs[0].kind === 'state_source',
  'reangle+plate: Image1 (previous last frame) is still the first reference (state source)');
ok(reReqPlate.refs[1].kind === 'region' && reReqPlate.refs[1].url === regionUrl,
  'reangle+plate: the region plate is the second reference (kind "region"), before the master plates');
ok(reReqPlate.refs.slice(2).every((r: any) => r.kind === 'location'),
  'reangle+plate: the master location plates follow the region plate');
ok(/REGION PLATE IS THE PRIMARY ENVIRONMENT AUTHORITY/.test(rePromptPlate),
  'reangle+plate: the prompt names the region plate as the PRIMARY environment authority');
ok(/take the background, walls, floor, columns, fixtures and the fixed furniture placement from the region plate FIRST/.test(rePromptPlate),
  'reangle+plate: geometry is taken from the region plate first, never from Image1');
ok(/authority for the PEOPLE and MOTION only/.test(rePromptPlate),
  'reangle+plate: Image1 still owns the PEOPLE and MOTION only (Stage 121 split intact)');
ok(/FIXED SET IS IMMUTABLE/.test(rePromptPlate) && /NEVER replace a wall with columns/.test(rePromptPlate),
  'reangle+plate: Stage 119/120 guarantees (fixed set immutable + wall→columns) still present');
ok(/opposite side or at least 60 degrees/.test(rePromptPlate),
  'reangle+plate: camera freedom preserved (no camera restriction)');

// ── (4b) buildReangleRequest WITHOUT a region plate — byte-identical to Stage 121 (cache-stable) ─────────
const reReqNo = buildReangleRequest({
  sceneId: 's4', number: 4, startState: 'CAMERA: low angle', videoPrompt: '[SHOT TYPE]: low angle',
  previous: predecessor as any, refs: supportRefs as any,
});
const reReqBaseline = buildReangleRequest({
  sceneId: 's4', number: 4, startState: 'CAMERA: low angle', videoPrompt: '[SHOT TYPE]: low angle',
  previous: predecessor as any, refs: supportRefs as any, regionPlateUrl: '',
});
const rePromptNo = reReqNo.body.prompt as string;
ok(!/REGION PLATE IS THE PRIMARY ENVIRONMENT AUTHORITY/.test(rePromptNo),
  'reangle−plate: no region line is added when there is no region plate');
ok(reReqNo.refs.length === 3 && reReqNo.refs[0].kind === 'state_source' && reReqNo.refs[1].kind === 'location',
  'reangle−plate: refs are exactly [state_source, ...location plates] (no region ref)');
ok(reReqNo.hash === reReqBaseline.hash,
  'reangle−plate: an empty regionPlateUrl produces the same request (byte-identical, cache-stable)');
// A blank region equal to the predecessor last frame must not be treated as a region plate.
const reReqSameAsFrame = buildReangleRequest({
  sceneId: 's4', number: 4, startState: 'CAMERA: low angle', videoPrompt: '[SHOT TYPE]: low angle',
  previous: predecessor as any, refs: supportRefs as any, regionPlateUrl: predecessor.lastFrameUrl,
});
ok(reReqSameAsFrame.hash === reReqNo.hash,
  'reangle: a region plate equal to Image1 is ignored (no duplicate reference)');

console.log(`Stage 122: PASS (${passed} checks)`);
