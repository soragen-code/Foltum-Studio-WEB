/** Stage 139: deterministic SPEECH-ID RECONCILIATION (Storyboard only). The LLM split (and an upstream LLM
 * repair round) can omit, duplicate, re-order or hallucinate source speech IDs, which previously hard-failed
 * planning with "Dialogue integrity conflict: source lines must appear exactly once, in source order, without
 * omissions or paraphrases." reconcileSpeechIds now repairs the model's allocation deterministically BEFORE
 * balancing/finalize: it keeps each board's spoken-slot COUNT as a pacing hint and refills those slots with
 * the authoritative source IDs strictly in source order, so the integrity invariant holds by construction.
 * Missing lines are appended to the last spoken board and balanceBoardCount fans out the overflow — nothing
 * is truncated, sped up, re-ordered or paraphrased. The finalize integrity check stays as the LAST line of
 * defence (proven by driving a broken allocation past reconciliation straight into finalize).
 * Stage 133–138 invariants (attribution NAME (delivery): "line", per-line addressee/eyeline, multi-speaker
 * staging, verbatim text/order, 12–15 count balancing, per-board 4–6s budget, camera degradation, no
 * unsupported i2v fields, SCENES untouched) are regressed here. Pure logic + mocked REAL workers. No network,
 * no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { storyboardSource } from '../lib/storyboard-dialogue';
import {
  reconcileSpeechIds,
  balanceBoardCount,
  finalizeDirectedBoards,
  readBoardDirection,
  type RawDirectedBoard,
} from '../lib/storyboard-direction';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
function throwsWith(fn: () => unknown, check: (msg: string) => boolean, message: string) {
  let threw = false; let caught = '';
  try { fn(); } catch (err) { threw = true; caught = err instanceof Error ? err.message : String(err); }
  assert.ok(threw && check(caught), `${message} (got: ${caught || 'no throw'})`);
  passed++;
}

const genders = (names: string[]) => names.map(n => ({ name: n, gender: n === 'Boris' ? 'male' : 'female' }));
const ACTION = 'Anna and Boris talk in the room.';
const cast2 = ['Anna', 'Boris'];

/** Build N short single-clause lines through the REAL source pipeline (ledger ids match the running app). */
function buildSource(n: number, cast: string[], action = ACTION) {
  const lines = Array.from({ length: n }, (_, i) => `${cast[i % cast.length]} (calmly): "Line ${i + 1}."`).join('\n');
  const scenes = [{ number: 1, action, dialogue: lines }];
  return { scenes, src: storyboardSource({ description: 'A conversation.' }, scenes, genders(cast)) };
}
const D = (extra: Partial<RawDirectedBoard>): RawDirectedBoard =>
  ({ actionOrDialogue: 'Beat', actionEnglish: 'Steady reactions.', durationSec: 5, region: 'at the table', speechIds: [], ...extra });
const flat = (bs: RawDirectedBoard[]) => bs.flatMap(b => b.speechIds ?? []);

