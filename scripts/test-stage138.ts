/** Stage 138: deterministic CAMERA DEGRADATION (Storyboard only). A board whose action describes travel but
 * carries no literal source movement evidence no longer hard-fails planning ("Board N: travelling action
 * needs literal source movement evidence."). finalizeDirectedBoards now degrades that board to a static
 * locked-off camera and records WHY (directionJson.cameraDegradedReason), then continues. TRACKING is kept
 * ONLY when the action literally travels AND that locomotion is backed by a literal source excerpt. A stale
 * tracking cue on a stationary beat is likewise degraded to static (evidence dropped). A hard, INFORMATIVE
 * conflict remains ONLY for genuinely unresolvable data (movement evidence not present in the source at all).
 * Stage 133/134/135/136/137 invariants (attribution NAME (delivery): "line", per-line addressee/eyeline,
 * multi-speaker staging, verbatim text/order, 12–15 count balancing, per-board budget redistribution, 4–6s,
 * no unsupported i2v fields, SCENES untouched) are regressed here. Pure logic + mocked REAL provider
 * transport and workers. No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { storyboardSource } from '../lib/storyboard-dialogue';
import {
  balanceBoardCount,
  finalizeDirectedBoards,
  readBoardDirection,
  type RawDirectedBoard,
} from '../lib/storyboard-direction';
import { buildStoryboardVideoRequest, storyboardCameraMode } from '../lib/storyboard-animation';
import { buildSeedanceImageToVideoBody } from '../lib/wavespeed';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
function throwsWith(fn: () => unknown, check: (msg: string) => boolean, message: string) {
  let threw = false; let caught = '';
  try { fn(); } catch (err) { threw = true; caught = err instanceof Error ? err.message : String(err); }
  assert.ok(threw && check(caught), `${message} (got: ${caught || 'no throw'})`);
  passed++;
}

const genders = (names: string[]) => names.map(n => ({ name: n, gender: n === 'Boris' ? 'male' : 'female' }));
// Source action carries the two travel excerpts our real-travel / reverse boards reference verbatim.
const ACTION = 'Anna and Boris talk in the room. Anna walks across the room to the window. Boris crosses the room to the door.';
const TRAVEL_EXCERPT = 'Anna walks across the room to the window';
const REVERSE_EXCERPT = 'Boris crosses the room to the door';

/** Build N short labelled lines + rich travel action through the REAL source pipeline (ledger ids match app). */
function buildSource(n: number, cast: string[], action = ACTION) {
  const lines = Array.from({ length: n }, (_, i) => `${cast[i % cast.length]} (calmly): "Line ${i + 1}."`).join('\n');
  const scenes = [{ number: 1, action, dialogue: lines }];
  return { scenes, src: storyboardSource({ description: 'A conversation.' }, scenes, genders(cast)) };
}

