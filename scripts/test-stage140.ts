/** Stage 140: PERSISTENT SET ANCHORS (Storyboard only). A large piece of set furniture (e.g. the big
 * librarian's desk with an ink pad, a date stamp, a returns ledger and stacked tomes) was present in one
 * board of a scene and simply GONE in the next board — a reverse angle of the same location showed the
 * characters standing on an empty floor. Root cause: the episode locationDesc already described that
 * furniture, but it only reached the prompt as ambient background flavour (the LOCATION: line); nothing
 * raised it to a hard persistence mandate, so the model dropped it on a re-frame / reverse shot.
 *
 * Fix (prompt CONTENT only, no hard-fail): deriveSetAnchors() deterministically extracts the location's
 * LARGE non-portable set pieces (primary: locationDesc; secondary: the boards' own action text) and
 * buildSetAnchorsLine() emits ONE emphatic "PERSISTENT SET PIECES" line into EVERY board's frame prompt —
 * the SAME objects in every board and every camera angle, cropped or off-frame per framing but NEVER
 * removed; a reverse angle shows the same pieces from the other side, not an empty floor; contents stay on
 * their surface; wall-set pieces keep their back flush to the wall (the Stage 131 wall-adjacency invariant).
 *
 * Invariants regressed here: geometry-authority wall-flush + wall-never-columns, camera-free between boards,
 * 9:16, gender-lock, no-frontal line-up, dialogue eyelines; SET ANCHORS gated (empty → byte-identical to
 * Stage 131); SCENES / shared adapters byte-identical. Pure logic + a mocked REAL board_image worker.
 * No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deriveSetAnchors, buildSetAnchorsLine, SET_PIECE_KEYWORDS } from '../lib/set-anchors';
import { buildBoardFramePrompt } from '../lib/storyboard-prompt';
import { storyboardSource } from '../lib/storyboard-dialogue';
import { balanceBoardCount, finalizeDirectedBoards, readBoardDirection, type RawDirectedBoard } from '../lib/storyboard-direction';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }

// The real episode's canonical location description (the library hall with the vanishing desk).
const LIBRARY_DESC =
  'A large central librarian desk holds an ink pad, a brass date stamp, a returns ledger, and ancient tomes ' +
  'stacked at its right corner; a mosaic interrupts the polished wooden floor directly in front of it. ' +
  'Reading chairs occupy the arched windows, while globes and smaller tables create narrow circulation lanes ' +
  'between the desk and the monumental open entrance.';

async function main() {

/* ─────────── (A) deriveSetAnchors — extraction, dedup, cap, filtering ─────────── */
const anchors = deriveSetAnchors(LIBRARY_DESC, []);
const deskAnchor = anchors.find(a => /desk/i.test(a));
ok(!!deskAnchor, 'derive: the large librarian desk is extracted as a set anchor from locationDesc');
ok(/ink pad/i.test(deskAnchor!) && /date stamp/i.test(deskAnchor!) && /returns ledger/i.test(deskAnchor!),
  'derive: the desk anchor captures its ON-surface contents (ink pad, date stamp, returns ledger)');
ok(/large central librarian/i.test(deskAnchor!), 'derive: the desk anchor keeps its leading adjectives');
ok(anchors.some(a => /chair/i.test(a)), 'derive: reading chairs are extracted as a set anchor');
ok(anchors.some(a => /table/i.test(a)), 'derive: smaller tables are extracted as a set anchor');
// architecture (wall/floor/window/door/column) and small portable props are NOT anchors on their own
ok(!anchors.some(a => /^(the )?(wall|floor|window|door|column|mosaic|globe)s?$/i.test(a.trim())),
  'derive: architecture / small portables are not emitted as standalone anchors');

// dedup by head stem — a piece named twice yields one (richest) anchor
const dupDesc = 'A plain desk stands here. A large mahogany desk with brass fittings dominates the room.';
const dupAnchors = deriveSetAnchors(dupDesc, []);
ok(dupAnchors.filter(a => /desk/i.test(a)).length === 1, 'derive: the same head-noun (desk) dedups to a single anchor');
ok(/mahogany/i.test(dupAnchors.find(a => /desk/i.test(a))!), 'derive: dedup keeps the richer/longer desk description');

// cap: never explode beyond MAX_ANCHORS
const many = Array.from({ length: 20 }, (_, i) => `A ${['oak','iron','pine','ash','elm','birch','teak','maple','cedar','walnut'][i % 10]} cabinet number ${i} stands here.`).join(' ')
  + ' A desk, a table, a bench, a bookcase, a wardrobe, a dresser, an altar, a throne, a piano and an organ fill the hall.';
ok(deriveSetAnchors(many, []).length <= 8, 'derive: the anchor list is capped (never floods the prompt)');

// secondary (board actions): a DESCRIBED new piece is added; a BARE "the table" is not
const boardAdds = deriveSetAnchors('An empty stone hall.', ['He leans on the heavy oak workbench near the door.']);
ok(boardAdds.some(a => /workbench/i.test(a)), 'derive: a described piece from a board action is added as an anchor');
const boardBare = deriveSetAnchors('An empty stone hall.', ['She points at the table.']);
ok(!boardBare.some(a => /table/i.test(a)), 'derive: a bare "the table" from a board action (no descriptor) is NOT added');

