/** Stage 136: deterministic board-count balancing (Storyboard only). Planning now CONVERGES on the hard
 * 12–15 window instead of hard-failing: too many boards are merged (packing up to two short adjacent lines
 * into one board within 4–6s), too few are split (a two-line exchange or a long action beat becomes two
 * boards). Speech is NEVER dropped, omitted, re-ordered, paraphrased or sped up; a hard, INFORMATIVE
 * conflict is raised ONLY for genuinely unfittable material (far more two-line boards than 15 can hold).
 * Stage 132/133/134/135 invariants (attribution NAME (delivery): "line", per-line addressee/eyeline,
 * multi-speaker staging, verbatim text/order, no unsupported i2v fields, SCENES untouched) are regressed
 * here. Pure logic + mocked REAL provider transport and workers. No network, no paid generation. */
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

/** Build N short labelled lines through the REAL source pipeline so the ledger ids match the app exactly. */
function buildSource(n: number, cast: string[]) {
  const lines = Array.from({ length: n }, (_, i) => `${cast[i % cast.length]} (calmly): "Line ${i + 1}."`).join('\n');
  const scenes = [{ number: 1, action: `${cast.join(' and ')} talk in the room.`, dialogue: lines }];
  return { scenes, src: storyboardSource({ description: 'A conversation.' }, scenes, genders(cast)) };
}

