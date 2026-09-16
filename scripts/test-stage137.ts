/** Stage 137: deterministic PER-BOARD budget balancing (Storyboard only). A board that packs more spoken
 * time than a single 4–6s clip can carry no longer hard-fails at finalize ("Board N: dialogue exceeds its
 * Xs estimated budget…"). balanceBoardCount now AUTO-DISTRIBUTES the overflowing source IDs onto the
 * following board(s) — keeping a fitting prefix, splicing the remainder onto a fresh board inserted right
 * after — and co-converges with the Stage 136 count balancing so the plan simultaneously lands on 12–15
 * boards, each inside 4–6s, with speech NEVER dropped, omitted, re-ordered, paraphrased or sped up. A hard,
 * INFORMATIVE conflict is raised ONLY for genuinely unfittable material (more speech than 15×6s can hold).
 * Stage 133/134/135/136 invariants (attribution NAME (delivery): "line", per-line addressee/eyeline,
 * multi-speaker staging, verbatim text/order, count balancing, no unsupported i2v fields, SCENES untouched)
 * are regressed here. Pure logic + mocked REAL provider transport and workers. No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { storyboardSource, estimatedSpeechSeconds } from '../lib/storyboard-dialogue';
import { storyboardBoardsSystemPrompt } from '../lib/storyboard';
import {
  balanceBoardCount,
  finalizeDirectedBoards,
  readBoardDirection,
  type RawDirectedBoard,
} from '../lib/storyboard-direction';
import { buildStoryboardVideoRequest } from '../lib/storyboard-animation';
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
const MAX_BOARD_SEC = 6;

/** Short one-word-ish lines (~1.6s each) through the REAL source pipeline — two of these fit one board. */
function buildShort(n: number, cast: string[]) {
  const lines = Array.from({ length: n }, (_, i) => `${cast[i % cast.length]} (calmly): "Line ${i + 1}."`).join('\n');
  const scenes = [{ number: 1, action: `${cast.join(' and ')} talk in the room.`, dialogue: lines }];
  return { scenes, src: storyboardSource({ description: 'A conversation.' }, scenes, genders(cast)) };
}
/** Long lines (~4.6s each) — a SINGLE one fits a board, but TWO in one board overflow the 4–6s budget. */
function buildLong(n: number, cast: string[]) {
  const L = 'This is a fairly long spoken line today';
  const lines = Array.from({ length: n }, (_, i) => `${cast[i % cast.length]} (calmly): "${L}"`).join('\n');
  const scenes = [{ number: 1, action: `${cast.join(' and ')} talk in the room.`, dialogue: lines }];
  return { scenes, src: storyboardSource({ description: 'A conversation.' }, scenes, genders(cast)) };
}
const speechSec = (b: RawDirectedBoard, ledger: Map<string, any>) =>
  (b.speechIds ?? []).reduce((s, id) => s + (ledger.get(id) ? estimatedSpeechSeconds(ledger.get(id)) : 0), 0);