async function main() {
const base = buildSource(6, cast2);
const seg = base.src.segments;
const order = seg.map(s => s.id);
ok(order.length === 6 && order.join(',') === 'speech-1.1,speech-2.1,speech-3.1,speech-4.1,speech-5.1,speech-6.1',
  'source builder yields 6 single-clause segments in source order (ledger ids match the app)');

/* ─────────── 1) OMISSION: the model places only 3 of 6 IDs → reconcile restores all 6, once, in order ─────────── */
const omit = reconcileSpeechIds([
  D({ speechIds: [seg[0].id] }), D({ speechIds: [seg[1].id] }), D({ speechIds: [seg[2].id] }),
  D({}), D({}), D({}),
], seg);
ok(JSON.stringify(flat(omit)) === JSON.stringify(order), 'omitted source IDs are re-appended so every line appears exactly once, in source order');
ok(flat(omit).length === new Set(flat(omit)).size, 'reconciliation of an omitting plan produces no duplicate IDs');

/* ─────────── 2) DUPLICATES: repeated IDs are de-duplicated to exactly one occurrence each ─────────── */
const dup = reconcileSpeechIds([
  D({ speechIds: [seg[0].id, seg[0].id] }), D({ speechIds: [seg[1].id] }),
  D({ speechIds: [seg[2].id, seg[3].id] }), D({ speechIds: [seg[3].id, seg[4].id] }),
  D({ speechIds: [seg[5].id] }),
], seg);
ok(JSON.stringify(flat(dup)) === JSON.stringify(order), 'duplicated IDs collapse to one occurrence each, preserving source order');

/* ─────────── 3) RE-ORDER: a shuffled allocation is restored to strict source order ─────────── */
const shuffled = reconcileSpeechIds([
  D({ speechIds: [seg[5].id] }), D({ speechIds: [seg[0].id] }), D({ speechIds: [seg[3].id] }),
  D({ speechIds: [seg[1].id] }), D({ speechIds: [seg[2].id] }), D({ speechIds: [seg[4].id] }),
], seg);
ok(JSON.stringify(flat(shuffled)) === JSON.stringify(order), 'a re-ordered allocation is refilled back into strict source order');

/* ─────────── 4) HALLUCINATED IDs: unknown/out-of-cast IDs contribute nothing; real lines are recovered ─────────── */
const hallucinated = reconcileSpeechIds([
  D({ speechIds: ['speech-99.1', seg[0].id] }), D({ speechIds: [seg[1].id, 'bogus'] }),
  D({ speechIds: [seg[2].id] }), D({}), D({}), D({}),
], seg);
ok(JSON.stringify(flat(hallucinated)) === JSON.stringify(order), 'hallucinated/unknown IDs are dropped and every real source line is recovered exactly once');

/* ─────────── 5) NO-OP: an already-valid in-order allocation reconciles to itself (byte-identical) ─────────── */
const validRaw = order.map(id => D({ speechIds: [id] }));
const reconciled = reconcileSpeechIds(validRaw, seg);
ok(JSON.stringify(reconciled.map(b => b.speechIds)) === JSON.stringify(validRaw.map(b => b.speechIds)),
  'a valid in-order allocation is a no-op (identical per-board speech-ID slots)');

/* ─────────── 6) END-TO-END: an OMITTING model plan now planned to completion, integrity + verbatim intact ─────────── */
const broken12: RawDirectedBoard[] = [
  D({ speechIds: [seg[0].id], shot: 'over_shoulder' }),
  D({ speechIds: [seg[1].id], shot: 'over_shoulder' }),
  D({ speechIds: [seg[2].id], shot: 'over_shoulder' }),   // model stopped here — speech 4,5,6 dropped
  D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}),
];
const balanced = balanceBoardCount(broken12, seg);
ok(balanced.length >= 12 && balanced.length <= 15, 'a plan that dropped half its speech balances into the 12–15 window');
const fin = finalizeDirectedBoards(balanced, seg, cast2, base.src.actionSource);
ok(fin.length >= 12 && fin.length <= 15, 'finalize completes (no "Dialogue integrity conflict") for a plan the model under-allocated');
ok(fin.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every finalized board stays within the 4–6s window');
const finIds = fin.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.id));
ok(JSON.stringify(finIds) === JSON.stringify(order), 'the finalized plan carries every source line exactly once, in source order (no truncation)');
// Verbatim: persisted dialogue is rebuilt from the ledger, never from model prose.
const finText = fin.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.text));
ok(JSON.stringify(finText) === JSON.stringify(seg.map(s => s.text)), 'spoken text is restored verbatim from the ledger by ID (no paraphrase)');
const boardWith = fin.find(b => readBoardDirection(b.directionJson)!.speech.some(s => s.id === seg[0].id))!;
ok(boardWith.actionOrDialogue.includes('Anna (calmly): "Line 1."'), 'the persisted actionOrDialogue uses the exact source bytes with NAME (delivery): "line" attribution');

/* ─────────── 7) PARAPHRASE: model prose in actionOrDialogue is ignored; ledger text wins ─────────── */
const paraphrased = order.map((id, i) =>
  D({ speechIds: [id], actionOrDialogue: `Anna says something like line ${i}`, shot: 'over_shoulder' }));
while (paraphrased.length < 12) paraphrased.push(D({}));
const finPara = finalizeDirectedBoards(balanceBoardCount(paraphrased, seg), seg, cast2, base.src.actionSource);
const paraText = finPara.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.text));
ok(JSON.stringify(paraText) === JSON.stringify(seg.map(s => s.text)), 'model paraphrase never survives — verbatim ledger text is persisted regardless of actionOrDialogue prose');

/* ─────────── 8) LAST LINE OF DEFENCE: a broken allocation driven PAST reconciliation still hard-fails ─────────── */
const validForFinal = order.map(id => D({ speechIds: [id], shot: 'over_shoulder' }));
while (validForFinal.length < 12) validForFinal.push(D({}));
throwsWith(
  () => finalizeDirectedBoards(validForFinal.map((b, i) => i === 0 ? { ...b, speechIds: [] } : { ...b, speechIds: [...(b.speechIds ?? [])] }), seg, cast2, base.src.actionSource),
  (m) => /source lines must appear exactly once, in source order, without omissions or paraphrases/.test(m),
  'a broken allocation that bypasses reconcileSpeechIds still trips the finalize integrity hard-fail (defence-in-depth)',
);

/* ─────────── 9) MULTI-PART UTTERANCE: parts of one long line stay on consecutive boards after reconcile ─────────── */
const longScene = storyboardSource({ description: 'A speech.' }, [{ number: 1, action: ACTION,
  dialogue: 'Anna (firmly): "First clause, then a second clause, and finally a third clause to close."\nBoris (calmly): "Understood."' }], genders(cast2));