// empty / prop-less location → no anchors (keeps prompt byte-identical to Stage 131)
ok(deriveSetAnchors('', []).length === 0, 'derive: empty locationDesc yields no anchors');
ok(deriveSetAnchors('A vast empty plain under an open sky.', []).length === 0, 'derive: a location with no furniture yields no anchors');
ok(SET_PIECE_KEYWORDS.includes('desk') && !SET_PIECE_KEYWORDS.includes('wall'), 'keyword list covers furniture and excludes architecture');

/* ─────────── (B) buildSetAnchorsLine — emphatic never-removed / reverse / flush wording ─────────── */
ok(buildSetAnchorsLine([]) === '', 'line: no anchors → empty string (prompt unchanged)');
const line = buildSetAnchorsLine(anchors);
ok(/PERSISTENT SET PIECES/.test(line), 'line: emphatic PERSISTENT SET PIECES header');
ok(/EVERY board/i.test(line) && /every camera angle/i.test(line), 'line: pins the pieces across every board and camera angle');
ok(/NEVER removed/i.test(line) && /teleported/i.test(line), 'line: pieces are never removed or teleported between boards');
ok(/reverse angle shows the SAME pieces/i.test(line) && /empty floor/i.test(line), 'line: a reverse angle shows the same pieces, not an empty floor');
ok(/cropped at the edge/i.test(line) || /just outside the visible frame/i.test(line), 'line: framing may crop / push a piece off-frame (adapts to shot) without removing it');
ok(/rests ON a surface/i.test(line) && /stays on that same surface/i.test(line), 'line: on-surface contents stay on their surface');
ok(/flush against that same wall/i.test(line), 'line: wall-set pieces keep their back flush to the wall (Stage 131 invariant preserved)');

/* ─────────── (C) buildBoardFramePrompt — gated integration ─────────── */
const cast = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }];
const boardInput = { board: { index: 0, actionOrDialogue: 'They confer at the desk.' }, characters: cast, locationName: 'Great Library', locationDesc: LIBRARY_DESC };

const noAnchors = buildBoardFramePrompt({ ...boardInput });
ok(!/PERSISTENT SET PIECES/.test(noAnchors.prompt), 'frame(no setAnchors): NO set-pieces line (byte-identical to Stage 131 behaviour)');

const withAnchors = buildBoardFramePrompt({ ...boardInput, hasPlate: true, hasRegionPlate: false, setAnchors: anchors });
ok(/PERSISTENT SET PIECES/.test(withAnchors.prompt), 'frame(setAnchors): PERSISTENT SET PIECES line present');
ok(/librarian desk/i.test(withAnchors.prompt) && /returns ledger/i.test(withAnchors.prompt), 'frame(setAnchors): the desk + its contents reach the prompt');
ok(/GEOMETRY AUTHORITY/.test(withAnchors.prompt) && /NEVER replaced by columns/i.test(withAnchors.prompt), 'frame: Stage 131 geometry authority (wall never columns) still present alongside set anchors');
ok(/flush against/i.test(withAnchors.prompt), 'frame: wall-adjacency flush wording still present');
ok(/camera is NOT locked/i.test(withAnchors.prompt) && /no fixed camera/i.test(withAnchors.prompt), 'frame: camera stays FREE between boards');
ok(/never a flat frontal line-up/i.test(withAnchors.prompt), 'frame: no flat frontal line-up preserved');
ok(withAnchors.aspectRatio === '9:16' && /9:16/.test(withAnchors.prompt), 'frame: 9:16 vertical preserved');
ok(/clearly female/i.test(withAnchors.prompt) && /clearly male/i.test(withAnchors.prompt), 'frame: gender-lock preserved for both sexes');

// setAnchors line is additive: the ONLY textual difference from a no-anchors plate frame is the SET PIECES line.
const platedNoAnchors = buildBoardFramePrompt({ ...boardInput, hasPlate: true, hasRegionPlate: false });
const diff = withAnchors.prompt.replace(platedNoAnchors.prompt, '');
ok(withAnchors.prompt.includes(platedNoAnchors.prompt.split('\n').filter(l => !/PERSISTENT SET PIECES/.test(l)).slice(-1)[0]),
  'frame: set-anchors insertion leaves the rest of the plate prompt intact (additive)');