async function main() {
const cast2 = ['Anna', 'Boris'];
const img = 'https://storyboardart.org/wp-content/uploads/2022/04/mimoshort_thumbnails_01-scaled.jpg';

/* ─────────── 1) The prompt now carries the explicit PER-BOARD budget rule (plus Stage 133–136 rules) ─────────── */
const boardsPrompt = storyboardBoardsSystemPrompt();
ok(/combined natural duration exceeds one board must be placed on consecutive boards/i.test(boardsPrompt),
  'prompt forbids packing two lines that together overflow one board');
ok(/never .*speed up speech|Never drop, omit, re-order, paraphrase or speed up speech/i.test(boardsPrompt),
  'prompt forbids speeding up / dropping speech to hit the count or the budget');
ok(/redistribute across consecutive boards instead/i.test(boardsPrompt),
  'prompt tells the model to redistribute over consecutive boards instead of truncating');
for (const substr of ['speechIds', 'listener_reverse', 'LOCKED-OFF', '180-degree', 'NOT disappearance', 'NAME (delivery): "line"', 'land on exactly 12–15 boards']) {
  ok(boardsPrompt.includes(substr), `prompt still carries the Stage 133/134/135/136 requirement: ${substr}`);
}

/* ─────────── 2) An over-BUDGET board (2 long lines in one board) is redistributed, not hard-failed ─────────── */
const over = buildLong(13, cast2);
const overLedger = new Map(over.src.segments.map(s => [s.id, s]));
const idsOver = over.src.segments.map(s => s.id);
// 12 boards: board 0 packs the first TWO long lines (~9.2s ≫ 6s budget), the rest carry one line each.
const rawOver: RawDirectedBoard[] = [
  { actionOrDialogue: 'Beat 1', actionEnglish: 'Anna gestures toward Boris.', durationSec: 6, region: 'at the table',
    speechIds: [idsOver[0], idsOver[1]], shot: 'over_shoulder' },
  ...idsOver.slice(2).map((id, i): RawDirectedBoard => ({
    actionOrDialogue: `Beat ${i + 2}`, actionEnglish: 'Steady reactions.', durationSec: 6, region: 'at the table',
    speechIds: [id], shot: 'over_shoulder',
  })),
];
ok(rawOver.length === 12 && speechSec(rawOver[0], overLedger) > MAX_BOARD_SEC,
  'scenario starts with a count-valid plan (12 boards) whose board 1 exceeds the per-board 6s budget');
// Under the OLD behaviour this plan hit the "dialogue exceeds its 6s estimated budget" throw. Now it balances.
const balOver = balanceBoardCount(rawOver, over.src.segments);
ok(balOver.every(b => speechSec(b, overLedger) <= MAX_BOARD_SEC), 'no balanced board exceeds the 4–6s per-board budget');
ok(balOver.length >= 12 && balOver.length <= 15, `redistributing the overflow keeps the plan in 12–15 (got ${balOver.length})`);
const flatOver = balOver.flatMap(b => b.speechIds ?? []);
ok(JSON.stringify(flatOver) === JSON.stringify(idsOver), 'every source ID is preserved exactly once, in source order, when the overflow is distributed');
ok(balOver.every(b => (b.speechIds?.length ?? 0) <= 2), 'no balanced board holds more than two spoken lines');
const finOver = finalizeDirectedBoards(balOver, over.src.segments, cast2, over.src.actionSource);
ok(finOver.length >= 12 && finOver.length <= 15, 'finalize accepts the redistributed plan without the per-board budget conflict');
ok(finOver.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every redistributed board lands in the 4–6s window');
const finOverText = finOver.flatMap(b => (b.directionJson ? readBoardDirection(b.directionJson)!.speech.map(s => s.text) : []));
ok(JSON.stringify(finOverText) === JSON.stringify(over.src.segments.map(s => s.text)), 'finalized speech text is verbatim and in source order after redistribution');

/* ─────────── 3) Co-work: an ALL-overflow, too-FEW-boards plan expands to 12–15, every ID kept ─────────── */
const both = buildLong(12, cast2);
const bothLedger = new Map(both.src.segments.map(s => [s.id, s]));
const idsBoth = both.src.segments.map(s => s.id);
// 6 boards, each packing TWO long lines: simultaneously below the minimum count AND every board over budget.
const rawBoth: RawDirectedBoard[] = Array.from({ length: 6 }, (_, i): RawDirectedBoard => ({
  actionOrDialogue: `Exchange ${i + 1}`, actionEnglish: 'The two talk.', durationSec: 6, region: 'at the table',
  speechIds: [idsBoth[2 * i], idsBoth[2 * i + 1]], shot: 'over_shoulder',
}));
ok(rawBoth.length === 6 && rawBoth.every(b => speechSec(b, bothLedger) > MAX_BOARD_SEC),
  'scenario starts below the minimum count with EVERY board over budget');
const balBoth = balanceBoardCount(rawBoth, both.src.segments);
ok(balBoth.length >= 12 && balBoth.length <= 15, `the count + per-board budget co-converge into 12–15 (got ${balBoth.length})`);
ok(balBoth.every(b => speechSec(b, bothLedger) <= MAX_BOARD_SEC), 'after co-convergence no board exceeds its 4–6s budget');
ok(JSON.stringify(balBoth.flatMap(b => b.speechIds ?? [])) === JSON.stringify(idsBoth), 'all 12 source IDs survive co-convergence, once, in source order');
const finBoth = finalizeDirectedBoards(balBoth, both.src.segments, cast2, both.src.actionSource);
ok(finBoth.length >= 12 && finBoth.length <= 15 && finBoth.every(b => b.durationSec >= 4 && b.durationSec <= 6),
  'finalize accepts the co-converged plan (12–15 boards, each 4–6s)');

/* ─────────── 4) Stage 136 count balancing still works alongside the new per-board redistribution ─────────── */
const big = buildShort(20, cast2); // 20 short one-line boards → merge down
const balBig = balanceBoardCount(big.src.segments.map((seg, i): RawDirectedBoard => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna gestures.', durationSec: 6, region: 'at the table', speechIds: [seg.id], shot: 'over_shoulder',
})), big.src.segments);
ok(balBig.length >= 12 && balBig.length <= 15 &&
   JSON.stringify(balBig.flatMap(b => b.speechIds ?? [])) === JSON.stringify(big.src.segments.map(s => s.id)),
  'a dialogue-heavy 20-board plan still merges down to 12–15 with every short line preserved (Stage 136 path intact)');