const ls = longScene.segments;
ok(ls.filter(s => s.sourceId === 'speech-1').length >= 2, 'a long line is segmented into multiple consecutive parts sharing one sourceId');
// Model scrambles the parts across boards; reconcile must restore contiguous source order.
const scrambled = reconcileSpeechIds([
  D({ speechIds: [ls[2] ? ls[2].id : ls[1].id] }), D({ speechIds: [ls[0].id] }), D({ speechIds: [ls[1].id] }),
  ...ls.slice(3).map(s => D({ speechIds: [s.id] })),
], ls);
ok(JSON.stringify(flat(scrambled)) === JSON.stringify(ls.map(s => s.id)), 'scrambled multi-part utterance is restored to contiguous source order');
const finLong = finalizeDirectedBoards(balanceBoardCount(order.map((_, i) => D({ speechIds: ls[i] ? [ls[i].id] : [] })).concat(Array.from({ length: 12 }, () => D({}))).slice(0, Math.max(12, ls.length)), ls), ls, cast2, longScene.actionSource);
ok(finLong.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.id)).join(',') === ls.map(s => s.id).join(','),
  'multi-part utterance finalizes with every part exactly once, in source order (no continuity conflict)');

/* ─────────── 10) Stage 134 staging survives reconciliation (3-cast per-line addressee / eyeline) ─────────── */
const cast3 = ['Anna', 'Boris', 'Clara'];
const three = storyboardSource({ description: 'A meeting.' }, [{ number: 1,
  action: 'Anna, Boris and Clara stand around the table.',
  dialogue: 'Anna (firmly): "Отчёт готов?"\nBoris (calmly): "Да, вчера вечером."\nClara (softly): "Я проверила цифры."\nAnna (nodding): "Отлично, спасибо."' }], genders(cast3));
const s3 = three.segments;
// Model DROPS Clara's line and Anna's closing line; reconcile must restore both, keeping per-line addressee.
const plan3: RawDirectedBoard[] = [
  D({ speechIds: [s3[0].id], shot: 'over_shoulder' }),
  D({ speechIds: [s3[1].id], shot: 'listener_reverse' }),
  D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}),
];
const fin3 = finalizeDirectedBoards(balanceBoardCount(plan3, s3), s3, cast3, three.actionSource);
ok(fin3.length >= 12 && fin3.length <= 15, 'three-speaker plan that dropped two lines stays within 12–15 boards');
ok(fin3.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.id)).join(',') === s3.map(s => s.id).join(','),
  'the dropped Clara + Anna lines are recovered, once each, in source order');
const clara = fin3.find(b => b.actionOrDialogue.includes('Clara (softly): "Я проверила цифры."'))!;
ok(!!clara, 'the recovered Clara line is persisted verbatim');
const claraPlan = readBoardDirection(clara.directionJson)!;
ok(claraPlan.addressee === 'Boris' && claraPlan.cast.length === 3, 'per-line addressee (eyeline) and full 3-cast context survive reconciliation');
ok(readBoardDirection(fin3[0].directionJson)!.version === 134, 'boards persist as the Stage 134 direction version');

/* ─────────── 11) SCENES / shared adapters remain byte-identical (Storyboard-only change) ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

await workerFlowCheck();

/* ─────────── 12) REAL worker flow: a model plan that DROPS half its speech now SUCCEEDS end-to-end ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  const img = 'https://storyboardart.org/wp-content/uploads/2022/04/mimoshort_thumbnails_01-scaled.jpg';
  let saved: any[] = [];
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna and Boris talk.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  const wf = buildSource(6, cast2);
  const wseg = wf.src.segments;
  // The model returns a plan that placed ONLY the first three of six lines — exactly the real-run failure mode.
  const modelRaw: RawDirectedBoard[] = [
    D({ speechIds: [wseg[0].id], shot: 'over_shoulder' }),
    D({ speechIds: [wseg[1].id], shot: 'over_shoulder' }),
    D({ speechIds: [wseg[2].id], shot: 'over_shoulder' }),
    D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}), D({}),
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
      `a model plan that dropped half its speech now SUCCEEDS end-to-end (saved ${saved.length}, no "Dialogue integrity conflict": ${failures.join(' | ') || 'none'})`);
    const savedIds = saved.flatMap(b => JSON.parse(b.directionJson).speech.map((s: any) => s.id));
    ok(JSON.stringify(savedIds) === JSON.stringify(wseg.map(s => s.id)), 'every dropped speech segment is recovered, once, in source order (no truncation) in the persisted DB boards');
    const savedText = saved.flatMap(b => JSON.parse(b.directionJson).speech.map((s: any) => s.text));
    ok(JSON.stringify(savedText) === JSON.stringify(wseg.map(s => s.text)), 'persisted DB dialogue is verbatim from the ledger (no paraphrase)');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 139: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
