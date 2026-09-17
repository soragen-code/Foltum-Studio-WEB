/** Stage 142: SCENE ANCHOR FRAME (Storyboard only). Every board of a scene used to be an INDEPENDENT Seedream
 * call (character refs + location plates only), so the dressed set — the big library desk — changed shape /
 * position or vanished between adjacent boards, and bodies were fused into the desktop. The Stage 140 text
 * mandate (PERSISTENT SET PIECES) could not pin geometry. Fix: the first successfully rendered board of a scene
 * becomes the scene ANCHOR and is attached as an IMAGE reference (after character refs, before plates) to every
 * later board of that scene, named in the prompt ("SCENE ANCHOR FRAME (reference image N)"); boards of one scene
 * render strictly in order (a board waits for a lower-index sibling still rendering); if the first fails the next
 * successful one becomes the anchor; a BODY / FURNITURE SEPARATION rule is added to EVERY board.
 * Pure logic + a mocked REAL board_image worker. No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  boardSceneKey, pickSceneAnchor, renderingLowerSiblings, composeBoardImageInput, buildSceneAnchorLine, BOARD_BODY_FURNITURE_LINE,
  type AnchorSibling,
} from '../lib/board-anchor';
import { buildBoardFramePrompt } from '../lib/storyboard-prompt';
import { WAVESPEED_IMAGE_MAX_REFS } from '../lib/providers/image-provider';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
const u = (n: string) => ["https:/", "boards.s3.amazonaws.com", `${n}.png`].join("/");

async function main() {

/* ─────────── (A) scene key + anchor pick + sequential wait (pure) ─────────── */
ok(boardSceneKey({ episodeId: 'ep1', locationId: 'loc1' }) === 'ep1|loc1', 'sceneKey: episode × location');
ok(boardSceneKey({ episodeId: 'ep1', locationId: null }) === 'ep1|episode', 'sceneKey: no bound location → episode-level key');
ok(boardSceneKey({ episodeId: 'ep1', locationId: 'loc1' }) !== boardSceneKey({ episodeId: 'ep2', locationId: 'loc1' }), 'sceneKey: different episodes never share');

const K = 'ep1|loc1';
const sib = (id: string, index: number, imageUrl: string | null, status: string, sceneKey = K): AnchorSibling => ({ id, index, imageUrl, status, sceneKey });
const scene3 = [sib('b0', 0, u('f0'), 'frame_ready'), sib('b1', 1, u('f1'), 'frame_ready'), sib('b2', 2, null, 'pending')];
ok(pickSceneAnchor({ id: 'b0', index: 0, sceneKey: K }, scene3) === null, 'pick: board 1 (first of the scene) has NO anchor — it becomes the anchor');
ok(pickSceneAnchor({ id: 'b1', index: 1, sceneKey: K }, scene3)?.anchorBoardId === 'b0', 'pick: board 2 anchors on board 1');
const a2 = pickSceneAnchor({ id: 'b2', index: 2, sceneKey: K }, scene3);
ok(a2?.anchorBoardId === 'b0' && a2.anchorUrl === u('f0') && a2.anchorIndex === 0, 'pick: board 3 anchors on board 1 (lowest rendered), not board 2');
// first board failed (no imageUrl) → the next successful board is the anchor
const failedFirst = [sib('b0', 0, null, 'error'), sib('b1', 1, u('f1'), 'frame_ready')];
ok(pickSceneAnchor({ id: 'b2', index: 2, sceneKey: K }, failedFirst)?.anchorBoardId === 'b1', 'pick: board 1 failed → board 2 is the anchor for board 3');
// re-render of the first board: still no lower sibling → stays the anchor (refreshes its frame)
ok(pickSceneAnchor({ id: 'b0', index: 0, sceneKey: K }, scene3) === null, 'pick: re-rendering board 1 keeps it the anchor (no anchor attached to it)');
// another scene never shares
ok(pickSceneAnchor({ id: 'x2', index: 2, sceneKey: 'ep2|loc1' }, scene3) === null, 'pick: a board of another scene does not inherit this anchor');
ok(pickSceneAnchor({ id: 'b2', index: 2, sceneKey: K }, [sib('b0', 0, 'not-a-url', 'frame_ready')]) === null, 'pick: an invalid imageUrl is never an anchor');