const small = buildShort(6, cast2); // 8 boards (4 two-line + 4 static) → split up
const rawSmall: RawDirectedBoard[] = [
  ...Array.from({ length: 3 }, (_, i): RawDirectedBoard => ({
    actionOrDialogue: `Exchange ${i + 1}`, actionEnglish: 'The two talk quietly.', durationSec: 6, region: 'at the table',
    speechIds: [small.src.segments[2 * i].id, small.src.segments[2 * i + 1].id], shot: 'over_shoulder',
  })),
  ...Array.from({ length: 5 }, (_, i): RawDirectedBoard => ({
    actionOrDialogue: `Anna crosses the room slowly, looking around the quiet office space ${i + 1}`,
    actionEnglish: 'Anna looks slowly around the room.', durationSec: 6, region: 'at the table', speechIds: [],
  })),
];
const balSmall = balanceBoardCount(rawSmall, small.src.segments);
ok(balSmall.length >= 12 && balSmall.length <= 15 &&
   JSON.stringify(balSmall.flatMap(b => b.speechIds ?? [])) === JSON.stringify(small.src.segments.map(s => s.id)),
  'a sparse plan is still padded to 12–15 by splitting, with all short lines preserved (Stage 136 path intact)');

/* ─────────── 5) TRULY UNFITTABLE material (far more speech than 15×6s) still raises an INFORMATIVE conflict ─────────── */
const huge = buildLong(19, cast2); // 19 long single-line boards: two longs (>6s) can never merge → count stuck >15
const rawHuge: RawDirectedBoard[] = huge.src.segments.map((seg, i): RawDirectedBoard => ({
  actionOrDialogue: `Dense ${i + 1}`, actionEnglish: 'Someone speaks.', durationSec: 6, region: 'at the table',
  speechIds: [seg.id], shot: 'over_shoulder',
}));
throwsWith(
  () => balanceBoardCount(rawHuge, huge.src.segments),
  (m) => /outside the required 12–15/i.test(m) && /19 speech segments/.test(m) && /No boards or dialogue were truncated/i.test(m) && /\d+s of dialogue/i.test(m),
  'genuinely unfittable dialogue volume throws an informative conflict naming the count, seconds and segments',
);

/* ─────────── 6) Stage 133/134 staging invariants survive an over-budget split (addressee/eyeline/reverse) ─────────── */
const cast3 = ['Anna', 'Boris', 'Clara'];
const three = storyboardSource({ description: 'A meeting.' }, [{ number: 1, action: 'Anna, Boris and Clara stand around the table.',
  dialogue: 'Anna (firmly): "Отчёт по кварталу уже полностью готов?"\nBoris (calmly): "Да, я закончил его ещё вчера вечером."\nClara (softly): "Я перепроверила все цифры сегодня утром."\nAnna (nodding): "Отлично, спасибо."' }], genders(cast3));
