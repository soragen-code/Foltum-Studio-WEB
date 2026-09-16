/**
 * Stage 131 — stabilize the LOCATION across STORYBOARD boards (pure/synthetic checks).
 *
 * Fixes the "location floats between boards" bug: board frames were generated from the location TEXT only,
 * with no visual authority, so furniture / architecture / materials / lighting drifted board-to-board. This
 * stage ports the SCENES stabilization (Stage 122): each board binds to a zone of the ONE episode location
 * and shares a GEOMETRY AUTHORITY plate — a per-zone REGION PLATE when a cached one exists, otherwise the
 * location MASTER plates (wide + layout). All boards of the same authority render an IDENTICAL room; only the
 * action/pose and the (still FREE) camera change. STORYBOARD only — SCENES is untouched.
 *
 * These checks are PURE (no network, no LLM, no DB, no paid generations):
 *   - the board-plate selector (region vs master authority, identity across boards, text-only fallback)
 *   - the board FRAME prompt gains the GEOMETRY AUTHORITY block when a plate is attached (region wording when a
 *     region plate leads), keeps wall-adjacency + camera-free + 9:16 + gender-lock, and is UNCHANGED with no plate
 *   - the board split carries a per-zone region + normalized regionKey; the split prompt/JSON hint request it
 *   - the worker attaches the authority plate(s) + persists plateUrl/region/regionKey
 *   - SCENES regression: the scene grammar/exports are untouched
 *
 * Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage131.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  normalizeBoards,
  validateBoards,
  STORYBOARD_BOARDS_JSON_HINT,
  storyboardBoardsSystemPrompt,
  detailedEpisodeStory,
  type RawBoard,
} from '../lib/storyboard';
import {
  buildBoardFramePrompt,
  type BoardCharacterLink,
} from '../lib/storyboard-prompt';
import {
  pickBoardGeometryAuthority,
  sameGeometryAuthority,
  type BoardLocationPlates,
} from '../lib/board-plate';
import { deriveRegionKey, putRegionPlate } from '../lib/region-plate';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const ROOT = join(__dirname, '..');
const cast: BoardCharacterLink[] = [
  { name: 'Anna', appearance: 'young woman, red coat', age: '28', gender: 'female', role: 'lead', tier: 'main' },
  { name: 'Boris', appearance: 'older man, grey suit', age: '55', gender: 'male', role: 'support', tier: 'main' },
];

// ── (A) board-plate selector: master authority ───────────────────────────────────────────────────────────
const masters: BoardLocationPlates = {
  id: 'loc1', name: 'Kitchen',
  imageUrl: 'https://images.wondershare.com/edrawmax/articles2025/kitchen-layout-example/template-one.png',
  imageReverse: 'https://www.maytag.com/is/image/content/dam/business-unit/maytag/en-us/marketing-content/site-assets/page-content/oc-articles/what-is-the-kitchen-triangle-rule/what-is-the-kitchen-triangle-rule-image3.jpg?fmt=png-alpha&qlt=85,0&resMode=sharp2&op_usm=1.75,0.3,2,0&scl=1&constrain=fit,1',
  regionPlates: null,
};
const aMaster = pickBoardGeometryAuthority(masters, 'by the window');
ok(aMaster.hasPlate === true, 'selector: master plates present → hasPlate=true');
ok(aMaster.hasRegionPlate === false, 'selector: no cached region plate → hasRegionPlate=false');
ok(aMaster.plateUrls[0] === masters.imageUrl && aMaster.plateUrls.includes(masters.imageReverse as string), 'selector: master authority = [wide, layout]');
ok(aMaster.primaryUrl === masters.imageUrl, 'selector: master primaryUrl = wide plate');

// ── (B) board-plate selector: region authority (cached region plate) ─────────────────────────────────────
const regionUrl = 'https://i.ytimg.com/vi/SY8KiGAVyrM/maxresdefault.jpg';
const withRegion: BoardLocationPlates = {
  ...masters,
  regionPlates: putRegionPlate(null, 'by the window', regionUrl),
};
const aRegion = pickBoardGeometryAuthority(withRegion, 'by the window');
ok(aRegion.hasRegionPlate === true, 'selector: cached region plate for the zone → hasRegionPlate=true');
ok(aRegion.primaryUrl === regionUrl, 'selector: region primaryUrl = the region plate');
ok(aRegion.plateUrls[0] === regionUrl, 'selector: region plate leads plateUrls (masters kept behind)');
ok(aRegion.plateUrls.includes(masters.imageUrl as string), 'selector: masters retained as backing geometry truth');

// ── (C) selector: text-only fallback when no location / no plates ────────────────────────────────────────
const none = pickBoardGeometryAuthority(null, 'by the window');
ok(none.hasPlate === false && none.primaryUrl === null && none.plateUrls.length === 0, 'selector: no location → text-only fallback (hasPlate=false)');
const empty = pickBoardGeometryAuthority({ id: 'x', imageUrl: null, imageReverse: null, regionPlates: null }, null);
ok(empty.hasPlate === false, 'selector: location without plates → hasPlate=false');

// ── (D) cross-board location identity ────────────────────────────────────────────────────────────────────
const b1 = pickBoardGeometryAuthority(masters, 'by the window');
const b2 = pickBoardGeometryAuthority(masters, 'at the counter'); // different zone, but only masters exist
ok(sameGeometryAuthority(b1, b2) === true, 'identity: two boards of the same location (master-only) share ONE authority');
const r1 = pickBoardGeometryAuthority(withRegion, 'by the window');
const r2 = pickBoardGeometryAuthority(withRegion, 'by the window');
ok(sameGeometryAuthority(r1, r2) === true, 'identity: two boards of the same zone share the same region plate');
const otherLoc = pickBoardGeometryAuthority({ ...masters, id: 'loc2', imageUrl: 'https://www.yumpu.com/en/image/facebook/52552324.jpg' }, 'by the window');
ok(sameGeometryAuthority(b1, otherLoc) === false, 'identity: a different location resolves to a DIFFERENT authority');

// ── (E) board frame prompt: GEOMETRY AUTHORITY block gated by hasPlate ────────────────────────────────────
const boardInput = { board: { index: 0, actionOrDialogue: 'Anna: "Are you ready?"', motion: null }, characters: cast, locationName: 'Kitchen', locationDesc: 'a small bright kitchen' };
const noPlate = buildBoardFramePrompt({ ...boardInput });
const withPlate = buildBoardFramePrompt({ ...boardInput, hasPlate: true, hasRegionPlate: false });
const withRegionPlate = buildBoardFramePrompt({ ...boardInput, hasPlate: true, hasRegionPlate: true });

ok(!/GEOMETRY AUTHORITY/.test(noPlate.prompt), 'frame(no plate): NO geometry block (Stage 127 behaviour unchanged)');
ok(/GEOMETRY AUTHORITY/.test(withPlate.prompt), 'frame(plate): GEOMETRY AUTHORITY block present');
ok(/location is constant across boards/i.test(withPlate.prompt), 'frame(plate): asserts the location is constant across boards');
ok(/ABSOLUTE/.test(withPlate.prompt), 'frame(plate): plate is the ABSOLUTE authority');
ok(/NEVER replaced by columns/i.test(withPlate.prompt), 'frame(plate): wall never replaced by columns');
ok(/flush against/i.test(withPlate.prompt), 'frame(plate): wall-set furniture stays flush against the wall');
ok(!/REGION PLATE IS THE PRIMARY/.test(withPlate.prompt), 'frame(master plate): no region-plate wording when only masters lead');
ok(/REGION PLATE IS THE PRIMARY ENVIRONMENT AUTHORITY/.test(withRegionPlate.prompt), 'frame(region plate): region-plate primary-authority wording present');
ok(/GEOMETRY AUTHORITY/.test(withRegionPlate.prompt), 'frame(region plate): master geometry block also present (backing truth)');

// camera freedom + 9:16 + gender-lock preserved WITH the new block
ok(/camera is NOT locked/i.test(withPlate.prompt) && /no fixed camera/i.test(withPlate.prompt), 'frame(plate): camera stays FREE (not locked, no fixed camera)');
ok(/never a flat frontal line-up/i.test(withPlate.prompt), 'frame(plate): no flat frontal line-up preserved');
ok(withPlate.aspectRatio === '9:16' && /9:16/.test(withPlate.prompt), 'frame(plate): 9:16 vertical preserved');
ok(/woman/i.test(withPlate.prompt) && /man/i.test(withPlate.prompt), 'frame(plate): gender-lock wording present for both sexes');

// ── (F) board split carries region + normalized regionKey ────────────────────────────────────────────────
const raw: RawBoard[] = Array.from({ length: 13 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}`,
  motion: 'subject moves; slow push-in',
  durationSec: 5,
  region: i < 6 ? 'By The Window' : 'at the counter',
}));
const norm = normalizeBoards(raw);
ok(validateBoards(norm).length === 0, 'split: 13 boards with regions validate cleanly');
ok(norm[0].region === 'By The Window' && norm[0].regionKey === deriveRegionKey('By The Window'), 'split: board carries region + normalized regionKey');
ok(norm[0].regionKey === norm[5].regionKey, 'split: identical region wording → identical regionKey (shared plate)');
ok(norm[0].regionKey !== norm[6].regionKey, 'split: different zones → different regionKey');
const noRegion = normalizeBoards([{ actionOrDialogue: 'Beat', motion: null, durationSec: 5 }]);
ok(noRegion[0].region === null && noRegion[0].regionKey === null, 'split: absent region → null region + null regionKey (optional, no regression)');
ok(/region/i.test(STORYBOARD_BOARDS_JSON_HINT), 'split: JSON hint requests a per-board region');
ok(/zone|corner/i.test(storyboardBoardsSystemPrompt()), 'split: system prompt instructs naming the zone/corner');
ok(detailedEpisodeStory('SHOT 1: opens on a door. SHOT 2: it closes.').length > 0, 'split: detailedEpisodeStory still merges the through-line (unchanged)');

// ── (G) worker wiring (grep — the worker attaches the authority + persists it) ───────────────────────────
const worker = readFileSync(join(ROOT, 'lib/workers/storyboard-job.ts'), 'utf8');
ok(/import \{ pickBoardGeometryAuthority \} from "@\/lib\/board-plate"/.test(worker), 'worker: imports pickBoardGeometryAuthority');
ok(/pickBoardGeometryAuthority\(location, board\.region\)/.test(worker), 'worker: resolves authority from the bound Location + board region');
ok(/hasPlate: authority\.hasPlate/.test(worker) && /hasRegionPlate: authority\.hasRegionPlate/.test(worker), 'worker: passes the geometry-authority flags to the frame prompt');
ok(/\[\.\.\.refImages, \.\.\.authority\.plateUrls\]/.test(worker), 'worker: attaches plate(s) as image_input after character refs');
ok(/plateUrl: authority\.primaryUrl/.test(worker), 'worker: persists the chosen plate on the board');
ok(/region: b\.region/.test(worker) && /regionKey: b\.regionKey/.test(worker), 'worker: persists region + regionKey when creating boards');
ok(!/buildBoardMotionPrompt[\s\S]*startImageToVideoGeneration[\s\S]*image_input/.test(worker), 'worker: i2v (runBoardVideoJob) untouched — no plate injected into the animation');

// ── (H) SCENES untouched ─────────────────────────────────────────────────────────────────────────────────
const scenePrompt = readFileSync(join(ROOT, 'lib/scene-prompt.ts'), 'utf8');
ok(/export const LOCATION_ANCHOR_LINE/.test(scenePrompt), 'SCENES: LOCATION_ANCHOR_LINE still exported');
ok(/export const REGION_PLATE_ANCHOR_LINE/.test(scenePrompt), 'SCENES: REGION_PLATE_ANCHOR_LINE still exported');
ok(/buildScenePrompt/.test(scenePrompt), 'SCENES: buildScenePrompt still present');
const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
ok(/regionPlates String\?/.test(schema), 'SCENES: Location.regionPlates cache still present');

console.log(`Stage 131: PASS (${passed} checks)`);