const waiting = [sib('b0', 0, null, 'frame_generating'), sib('b1', 1, null, 'error'), sib('b3', 3, null, 'frame_generating')];
const w = renderingLowerSiblings({ id: 'b2', index: 2, sceneKey: K }, waiting);
ok(w.length === 1 && w[0].id === 'b0', 'sequential: board 3 waits only for a LOWER sibling still rendering (not a failed one, not a higher one)');
ok(renderingLowerSiblings({ id: 'b2', index: 2, sceneKey: 'ep2|loc1' }, waiting).length === 0, 'sequential: another scene never waits on this scene');
ok(renderingLowerSiblings({ id: 'b0', index: 0, sceneKey: K }, waiting).length === 0, 'sequential: the first board never waits');

/* ─────────── (B) composeBoardImageInput — priority + cap ─────────── */
ok(WAVESPEED_IMAGE_MAX_REFS === 10, 'provider cap is still 10 (unchanged)');
const chars2 = [u('anna'), u('boris')];
const plates3 = [u('region'), u('wide'), u('layout')];
const noAnchor = composeBoardImageInput({ characterRefs: chars2, anchorUrl: null, plateUrls: plates3, hasRegionPlate: true, maxRefs: 10 });
ok(noAnchor.anchorRefIndex === null && noAnchor.imageInput.join() === [...chars2, ...plates3].join(), 'compose(no anchor): chars → plates, byte-identical to the Stage 131 order');
const withA = composeBoardImageInput({ characterRefs: chars2, anchorUrl: u('f0'), plateUrls: plates3, hasRegionPlate: true, maxRefs: 10 });
ok(withA.imageInput.join() === [...chars2, u('f0'), ...plates3].join(), 'compose(anchor): characters → ANCHOR → plates');
ok(withA.anchorRefIndex === 3, 'compose(anchor): anchor ref index is 1-based position after the character refs (3)');
ok(withA.regionPlateAttached === true && withA.platesAttached.length === 3, 'compose(anchor): all plates still attached under the cap');
// over the cap: 8 characters + anchor + 3 plates = 12 > 10 → plates cut FIRST (region plate first), anchor + chars stay
const chars8 = Array.from({ length: 8 }, (_, i) => u(`c${i}`));
const capped = composeBoardImageInput({ characterRefs: chars8, anchorUrl: u('f0'), plateUrls: plates3, hasRegionPlate: true, maxRefs: 10 });
ok(capped.imageInput.length === 10, 'compose(cap): total never exceeds the provider cap');
ok(chars8.every(c => capped.imageInput.includes(c)) && capped.imageInput.includes(u('f0')), 'compose(cap): every character ref AND the anchor survive the cap');
ok(capped.anchorRefIndex === 9 && capped.imageInput[8] === u('f0'), 'compose(cap): anchor right after the 8 character refs (ref #9)');
ok(capped.platesAttached.join() === u('layout') && !capped.imageInput.includes(u('region')) && capped.regionPlateAttached === false, 'compose(cap): plates are cut first — region plate + wide dropped, only the last master kept');
const noRoom = composeBoardImageInput({ characterRefs: chars8.concat([u('c8')]), anchorUrl: u('f0'), plateUrls: plates3, hasRegionPlate: true, maxRefs: 10 });
ok(noRoom.imageInput.length === 10 && noRoom.platesAttached.length === 0 && noRoom.anchorRefIndex === 10, 'compose(cap): 9 chars + anchor → zero plates, anchor kept as ref #10');
const dup = composeBoardImageInput({ characterRefs: chars2, anchorUrl: u('f0'), plateUrls: [u('f0'), u('wide')], hasRegionPlate: false, maxRefs: 10 });
ok(dup.imageInput.filter(x => x === u('f0')).length === 1, 'compose: duplicates removed (a plate equal to the anchor is not repeated)');
ok(composeBoardImageInput({ characterRefs: chars2, anchorUrl: u('f0'), plateUrls: [], hasRegionPlate: false, maxRefs: Number.NaN }).imageInput.length === 3, 'compose: a non-numeric cap falls back to the provider default (never drops refs)');