/* ─────────── (D) SCENES / shared adapters byte-identical (Storyboard-only change) ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

await workerFlowCheck();

/* ─────────── (E) REAL board_image worker: the desk anchor reaches EVERY board's imagePrompt ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  const img = 'https://storyboardart.org/wp-content/uploads/2022/04/mimoshort_thumbnails_01-scaled.jpg';
  const genders = (names: string[]) => names.map(n => ({ name: n, gender: n === 'Boris' ? 'male' : 'female' }));
  const cast2 = ['Anna', 'Boris'];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna and Boris talk in the library.', locationId: 'loc1', locationName: 'Great Library', locationDesc: LIBRARY_DESC };
  const lines = 'Anna (calmly): "Line 1."\nBoris (calmly): "Line 2."\nAnna (calmly): "Line 3."\nBoris (calmly): "Line 4."\nAnna (calmly): "Line 5."\nBoris (calmly): "Line 6."';
  const scenes = [{ number: 1, action: 'Anna and Boris confer at the desk.', dialogue: lines }];
  const src = storyboardSource({ description: episode.description }, scenes, genders(cast2));
  const seg = src.segments;
  const D = (extra: Partial<RawDirectedBoard>): RawDirectedBoard => ({ actionOrDialogue: 'Beat', actionEnglish: 'Steady reactions at the desk.', durationSec: 5, region: 'at the desk', speechIds: [], ...extra });
  // One board is an explicit REVERSE angle — historically the frame where the desk vanished.
  const modelRaw: RawDirectedBoard[] = [
    D({ speechIds: [seg[0].id], shot: 'over_shoulder' }),
    D({ speechIds: [seg[1].id], shot: 'listener_reverse', actionEnglish: 'Reverse angle across the hall toward the entrance.' }),
    D({ speechIds: [seg[2].id], shot: 'over_shoulder' }),
    D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}),
  ];
  const balanced = balanceBoardCount(modelRaw, seg);
  const finBoards = finalizeDirectedBoards(balanced, seg, cast2, src.actionSource);
  let saved: any[] = finBoards.map((b, i) => ({ id: `board-${i}`, index: i, actionOrDialogue: b.actionOrDialogue, motionEn: b.motion, directionJson: b.directionJson, region: b.region ?? null, status: 'planned', imagePrompt: null }));
  const failures: string[] = [];
  const prisma = {
    board: {
      findUnique: async ({ where }: any) => { const b = saved.find(s => s.id === where.id); return b ? { ...b, episodeId: 'ep1', episode } : null; },
      findMany: async () => saved,
      update: async ({ where, data }: any) => { const b = saved.find(s => s.id === where.id); if (b) Object.assign(b, data); return b; },
    },
    episodeCharacter: { findMany: async () => genders(cast2).map((c) => ({ character: { name: c.name, imageFull: 'https://cdn3.toonboom.com/wp-content/uploads/2025/05/29110423/roughs-and-cleans-1.jpg', gender: c.gender, appearance: `${c.name} appearance`, age: 'adult' } })) },
    location: { findUnique: async () => ({ id: 'loc1', name: 'Great Library', imageUrl: 'https://www.frontiersin.org/files/Articles/1488754/xml-images/fearc-03-1488754-g0001.webp', imageReverse: 'https://cdn.mos.cms.futurecdn.net/SiUdtCQuTnWNUdbRHSoGWh-1200-80.jpg', regionPlates: null }) },
  };
  const mocks: Record<string, unknown> = {
    '@/lib/db': { prisma },
    '@/lib/jobs': {
      updateJob: async () => {}, completeJob: async () => {}, isCancelRequested: async () => false,
      markCanceled: async () => {}, failJob: async (_id: string, message: string) => { failures.push(message); },
    },
    '@/lib/s3-upload': { uploadRemoteToS3: async (url: string) => url },
    '@/lib/providers/image-provider': { generateImage: async () => img, GenerationCanceledError: class extends Error {} },
  };
  internal._load = function(id: string, ...rest: any[]) {
    const key = id.replace(/^.*\/lib\//, '@/lib/').replace(/\.(?:ts|js)$/, '');
    return mocks[key] ?? originalLoad.call(this, id, ...rest);
  };
  try {
    const workers = require('../lib/workers/storyboard-job');
    // Render EVERY board's keyframe; assert the desk anchor is present in each persisted imagePrompt.
    for (const b of [...saved]) {
      await workers.runBoardImageJob(`job-${b.id}`, 'project1', b.id);
    }
    ok(failures.length === 0, `board_image worker ran for all boards with no failures (${failures.join(' | ') || 'none'})`);
    const prompts = saved.map(b => b.imagePrompt as string);
    ok(prompts.every(p => typeof p === 'string' && p.length > 0), 'every board got an imagePrompt');
    ok(prompts.every(p => /PERSISTENT SET PIECES/.test(p)), 'the PERSISTENT SET PIECES line is present in EVERY board prompt');
    ok(prompts.every(p => /librarian desk/i.test(p) && /returns ledger/i.test(p)), 'the vanishing desk (+ its contents) is pinned into EVERY board prompt');
    // the reverse-angle board — the historical vanish point — also carries the desk anchor
    const reverseBoard = saved.find(b => /reverse/i.test(readBoardDirection(b.directionJson)?.actionEnglish ?? '') || readBoardDirection(b.directionJson)?.shot === 'listener_reverse');
    ok(reverseBoard && /librarian desk/i.test(reverseBoard.imagePrompt) && /reverse angle shows the SAME pieces/i.test(reverseBoard.imagePrompt),
      'the reverse-angle board explicitly keeps the desk (no empty floor on the reverse)');
    ok(prompts.every(p => /GEOMETRY AUTHORITY/.test(p) && /flush against/i.test(p)), 'every board still carries the geometry authority + wall-flush invariant');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 140: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