async function main() {
const cast2 = ['Anna', 'Boris'];
const img = 'https://storyboardart.org/wp-content/uploads/2022/04/mimoshort_thumbnails_01-scaled.jpg';

/* A single 12-board plan exercising every camera branch: dialogue (static), real travel (TRACKING),
 * travelling action w/o evidence (DEGRADE), stationary beat w/ stale evidence (DEGRADE), plain static. */
const base = buildSource(6, cast2);
const seg = base.src.segments;
const D = (i: number, extra: Partial<RawDirectedBoard>): RawDirectedBoard =>
  ({ actionOrDialogue: `Beat ${i}`, actionEnglish: 'Steady reactions.', durationSec: 5, region: 'at the table', speechIds: [], ...extra });
const plan: RawDirectedBoard[] = [
  D(0, { speechIds: [seg[0].id], shot: 'over_shoulder' }),                                             // 0 dialogue → static
  D(1, { speechIds: [seg[1].id], shot: 'over_shoulder' }),                                             // 1 dialogue → static
  D(2, { actionEnglish: TRAVEL_EXCERPT, travelEvidence: TRAVEL_EXCERPT }),                             // 2 real travel → TRACKING
  D(3, { speechIds: [seg[2].id], shot: 'over_shoulder' }),                                             // 3 dialogue → static
  D(4, { actionEnglish: 'Anna walks toward the window', travelEvidence: '' }),                         // 4 travel w/o evidence → DEGRADE
  D(5, { speechIds: [seg[3].id], shot: 'over_shoulder' }),                                             // 5 dialogue → static
  D(6, { actionEnglish: 'Anna looks at Boris.', travelEvidence: REVERSE_EXCERPT }),                    // 6 stationary + stale evidence → DEGRADE
  D(7, { speechIds: [seg[4].id], shot: 'over_shoulder' }),                                             // 7 dialogue → static
  D(8, { actionEnglish: 'The two react quietly.', travelEvidence: '' }),                               // 8 plain static
  D(9, { speechIds: [seg[5].id], shot: 'over_shoulder' }),                                             // 9 dialogue → static
  D(10, {}), D(11, {}),                                                                                // 10,11 plain static
];
ok(plan.length === 12, 'scenario plan has exactly 12 boards');

/* ─────────── 1) Balancing is camera-neutral: an already-valid 12-board plan passes through unchanged ─────────── */
const balanced = balanceBoardCount(plan, seg);
ok(balanced.length === 12, 'balanceBoardCount leaves a valid 12-board plan at 12 boards (Stage 136/137 path intact)');

/* ─────────── 2) finalize NO LONGER hard-fails on a travelling action without evidence — it degrades ─────────── */
let fin: ReturnType<typeof finalizeDirectedBoards>;
try {
  fin = finalizeDirectedBoards(balanced, seg, cast2, base.src.actionSource);
  ok(true, 'finalize completes without throwing "travelling action needs literal source movement evidence"');
} catch (err) {
  ok(false, `finalize should not throw on a travelling action without evidence (threw: ${err instanceof Error ? err.message : err})`);
  throw err;
}
ok(fin.length === 12 && fin.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every finalized board stays in the 4–6s window');

const planOf = (i: number) => readBoardDirection(fin[i].directionJson)!;

/* ─────────── 3) Board 2 (real, source-backed locomotion) KEEPS its tracking camera ─────────── */
const p2 = planOf(2);
ok(p2.cameraMode === 'TRACKING' && p2.travelEvidence === TRAVEL_EXCERPT && p2.cameraDegradedReason === '',
  'a board with real, source-backed movement keeps TRACKING and is NOT degraded');

/* ─────────── 4) Board 4 (travelling action, NO evidence) is degraded to static, with a recorded reason ─────────── */
const p4 = planOf(4);
ok(p4.cameraMode === 'LOCKED_OFF', 'a travelling action without literal source evidence is degraded to a static locked-off camera');
ok(/no literal source movement evidence/i.test(p4.cameraDegradedReason), 'the degradation reason is recorded in directionJson (missing evidence)');
ok(p4.actionEnglish === 'Anna walks toward the window', 'the actor action itself is preserved verbatim (only the camera degrades)');

/* ─────────── 5) Board 6 (stationary beat with a STALE tracking cue) is degraded, stale evidence dropped ─────────── */
const p6 = planOf(6);
ok(p6.cameraMode === 'LOCKED_OFF' && p6.travelEvidence === '', 'a stationary beat drops its inherited movement evidence and goes static');
ok(/stationary/i.test(p6.cameraDegradedReason), 'the degradation reason is recorded for the stale-tracking-cue case');

/* ─────────── 6) Dialogue + plain static boards stay static and are NEVER flagged as degraded ─────────── */
for (const i of [0, 1, 3, 5, 7, 8, 9, 10, 11]) {
  const p = planOf(i);
  ok(p.cameraMode === 'LOCKED_OFF' && p.cameraDegradedReason === '', `board ${i} stays static locked-off with no spurious degradation flag`);
}

/* ─────────── 7) readBoardDirection accepts every degraded board (camera/evidence stay consistent) ─────────── */
ok(fin.every(b => !!readBoardDirection(b.directionJson)), 'all persisted boards (including degraded ones) re-read without a camera-data conflict');

/* ─────────── 8) The i2v animation prompt reflects the degradation: static camera language, no tracking ─────────── */
const degradedBoard = fin[4];
ok(storyboardCameraMode(degradedBoard as any) === 'LOCKED_OFF', 'the animation layer reports LOCKED_OFF for the degraded board');
const reqDeg = buildStoryboardVideoRequest({ actionOrDialogue: degradedBoard.actionOrDialogue, directionJson: degradedBoard.directionJson, durationSec: 5, imageUrl: img });
ok(/LOCKED-OFF/i.test(reqDeg.prompt) && !/CAMERA MODE: TRACKING/i.test(reqDeg.prompt), 'the degraded board renders a locked-off (static) camera instruction, never a tracking one');
const trackBoard = fin[2];
const reqTrack = buildStoryboardVideoRequest({ actionOrDialogue: trackBoard.actionOrDialogue, directionJson: trackBoard.directionJson, durationSec: 5, imageUrl: img });
ok(/CAMERA MODE: TRACKING/i.test(reqTrack.prompt), 'the genuinely travelling board still renders a tracking camera instruction');
const bodyDeg = buildSeedanceImageToVideoBody(reqDeg);
ok(!('reference_images' in bodyDeg) && !('image_input' in bodyDeg), 'degraded-board i2v adds no unsupported character-reference fields (Seedance 2.5 contract)');

/* ─────────── 9) Genuinely UNRESOLVABLE data (evidence not in source at all) still hard-fails, informatively ─────────── */
const bad = balancedClone(balanced);
bad[4] = { ...bad[4], actionEnglish: 'Anna walks toward the window', travelEvidence: 'Anna teleports through the solid wall' };
throwsWith(
  () => finalizeDirectedBoards(bad, seg, cast2, base.src.actionSource),
  (m) => /movement evidence is not in source action/i.test(m),
  'movement evidence absent from the source is a genuine data conflict and still hard-fails informatively',
);
function balancedClone(bs: RawDirectedBoard[]) { return bs.map(b => ({ ...b, speechIds: [...(b.speechIds ?? [])] })); }

/* ─────────── 10) Stage 134 staging invariants survive alongside camera degradation (3-cast addressee/eyeline) ─────────── */
const cast3 = ['Anna', 'Boris', 'Clara'];
const three = storyboardSource({ description: 'A meeting.' }, [{ number: 1,
  action: 'Anna, Boris and Clara stand around the table. Clara crosses the room to the whiteboard.',
  dialogue: 'Anna (firmly): "Отчёт готов?"\nBoris (calmly): "Да, вчера вечером."\nClara (softly): "Я проверила цифры."\nAnna (nodding): "Отлично, спасибо."' }], genders(cast3));
const s3 = three.segments;
const T = (i: number, extra: Partial<RawDirectedBoard>): RawDirectedBoard =>
  ({ actionOrDialogue: `Beat ${i}`, actionEnglish: 'The team reacts quietly.', durationSec: 5, region: 'at the table', speechIds: [], ...extra });
const plan3: RawDirectedBoard[] = [
  T(0, { speechIds: [s3[0].id], shot: 'over_shoulder' }),
  T(1, { speechIds: [s3[1].id], shot: 'listener_reverse' }),
  T(2, { speechIds: [s3[2].id], shot: 'three_shot' }),
  T(3, { speechIds: [s3[3].id], shot: 'listener_reverse' }),
  T(4, { actionEnglish: 'Clara walks to the whiteboard', travelEvidence: '' }), // travelling action, no evidence → degrade
  T(5, {}), T(6, {}), T(7, {}), T(8, {}), T(9, {}), T(10, {}), T(11, {}),
];
const bal3 = balanceBoardCount(plan3, s3);
ok(bal3.length >= 12 && bal3.length <= 15, 'three-speaker plan stays within 12–15 boards');
const fin3 = finalizeDirectedBoards(bal3, s3, cast3, three.actionSource);
const clara = fin3.find(b => b.actionOrDialogue.includes('Clara (softly): "Я проверила цифры."'))!;
const claraPlan = readBoardDirection(clara.directionJson)!;
ok(claraPlan.addressee === 'Boris' && claraPlan.cast.length === 3, 'per-line addressee (eyeline) and full 3-cast context survive alongside camera degradation');
ok(readBoardDirection(fin3[0].directionJson)!.version === 134, 'boards persist as the Stage 134 direction version');
const clara4 = fin3.find(b => readBoardDirection(b.directionJson)!.actionEnglish === 'Clara walks to the whiteboard')!;
ok(readBoardDirection(clara4.directionJson)!.cameraMode === 'LOCKED_OFF' && /no literal source movement evidence/i.test(readBoardDirection(clara4.directionJson)!.cameraDegradedReason),
  'the travelling-without-evidence board is degraded to static in the 3-cast scene too');

/* ─────────── 11) SCENES / shared adapters remain byte-identical (Storyboard-only change) ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

await workerFlowCheck();

/* ─────────── 12) REAL worker flow: a model plan with a travelling-action-without-evidence board now SUCCEEDS ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  let saved: any[] = [];
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna and Boris talk.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  const wf = buildSource(6, cast2);
  const wseg = wf.src.segments;
  const W = (i: number, extra: Partial<RawDirectedBoard>): RawDirectedBoard =>
    ({ actionOrDialogue: `Beat ${i}`, actionEnglish: 'Steady reactions.', durationSec: 5, region: 'at the table', speechIds: [], ...extra });
  const modelRaw: RawDirectedBoard[] = [
    W(0, { speechIds: [wseg[0].id], shot: 'over_shoulder' }),
    W(1, { speechIds: [wseg[1].id], shot: 'over_shoulder' }),
    W(2, { actionEnglish: 'Anna walks toward the window', travelEvidence: '' }), // would previously HARD-FAIL
    W(3, { speechIds: [wseg[2].id], shot: 'over_shoulder' }),
    W(4, { speechIds: [wseg[3].id], shot: 'over_shoulder' }),
    W(5, { speechIds: [wseg[4].id], shot: 'over_shoulder' }),
    W(6, { speechIds: [wseg[5].id], shot: 'over_shoulder' }),
    W(7, {}), W(8, {}), W(9, {}), W(10, {}), W(11, {}),
  ];
  const prisma = {
    episode: { findUnique: async () => episode },
    episodeCharacter: { findMany: async () => genders(cast2).map((c) => ({ character: { name: c.name, imageFull: 'https://cdn3.toonboom.com/wp-content/uploads/2025/05/29110423/roughs-and-cleans-1.jpg', gender: c.gender } })) },
    scene: { findMany: async () => wf.scenes },
    location: { findUnique: async () => ({ id: 'loc1', imageUrl: 'https://www.frontiersin.org/files/Articles/1488754/xml-images/fearc-03-1488754-g0001.webp', imageReverse: 'https://cdn.mos.cms.futurecdn.net/SiUdtCQuTnWNUdbRHSoGWh-1200-80.jpg', regionPlates: null }) },
    board: {
      deleteMany: async () => { saved = []; },
      createMany: async ({ data }: any) => { saved = data.map((b: any, i: number) => ({ ...b, id: `board-${i}` })); },
      findUnique: async ({ where }: any) => { const b = saved.find(s => s.id === where.id) ?? saved[0]; return { ...b, episode }; },
      update: async ({ where, data }: any) => { const b = saved.find(s => s.id === where.id) ?? saved[0]; Object.assign(b, data); return b; },
    },
    $transaction: async (fn: (tx: any) => unknown) => fn(prisma),
  };
  const mocks: Record<string, unknown> = {
    '@/lib/db': { prisma },
    '@/lib/ai': { chatJSON: async () => ({ boards: modelRaw }) },
    '@/lib/jobs': {
      updateJob: async () => {}, completeJob: async () => {}, isCancelRequested: async () => false,
      markCanceled: async () => {}, failJob: async (_id: string, message: string) => { failures.push(message); },
    },
    '@/lib/s3-upload': { uploadRemoteToS3: async (url: string) => url },
    '@/lib/assemble': { assembleStoryboardVideo: async () => { throw new Error('Unexpected assembly'); } },
    '@/lib/providers/image-provider': { generateImage: async () => img, GenerationCanceledError: class extends Error {} },
    '@/lib/providers/video-provider': {
      startImageToVideoGeneration: async () => 'mock-video',
      getVideoGenerationState: async () => ({ status: 'succeeded', url: 'https://example.org/mock-video.mp4' }),
      cancelVideoGeneration: async () => {},
    },
  };
  internal._load = function(id: string, ...rest: any[]) {
    const key = id.replace(/^.*\/lib\//, '@/lib/').replace(/\.(?:ts|js)$/, '');
    return mocks[key] ?? originalLoad.call(this, id, ...rest);
  };
  try {
    const workers = require('../lib/workers/storyboard-job');
    await workers.runStoryboardBoardsJob('mock-job', 'project1', 'ep1');
    ok(saved.length >= 12 && saved.length <= 15 && failures.length === 0,
      `a plan with a travelling-action-without-evidence board now SUCCEEDS end-to-end (saved ${saved.length}, no planning hard-block)`);
    const degraded = saved.find(b => JSON.parse(b.directionJson).actionEnglish === 'Anna walks toward the window');
    ok(!!degraded && JSON.parse(degraded.directionJson).cameraMode === 'LOCKED_OFF' &&
       /no literal source movement evidence/i.test(JSON.parse(degraded.directionJson).cameraDegradedReason),
      'the persisted DB board is degraded to static locked-off with the reason recorded');
    const savedIds = saved.flatMap(b => JSON.parse(b.directionJson).speech.map((s: any) => s.id));
    ok(JSON.stringify(savedIds) === JSON.stringify(wseg.map(s => s.id)), 'every speech segment is preserved, once, in source order (no truncation)');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 138: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