/* ─────────── (C) prompt blocks ─────────── */
const anchorLine = buildSceneAnchorLine(3);
ok(/^SCENE ANCHOR FRAME \(reference image 3\):/.test(anchorLine), 'line: names the anchor by its reference index');
ok(/EXACT same furniture and props/.test(anchorLine) && /identical desk shape, size, position, orientation/.test(anchorLine), 'line: identical desk geometry demanded');
ok(/Only the camera angle\/framing changes/.test(anchorLine) && /anchor frame wins/.test(anchorLine), 'line: only the camera changes; anchor wins over a plate');
ok(/^BODY \/ FURNITURE SEPARATION:/.test(BOARD_BODY_FURNITURE_LINE) && /visible floor gap/.test(BOARD_BODY_FURNITURE_LINE) && /never intersects, merges into/.test(BOARD_BODY_FURNITURE_LINE), 'body line: floor gap + no merging into desk');
ok(/occludes only the lower body/.test(BOARD_BODY_FURNITURE_LINE) && /Hands rest ON the surface/.test(BOARD_BODY_FURNITURE_LINE), 'body line: desk edge occludes only the lower body; hands ON the surface');

const cast = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }];
const base = { board: { index: 1, actionOrDialogue: 'They confer at the desk.' }, characters: cast, locationName: 'Great Library', locationDesc: 'A large central librarian desk.' };
const first = buildBoardFramePrompt({ ...base, board: { ...base.board, index: 0 }, hasPlate: true, anchorRefIndex: null });
ok(!/SCENE ANCHOR FRAME/.test(first.prompt), 'prompt(first board): no anchor block');
ok(first.prompt.includes(BOARD_BODY_FURNITURE_LINE), 'prompt(first board): body/furniture block present');
const later = buildBoardFramePrompt({ ...base, hasPlate: true, anchorRefIndex: 3 });
ok(later.prompt.includes(buildSceneAnchorLine(3)), 'prompt(later board): SCENE ANCHOR FRAME block with the correct ref index (3)');
ok(later.prompt.includes(BOARD_BODY_FURNITURE_LINE), 'prompt(later board): body/furniture block present');
ok(later.prompt.indexOf('GEOMETRY AUTHORITY') < later.prompt.indexOf('SCENE ANCHOR FRAME') && later.prompt.indexOf('SCENE ANCHOR FRAME') < later.prompt.indexOf('CAMERA:'), 'prompt: anchor block sits after geometry authority and before the camera line');
ok(/camera is NOT locked/.test(later.prompt) && /9:16/.test(later.prompt) && /clearly female/i.test(later.prompt) && /never a flat frontal line-up/.test(later.prompt), 'prompt: S124/S125/S116 invariants preserved');
ok(later.prompt.length - first.prompt.length < 900, 'prompt: anchor block adds < 900 chars (no bloat; Stage 143 people caveat included)');