async function main() {
const cast2 = ['Anna', 'Boris'];
const img = 'https://storyboardart.org/wp-content/uploads/2022/04/mimoshort_thumbnails_01-scaled.jpg';

/* ─────────── 1) The board-split prompt now DEMANDS convergence on 12–15 (pack/split, never truncate) ─────────── */
const boardsPrompt = storyboardBoardsSystemPrompt();
ok(/land on exactly 12–15 boards/i.test(boardsPrompt), 'prompt requires landing on exactly 12–15 boards');
ok(/PACK up to two short adjacent lines/i.test(boardsPrompt) && /SPLIT a long action beat/i.test(boardsPrompt),
  'prompt tells the model to PACK dialogue-heavy stories and SPLIT sparse ones to hit the count');
ok(/never .*speed up speech|Never drop, omit, re-order, paraphrase or speed up speech/i.test(boardsPrompt),
  'prompt forbids dropping/omitting/speeding up speech to hit the count');
// Stage 132/133/134/135 requirements the prompt must keep verbatim.
for (const substr of ['speechIds', 'listener_reverse', 'LOCKED-OFF', '180-degree', 'NOT disappearance', 'NAME (delivery): "line"']) {
  ok(boardsPrompt.includes(substr), `prompt still carries the Stage 133/134/135 requirement: ${substr}`);
}

/* ─────────── 2) TOO MANY boards (naive >15): merge to exactly 12–15, every speech ID preserved in order ─────────── */
const big = buildSource(20, cast2);
const ids20 = big.src.segments.map(s => s.id);
const rawBig: RawDirectedBoard[] = big.src.segments.map((seg, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna gestures toward Boris.', durationSec: 6,
  region: 'at the table', speechIds: [seg.id], shot: 'over_shoulder',
}));
ok(rawBig.length === 20, 'scenario A starts naively above the maximum (20 boards)');
const balancedBig = balanceBoardCount(rawBig, big.src.segments);
ok(balancedBig.length >= 12 && balancedBig.length <= 15, `dialogue-heavy plan converges into 12–15 (got ${balancedBig.length})`);
const flatBig = balancedBig.flatMap(b => b.speechIds ?? []);
ok(JSON.stringify(flatBig) === JSON.stringify(ids20), 'every one of the 20 speech IDs is preserved, exactly once, in source order (no truncation)');
ok(balancedBig.every(b => (b.speechIds?.length ?? 0) <= 2), 'no balanced board holds more than two spoken lines');
const finBig = finalizeDirectedBoards(balancedBig, big.src.segments, cast2, big.src.actionSource);
ok(finBig.length >= 12 && finBig.length <= 15, 'finalize accepts the merged plan (12–15 boards)');
ok(finBig.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every merged board lands in the 4–6s window');
ok(finBig.some(b => b.actionOrDialogue.includes('Anna (calmly): "Line 1."')) &&
   finBig.some(b => b.actionOrDialogue.includes('Boris (calmly): "Line 20."')),
  'merged boards render the verbatim NAME (delivery): "line" attribution (first and last lines survive)');
const finFlat = finBig.flatMap(b => (b.directionJson ? readBoardDirection(b.directionJson)!.speech.map(s => s.text) : []));
ok(JSON.stringify(finFlat) === JSON.stringify(big.src.segments.map(s => s.text)), 'finalized speech text is verbatim and in source order after merging');

/* ─────────── 3) TOO FEW boards (naive <12): split two-line exchanges into extra boards, no speech lost ─────────── */
const small = buildSource(8, cast2); // 8 segments
const ids8 = small.src.segments.map(s => s.id);
const rawSmall: RawDirectedBoard[] = [
  ...Array.from({ length: 4 }, (_, i): RawDirectedBoard => ({
    actionOrDialogue: `Exchange ${i + 1}`, actionEnglish: 'The two talk quietly.', durationSec: 6,
    region: 'at the table', speechIds: [small.src.segments[2 * i].id, small.src.segments[2 * i + 1].id], shot: 'over_shoulder',
  })),
  ...Array.from({ length: 4 }, (_, i): RawDirectedBoard => ({
    actionOrDialogue: `Anna crosses the room slowly, looking around the quiet office space ${i + 1}`,
    actionEnglish: 'Anna looks slowly around the room.', durationSec: 6, region: 'at the table', speechIds: [],
  })),
];
ok(rawSmall.length === 8, 'scenario B starts naively below the minimum (8 boards)');
const balancedSmall = balanceBoardCount(rawSmall, small.src.segments);
ok(balancedSmall.length >= 12 && balancedSmall.length <= 15, `sparse plan is padded into 12–15 by splitting (got ${balancedSmall.length})`);
const flatSmall = balancedSmall.flatMap(b => b.speechIds ?? []);
ok(JSON.stringify(flatSmall) === JSON.stringify(ids8), 'all 8 speech IDs survive the split, exactly once, in source order');
const finSmall = finalizeDirectedBoards(balancedSmall, small.src.segments, cast2, small.src.actionSource);
ok(finSmall.length >= 12 && finSmall.length <= 15, 'finalize accepts the split plan (12–15 boards)');
ok(finSmall.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every split board lands in the 4–6s window');

/* ─────────── 4) An already-valid plan (12 boards) is returned UNCHANGED (existing path untouched) ─────────── */
const mid = buildSource(6, cast2);
const rawMid: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i): RawDirectedBoard => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Steady reactions.', durationSec: 5, region: 'at the table',
  speechIds: i < 6 ? [mid.src.segments[i].id] : [], shot: i < 6 ? 'over_shoulder' : 'action',
}));
const balancedMid = balanceBoardCount(rawMid, mid.src.segments);
ok(balancedMid.length === 12 && balancedMid.every((b, i) => (b.speechIds ?? []).join() === (rawMid[i].speechIds ?? []).join()),
  'a plan already inside 12–15 is passed through untouched');

/* ─────────── 5) TRULY UNFITTABLE material still raises an INFORMATIVE conflict (edge case) ─────────── */
const huge = buildSource(32, cast2); // 32 segments, 16 two-line boards → cannot merge (4 ids/pair)
const rawHuge: RawDirectedBoard[] = Array.from({ length: 16 }, (_, i): RawDirectedBoard => ({
  actionOrDialogue: `Dense ${i + 1}`, actionEnglish: 'Both speak.', durationSec: 6, region: 'at the table',
  speechIds: [huge.src.segments[2 * i].id, huge.src.segments[2 * i + 1].id], shot: 'over_shoulder',
}));
throwsWith(
  () => balanceBoardCount(rawHuge, huge.src.segments),
  (m) => /outside the required 12–15/i.test(m) && /32 speech segments/.test(m) && /No boards or dialogue were truncated/i.test(m) && /\d+s of dialogue/i.test(m),
  'genuinely unfittable dialogue volume throws an informative conflict naming the count, seconds and segments',
);