const threeLedger = new Map(three.segments.map(s => [s.id, s]));
// Pack the first TWO (long) lines onto one board so it overflows; pad with static reactions to force a split-up too.
const rawThree: RawDirectedBoard[] = [
  { actionOrDialogue: 'Line 1', actionEnglish: 'Anna gestures toward the team.', durationSec: 6, region: 'at the table',
    speechIds: [three.segments[0].id, three.segments[1].id], shot: 'over_shoulder' },
  ...three.segments.slice(2).map((seg, i): RawDirectedBoard => ({
    actionOrDialogue: `Line ${i + 3}`, actionEnglish: 'Anna gestures toward the team.', durationSec: 6,
    region: 'at the table', speechIds: [seg.id], shot: i === 0 ? 'three_shot' : 'listener_reverse',
  })),
  ...Array.from({ length: 9 }, (_, i): RawDirectedBoard => ({
    actionOrDialogue: `Reaction ${i + 1}`, actionEnglish: 'The team reacts quietly.', durationSec: 4, region: 'at the table', speechIds: [],
  })),
];
ok(speechSec(rawThree[0], threeLedger) > MAX_BOARD_SEC, 'three-speaker scenario begins with an over-budget board');
const balThree = balanceBoardCount(rawThree, three.segments);
ok(balThree.length >= 12 && balThree.length <= 15, 'three-speaker plan converges into 12–15');
ok(balThree.every(b => speechSec(b, threeLedger) <= MAX_BOARD_SEC), 'no three-speaker board exceeds its budget after redistribution');
const finThree = finalizeDirectedBoards(balThree, three.segments, cast3, three.actionSource);
const borisBoard = finThree.find(b => b.actionOrDialogue.includes('Boris (calmly): "Да, я закончил его ещё вчера вечером."'));
ok(!!borisBoard, 'the redistributed second line lands on its own board, verbatim');
const borisPlan = readBoardDirection(borisBoard!.directionJson)!;
ok(borisPlan.addressee === 'Anna' && borisPlan.shot === 'listener_reverse' && borisPlan.cast.length === 3,
  'the split-off board keeps its per-line addressee (eyeline), reverse framing and full 3-cast context');
ok(readBoardDirection(finThree[0].directionJson)!.version === 134, 'redistributed boards persist as the Stage 134 direction version');
const claraBoard = finThree.find(b => b.actionOrDialogue.includes('Clara (softly): "Я перепроверила все цифры сегодня утром."'));
ok(readBoardDirection(claraBoard!.directionJson)!.addressee === 'Boris', 'later per-line addressee (Clara → Boris) is preserved through balancing');

/* ─────────── 7) i2v payload still carries NO unsupported reference fields (Seedance 2.5 i2v contract) ─────────── */
const req = buildStoryboardVideoRequest({ actionOrDialogue: borisBoard!.actionOrDialogue, directionJson: borisBoard!.directionJson, durationSec: 6, imageUrl: img });
ok(req.prompt.includes('SPEAKER: Boris') && req.prompt.includes(JSON.stringify('Да, я закончил его ещё вчера вечером.')),
  'i2v request carries the resolved speaker and verbatim line after redistribution');
const body = buildSeedanceImageToVideoBody(req);
ok(!('reference_images' in body) && !('image_input' in body), 'redistributed-board i2v adds no unsupported character-reference fields');

/* ─────────── 8) SCENES / shared adapters remain byte-identical (Storyboard-only change) ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

await workerFlowCheck();

/* ─────────── 9) REAL worker flow: a plan with an over-BUDGET board now REBUILDS into 12–15 instead of failing ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  let saved: any[] = [];
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna and Boris talk.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  // 13 long lines; the model naively packs the first two into board 1 (over budget) + one per board after.
  const wf = buildLong(13, cast2);
  const wfIds = wf.src.segments.map(s => s.id);
  const modelRaw: RawDirectedBoard[] = [
    { actionOrDialogue: 'Beat 1', actionEnglish: 'Anna gestures toward Boris.', durationSec: 6, region: 'at the table', speechIds: [wfIds[0], wfIds[1]], shot: 'over_shoulder' },
    ...wfIds.slice(2).map((id, i): RawDirectedBoard => ({
      actionOrDialogue: `Beat ${i + 2}`, actionEnglish: 'Steady reactions.', durationSec: 6, region: 'at the table', speechIds: [id], shot: 'over_shoulder',
    })),
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
      `an over-budget model plan now REBUILDS into 12–15 boards (saved ${saved.length}, no planning hard-block)`);
    const savedIds = saved.flatMap(b => JSON.parse(b.directionJson).speech.map((s: any) => s.id));
    ok(JSON.stringify(savedIds) === JSON.stringify(wfIds),
      'the DB boards preserve every source segment, once, in source order (no truncation on rebuild)');
    ok(saved.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every persisted board stays inside the 4–6s window');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 137: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