/* ─────────── (D) SCENES / shared adapters byte-identical ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}
ok(/ADD COLUMN IF NOT EXISTS "anchorUrl"/.test(readFileSync('prisma/patch.sql', 'utf8')) && /ADD COLUMN IF NOT EXISTS "anchorBoardId"/.test(readFileSync('prisma/patch.sql', 'utf8')), 'migration: idempotent patch.sql adds anchorUrl + anchorBoardId');
ok(/anchorUrl\s+String\?/.test(readFileSync('prisma/schema.prisma', 'utf8')) && /anchorBoardId\s+String\?/.test(readFileSync('prisma/schema.prisma', 'utf8')), 'schema: Board.anchorUrl / anchorBoardId nullable (additive)');

await workerFlowCheck();

/* ─────────── (E) REAL board_image worker with mocked transport ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  process.env.BOARD_ANCHOR_WAIT_POLL_MS = '5';
  const charRefs = [u('anna-ref'), u('boris-ref')];
  const episodes: Record<string, any> = {
    ep1: { id: 'ep1', mode: 'STORYBOARD', locationId: 'loc1', locationName: 'Great Library', locationDesc: 'A large central librarian desk holds an ink pad and a returns ledger.' },
    ep2: { id: 'ep2', mode: 'STORYBOARD', locationId: 'loc1', locationName: 'Great Library', locationDesc: 'A large central librarian desk holds an ink pad and a returns ledger.' },
  };
  let saved: any[] = [];
  const mk = (episodeId: string, i: number) => ({ id: `${episodeId}-b${i}`, episodeId, index: i, actionOrDialogue: `Beat ${i + 1} at the desk.`, motionEn: null, directionJson: null, region: 'at the desk', status: 'pending', imageUrl: null, imagePrompt: null, anchorUrl: null, anchorBoardId: null });
  const failures: string[] = [];
  const calls: Array<{ boardId: string; image_input: string[]; prompt: string }> = [];
  let currentBoard = '';
  let failNext = 0;
  let renderCount = 0;
  const messages: string[] = [];
  const prisma = {
    board: {
      findUnique: async ({ where }: any) => { const b = saved.find(s => s.id === where.id); currentBoard = where.id; return b ? { ...b, episode: episodes[b.episodeId] } : null; },
      findMany: async ({ where }: any) => saved.filter(s => !where?.episodeId || s.episodeId === where.episodeId),
      update: async ({ where, data }: any) => { const b = saved.find(s => s.id === where.id); if (b) Object.assign(b, data); return b; },
    },
    episodeCharacter: { findMany: async () => [{ character: { name: 'Anna', imageFull: charRefs[0], gender: 'female', appearance: 'Anna appearance', age: 'adult' } }, { character: { name: 'Boris', imageFull: charRefs[1], gender: 'male', appearance: 'Boris appearance', age: 'adult' } }] },
    location: { findUnique: async () => ({ id: 'loc1', name: 'Great Library', imageUrl: u('wide'), imageReverse: u('layout'), regionPlates: null }) },
  };
  const mocks: Record<string, unknown> = {
    '@/lib/db': { prisma },
    '@/lib/jobs': {
      updateJob: async (_id: string, data: any) => { if (data?.message) messages.push(data.message); }, completeJob: async () => {}, isCancelRequested: async () => false,
      markCanceled: async () => {}, failJob: async (_id: string, message: string) => { failures.push(message); },
    },
    '@/lib/s3-upload': { uploadRemoteToS3: async (url: string) => url },
    '@/lib/providers/image-provider': {
      WAVESPEED_IMAGE_MAX_REFS: 10,
      generateImage: async (req: any) => {
        calls.push({ boardId: currentBoard, image_input: req.image_input ?? [], prompt: req.prompt });
        if (failNext > 0) { failNext--; throw new Error('mock render failure'); }
        renderCount++;
        return u(`frame-${currentBoard}-${renderCount}`);
      },
      GenerationCanceledError: class extends Error {},
    },
  };
  internal._load = function(id: string, ...rest: any[]) {
    const key = id.replace(/^.*\/lib\//, '@/lib/').replace(/\.(?:ts|js)$/, '');
    return mocks[key] ?? originalLoad.call(this, id, ...rest);
  };
  try {
    const workers = require('../lib/workers/storyboard-job');

    // (E1) scene of 3 boards, in order
    saved = [mk('ep1', 0), mk('ep1', 1), mk('ep1', 2)];
    for (const b of [...saved]) await workers.runBoardImageJob(`job-${b.id}`, 'project1', b.id);
    ok(failures.length === 0, `worker: 3 boards rendered without failures (${failures.join(' | ') || 'none'})`);
    const [c0, c1, c2] = calls;
    const anchor1 = saved[0].imageUrl as string;
    ok(c0.image_input.join() === [...charRefs, u('wide'), u('layout')].join() && !/SCENE ANCHOR FRAME/.test(c0.prompt), 'worker: board 1 has NO anchor (chars → plates only, no anchor block)');
    ok(saved[0].anchorUrl === null && saved[0].anchorBoardId === null, 'worker: board 1 persists no anchor (it IS the anchor)');
    ok(c1.image_input.join() === [...charRefs, anchor1, u('wide'), u('layout')].join(), 'worker: board 2 image_input = chars → board-1 frame → plates (its continuity frame IS the anchor, deduped — S144)');
    ok(c2.image_input.join() === [...charRefs, saved[1].imageUrl, anchor1, u('wide'), u('layout')].join(), 'worker: board 3 image_input = chars → board-2 continuity frame → board-1 anchor → plates (S144: previous board differs from anchor)');
    ok(/SCENE ANCHOR FRAME \(reference image 3\)/.test(c1.prompt) && /SCENE ANCHOR FRAME \(reference image 4\)/.test(c2.prompt) && /CONTINUITY FRAME \(reference image 3\)/.test(c2.prompt), 'worker: board 2 names the anchor (=continuity) as reference image 3; board 3 has a distinct continuity ref (image 3) + anchor (image 4) (S144)');
    ok(calls.every(c => c.prompt.includes(BOARD_BODY_FURNITURE_LINE)), 'worker: BODY / FURNITURE SEPARATION in every board prompt');
    ok(saved[1].anchorUrl === anchor1 && saved[1].anchorBoardId === 'ep1-b0' && saved[2].anchorUrl === anchor1 && saved[2].anchorBoardId === 'ep1-b0', 'worker: anchorUrl/anchorBoardId persisted on boards 2–3');
    ok(calls.every(c => /PERSISTENT SET PIECES/.test(c.prompt) && /GEOMETRY AUTHORITY/.test(c.prompt)), 'worker: S140 set anchors + S131 geometry authority kept as complement');
    ok(saved.every(b => b.status === 'frame_ready' && b.plateUrl === u('wide')), 'worker: status/plateUrl unchanged behaviour');

    // (E2) re-render of the first board: refreshes its frame, stays the anchor (no anchor attached), others untouched
    calls.length = 0;
    await workers.runBoardImageJob('job-re0', 'project1', 'ep1-b0');
    ok(calls.length === 1 && !calls[0].image_input.includes(anchor1) && !/SCENE ANCHOR FRAME/.test(calls[0].prompt), 'worker: re-rendering board 1 attaches no anchor');
    ok(saved[0].imageUrl !== anchor1 && saved[0].anchorUrl === null, 'worker: board 1 frame refreshed, still the anchor');
    ok(saved[1].imageUrl && saved[2].imageUrl && calls.length === 1, 'worker: other boards are NOT auto re-rendered (no extra generations)');
    // re-render of a later board uses the (refreshed) anchor
    calls.length = 0;
    await workers.runBoardImageJob('job-re2', 'project1', 'ep1-b2');
    ok(calls[0].image_input[3] === saved[0].imageUrl && calls[0].image_input[2] === saved[1].imageUrl && saved[2].anchorUrl === saved[0].imageUrl, 'worker: re-rendering board 3 uses board-2 as continuity and the current board-1 frame as anchor (S144)');

    // (E3) first board fails → board 2 becomes the anchor for board 3
    saved = [mk('ep1', 0), mk('ep1', 1), mk('ep1', 2)];
    calls.length = 0; failures.length = 0; failNext = 1;
    for (const b of [...saved]) await workers.runBoardImageJob(`job2-${b.id}`, 'project1', b.id);
    ok(failures.length === 1 && saved[0].status === 'error' && saved[0].imageUrl === null, 'worker(fail): board 1 failed and holds no frame');
    ok(calls[1].image_input.join() === [...charRefs, u('wide'), u('layout')].join() && saved[1].anchorUrl === null, 'worker(fail): board 2 renders with no anchor and becomes the anchor');
    ok(calls[2].image_input[2] === saved[1].imageUrl && saved[2].anchorBoardId === 'ep1-b1', 'worker(fail): board 3 anchors on board 2');

    // (E4) different scenes (episodes) do not share an anchor
    saved = [mk('ep1', 0), mk('ep2', 0), mk('ep2', 1)];
    calls.length = 0; failures.length = 0;
    for (const b of [...saved]) await workers.runBoardImageJob(`job3-${b.id}`, 'project1', b.id);
    ok(failures.length === 0 && !calls[1].image_input.includes(saved[0].imageUrl) && saved[1].anchorUrl === null, 'worker(scenes): the first board of episode 2 does not inherit episode 1 anchor');
    ok(calls[2].image_input[2] === saved[1].imageUrl && saved[2].anchorBoardId === 'ep2-b0', 'worker(scenes): episode 2 board 2 anchors on episode 2 board 1');

    // (E5) sequential render: board 2 waits while board 1 is still rendering, then anchors on it
    saved = [mk('ep1', 0), mk('ep1', 1)];
    saved[0].status = 'frame_generating';
    calls.length = 0; failures.length = 0; messages.length = 0;
    setTimeout(() => { saved[0].imageUrl = u('late-frame-0'); saved[0].status = 'frame_ready'; }, 40);
    await workers.runBoardImageJob('job4-ep1-b1', 'project1', 'ep1-b1');
    ok(failures.length === 0 && messages.some(m => /waiting for board 1/.test(m)), 'worker(sequential): board 2 waited for board 1 (progress message)');
    ok(calls.length === 1 && calls[0].image_input[2] === u('late-frame-0') && saved[1].anchorBoardId === 'ep1-b0', 'worker(sequential): after the wait, board 2 anchors on the late board-1 frame');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 142: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
