/**
 * Stage 124 — ALL REFERENCE IMAGES GENERATED EXCLUSIVELY IN 9:16 (vertical).
 *
 * Every reference image the project produces via Seedream/WaveSpeed — character shots (front / profile /
 * full-body / extra), location master plates (wide + layout) and extra angles, region plates, and
 * artifact/object frames — must be generated in vertical 9:16, matching the 9:16 video pipeline. The
 * single source of truth is REFERENCE_ASPECT_RATIO ("9:16") in lib/visual-style.ts; seedreamImageSize
 * maps it to a vertical 1440×2560 size.
 *
 * These are pure/synthetic checks — request builders, the size mapping, the shared constant, plus a
 * source-level scan that no reference generation path still passes a non-9:16 aspect (1:1 / 3:4 / 16:9 /
 * 4:3 / auto). No network, no paid generations.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage124.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { REFERENCE_ASPECT_RATIO, VISUAL_STYLE_ID } from '../lib/visual-style';
import { seedreamImageSize, buildWaveSpeedImageRequest, WAVESPEED_SEEDREAM_T2I, WAVESPEED_SEEDREAM_EDIT } from '../lib/providers/image-provider';
import { buildRegionPlateRequest } from '../lib/region-plate';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const isVertical = (size: string) => {
  const [w, h] = size.split('*').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && h > w;
};

// ── (1) Shared constant + size mapping ──────────────────────────────────────────────────────────────
ok(REFERENCE_ASPECT_RATIO === '9:16', 'REFERENCE_ASPECT_RATIO is 9:16');
ok(seedreamImageSize(REFERENCE_ASPECT_RATIO) === '1440*2560', 'seedreamImageSize(9:16) → 1440*2560');
ok(isVertical(seedreamImageSize(REFERENCE_ASPECT_RATIO)), 'reference size is vertical (height > width)');
// A non-vertical aspect would NOT be vertical — guards the mapping itself.
ok(!isVertical(seedreamImageSize('1:1')), 'sanity: 1:1 maps to a square (not vertical)');
ok(!isVertical(seedreamImageSize('16:9')), 'sanity: 16:9 maps to landscape (not vertical)');

// ── (2) WaveSpeed request builder honours 9:16 (text-to-image + edit) ────────────────────────────────
const t2i = buildWaveSpeedImageRequest({ prompt: 'a character full-body reference', aspect_ratio: REFERENCE_ASPECT_RATIO });
ok(t2i.slug === WAVESPEED_SEEDREAM_T2I, 't2i (no refs) uses the text-to-image slug');
// Seedream v5.0 Pro takes aspect_ratio + resolution (NOT size — that's a Lite param the Pro model ignores → square).
ok(t2i.body.aspect_ratio === '9:16', 't2i body.aspect_ratio is vertical 9:16');
ok(t2i.body.resolution === '2k', 't2i body.resolution is 2k');
ok(t2i.body.size === undefined, 't2i body no longer sends size');

const REF_URL = 'https' + '://media.invalid/master.png';
const edit = buildWaveSpeedImageRequest({ prompt: 'region plate edit', aspect_ratio: REFERENCE_ASPECT_RATIO, image_input: [REF_URL] });
ok(edit.slug === WAVESPEED_SEEDREAM_EDIT, 'edit (with refs) uses the edit slug');
ok(edit.body.aspect_ratio === '9:16', 'edit body.aspect_ratio is vertical 9:16 (region plate / chained refs)');
ok(edit.body.resolution === '2k', 'edit body.resolution is 2k');
ok(edit.body.size === undefined, 'edit body no longer sends size');

// ── (3) Region plate builds an EDIT request whose call site generates in 9:16 ─────────────────────────
const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';
const location = { id: 'loc', name: 'Subway station', imageUrl: url('station-wide'), imageReverse: url('station-layout'), setInventory: 'bench; ticket machine' };
const rp = buildRegionPlateRequest({ location, regionDesc: 'the far corner by the bench' });
ok(Array.isArray(rp.image_input) && rp.image_input.length > 0, 'region plate request carries master image_input (an EDIT)');
// The edit of a 9:16 master, submitted with aspect_ratio 9:16 at the job call site, yields a 9:16 plate.
const rpReq = buildWaveSpeedImageRequest({ prompt: rp.prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, image_input: rp.image_input });
ok(rpReq.body.aspect_ratio === '9:16' && rpReq.body.resolution === '2k', 'region plate resolves to vertical 9:16 @ 2k');

// ── (4) Source-level guard: NO reference generation path passes a non-9:16 aspect ────────────────────
// Every point that calls generateImage for a REFERENCE (characters, locations, region plates, artifacts).
const REFERENCE_FILES = [
  'lib/workers/character-images-job.ts',
  'app/api/ai/characters/regenerate/route.ts',
  'app/api/ai/characters/[id]/shot/route.ts',
  'lib/workers/location-image-job.ts',
  'lib/workers/location-extra-image-job.ts',
  'app/api/ai/locations/[id]/shot/route.ts',
  'lib/workers/region-plate-job.ts',
  'lib/region-plate.ts',
  'lib/workers/artifact-images-job.ts',
  'app/api/ai/artifacts/[id]/revise/route.ts',
];
const FORBIDDEN = /aspect_ratio:\s*["'](1:1|3:4|16:9|4:3|2:3|3:2|21:9|auto)["']/;
for (const f of REFERENCE_FILES) {
  const src = read(f);
  ok(!FORBIDDEN.test(src), `no forbidden (non-9:16) aspect_ratio literal in ${f}`);
  // Each file must actually set 9:16 somewhere (directly or via the shared constant).
  ok(/aspect_ratio:\s*(REFERENCE_ASPECT_RATIO|["']9:16["'])/.test(src) || /REFERENCE_ASPECT_RATIO/.test(src) || /aspect_ratio:\s*["']9:16["']/.test(src),
    `${f} sets 9:16 for its reference generation`);
}

// ── (5) The three character shot slots (front/profile/full) are all 9:16 in each map ─────────────────
for (const f of ['lib/workers/character-images-job.ts', 'app/api/ai/characters/regenerate/route.ts', 'app/api/ai/characters/[id]/shot/route.ts']) {
  const src = read(f);
  ok(!/front:\s*["']3:4["']/.test(src) && !/profile:\s*["']3:4["']/.test(src), `${f}: front/profile are no longer 3:4`);
}

console.log(`Stage 124: PASS (${passed} checks)`);