/* ─────────── 6) Stage 133/134 staging invariants survive a merge (addressee/eyeline/shot preserved) ─────────── */
const cast3 = ['Anna', 'Boris', 'Clara'];
const three = storyboardSource({ description: 'A meeting.' }, [{ number: 1, action: 'Anna, Boris and Clara stand around the table.',
  dialogue: 'Anna (firmly): "Отчёт готов?"\nBoris (calmly): "Да, вчера вечером."\nClara (softly): "Я проверила цифры."\nAnna (nodding): "Отлично, спасибо."' }], genders(cast3));
// 18 boards: first 4 carry the repaired 3-cast lines, the rest are short static reactions to force a merge.
const rawThree: RawDirectedBoard[] = [
  ...three.segments.map((seg, i): RawDirectedBoard => ({
    actionOrDialogue: `Line ${i + 1}`, actionEnglish: 'Anna gestures toward the team.', durationSec: 6,
    region: 'at the table', speechIds: [seg.id], shot: i === 2 ? 'three_shot' : i === 3 ? 'listener_reverse' : 'over_shoulder',
  })),
  ...Array.from({ length: 14 }, (_, i): RawDirectedBoard => ({
    actionOrDialogue: `Reaction ${i + 1}`, actionEnglish: 'The team reacts quietly.', durationSec: 4, region: 'at the table', speechIds: [],
  })),
];
const balThree = balanceBoardCount(rawThree, three.segments);
ok(balThree.length >= 12 && balThree.length <= 15, 'three-speaker plan converges into 12–15');
const finThree = finalizeDirectedBoards(balThree, three.segments, cast3, three.actionSource);
const claraBoard = finThree.find(b => b.actionOrDialogue.includes('Clara (softly): "Я проверила цифры."'));
ok(!!claraBoard, 'the resolved three-speaker line survives balancing verbatim');
const claraPlan = readBoardDirection(claraBoard!.directionJson)!;
ok(claraPlan.speech.at(-1)!.addressee === 'Boris' && claraPlan.cast.length === 3,
  'per-line addressee (eyeline) and the full 3-cast context are preserved through the merge');
ok(readBoardDirection(finThree[0].directionJson)!.version === 134, 'balanced boards persist as the Stage 134 direction version');

/* ─────────── 7) i2v payload still carries NO unsupported reference fields (Seedance 2.5 i2v contract) ─────────── */
const reqBig = buildStoryboardVideoRequest({ actionOrDialogue: claraBoard!.actionOrDialogue, directionJson: claraBoard!.directionJson, durationSec: 6, imageUrl: img });
ok(reqBig.prompt.includes('SPEAKER: Clara') && reqBig.prompt.includes(JSON.stringify('Я проверила цифры.')),
  'i2v request carries the resolved speaker and verbatim line after balancing');
const body = buildSeedanceImageToVideoBody(reqBig);
ok(!('reference_images' in body) && !('image_input' in body), 'balanced-board i2v adds no unsupported character-reference fields');

/* ─────────── 8) SCENES / shared adapters remain byte-identical (Storyboard-only change) ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

await workerFlowCheck();

/* ─────────── 9) REAL worker flow: a naive >15 plan now REBUILDS into 12–15 boards instead of failing ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  let saved: any[] = [];
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna and Boris talk.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  // A 20-line labelled scene → 20 segments; the model naively returns 20 one-line boards.
  const wf = buildSource(20, cast2);
  const modelRaw: RawDirectedBoard[] = wf.src.segments.map((seg, i) => ({
    actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna gestures toward Boris.', durationSec: 6,
    region: 'at the table', speechIds: [seg.id], shot: 'over_shoulder',
  }));
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
      `high-volume dialogue now REBUILDS into 12–15 boards (saved ${saved.length}, no planning hard-block)`);
    const savedIds = saved.flatMap(b => JSON.parse(b.directionJson).speech.map((s: any) => s.id));
    ok(JSON.stringify(savedIds) === JSON.stringify(wf.src.segments.map(s => s.id)),
      'the DB boards preserve every one of the 20 speech segments, once, in source order (no truncation on rebuild)');
    ok(saved.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every persisted board stays inside the 4–6s window');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 136: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
