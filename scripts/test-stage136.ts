/** Stage 136 (updated for Stage 148): deterministic board-count balancing (Storyboard only). The board count
 * is now CONTENT-DERIVED — there is no hard 12–15 window and no hard-fail for a count outside it. A plan is
 * kept as-is whenever no board overflows its 4–6s budget and the count sits at or below a generous
 * content-derived ceiling: a dialogue-heavy plan legitimately stays above 15 and a sparse plan legitimately
 * stays below 12, both WITHOUT error. Overflowing boards fan their speech out onto following boards; only a
 * pathological over-split beyond the content ceiling is folded back by lossless merges. Speech is NEVER
 * dropped, omitted, re-ordered, paraphrased or sped up, and the only remaining count conflict is an empty plan.
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

/* ─────────── 1) The board-split prompt now asks for a CONTENT-DERIVED count (as many as needed, never truncate) ─────────── */
const boardsPrompt = storyboardBoardsSystemPrompt();
ok(!/land on exactly 12–15 boards/i.test(boardsPrompt) && !/12-15/.test(boardsPrompt),
  'prompt no longer demands a fixed 12–15 board count');
ok(/as many/i.test(boardsPrompt) && /no fixed (board count|target)/i.test(boardsPrompt),
  'prompt asks the model to use as many boards as the content needs (no fixed count)');
ok(/pack up to two short adjacent lines/i.test(boardsPrompt),
  'prompt still tells the model to pack up to two short adjacent lines within 4–6s');
ok(/never .*speed up speech|Never drop, omit, re-order, paraphrase or speed up speech/i.test(boardsPrompt),
  'prompt forbids dropping/omitting/speeding up speech to hit the count');
// Stage 132/133/134/135 requirements the prompt must keep verbatim.
for (const substr of ['speechIds', 'listener_reverse', 'LOCKED-OFF', '180-degree', 'NOT disappearance', 'NAME (delivery): "line"']) {
  ok(boardsPrompt.includes(substr), `prompt still carries the Stage 133/134/135 requirement: ${substr}`);
}

/* ─────────── 2) A dialogue-heavy plan (20 one-line boards) is KEPT above 15, every speech ID preserved in order ─────────── */
const big = buildSource(20, cast2);
const ids20 = big.src.segments.map(s => s.id);
const rawBig: RawDirectedBoard[] = big.src.segments.map((seg, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna gestures toward Boris.', durationSec: 6,
  region: 'at the table', speechIds: [seg.id], shot: 'over_shoulder',
}));
ok(rawBig.length === 20, 'scenario A is dialogue-heavy (20 one-line boards, above the old 15 max)');
const balancedBig = balanceBoardCount(rawBig, big.src.segments);
// Stage 148 — no merge-down to a fixed max: 20 non-overflowing boards below the content ceiling are kept as-is.
ok(balancedBig.length === 20, `dialogue-heavy plan keeps all 20 boards (content-derived, no 15 cap; got ${balancedBig.length})`);
const flatBig = balancedBig.flatMap(b => b.speechIds ?? []);
ok(JSON.stringify(flatBig) === JSON.stringify(ids20), 'every one of the 20 speech IDs is preserved, exactly once, in source order (no truncation)');
ok(balancedBig.every(b => (b.speechIds?.length ?? 0) <= 2), 'no balanced board holds more than two spoken lines');
const finBig = finalizeDirectedBoards(balancedBig, big.src.segments, cast2, big.src.actionSource);
ok(finBig.length === 20, 'finalize accepts the dialogue-heavy plan (20 boards, no 12–15 gate)');
ok(finBig.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every board lands in the 4–6s window');
ok(finBig.some(b => b.actionOrDialogue.includes('Anna (calmly): "Line 1."')) &&
   finBig.some(b => b.actionOrDialogue.includes('Boris (calmly): "Line 20."')),
  'merged boards render the verbatim NAME (delivery): "line" attribution (first and last lines survive)');
const finFlat = finBig.flatMap(b => (b.directionJson ? readBoardDirection(b.directionJson)!.speech.map(s => s.text) : []));
ok(JSON.stringify(finFlat) === JSON.stringify(big.src.segments.map(s => s.text)), 'finalized speech text is verbatim and in source order after merging');

/* ─────────── 3) A sparse plan (8 boards) is KEPT below 12 — no filler padding, no speech lost ─────────── */
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
ok(rawSmall.length === 8, 'scenario B is a sparse plan (8 boards, below the old 12 min)');
const balancedSmall = balanceBoardCount(rawSmall, small.src.segments);
// Stage 148 — no split-up to a fixed minimum: a sparse plan whose boards all fit their 4–6s budget is kept as-is.
ok(balancedSmall.length === 8, `sparse plan keeps its 8 boards (content-derived, no 12-board floor, no filler; got ${balancedSmall.length})`);
const flatSmall = balancedSmall.flatMap(b => b.speechIds ?? []);
ok(JSON.stringify(flatSmall) === JSON.stringify(ids8), 'all 8 speech IDs survive, exactly once, in source order');
const finSmall = finalizeDirectedBoards(balancedSmall, small.src.segments, cast2, small.src.actionSource);
ok(finSmall.length === 8, 'finalize accepts the sparse plan (8 boards, no 12–15 gate)');
ok(finSmall.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every sparse board lands in the 4–6s window');

/* ─────────── 4) An already-valid plan (12 boards) is returned UNCHANGED (existing path untouched) ─────────── */
const mid = buildSource(6, cast2);
const rawMid: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i): RawDirectedBoard => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Steady reactions.', durationSec: 5, region: 'at the table',
  speechIds: i < 6 ? [mid.src.segments[i].id] : [], shot: i < 6 ? 'over_shoulder' : 'action',
}));
const balancedMid = balanceBoardCount(rawMid, mid.src.segments);
ok(balancedMid.length === 12 && balancedMid.every((b, i) => (b.speechIds ?? []).join() === (rawMid[i].speechIds ?? []).join()),
  'a plan whose boards all fit their budget is passed through untouched (12 boards here)');

/* ─────────── 5) A high-volume dialogue plan (32 segments) is KEPT, not hard-blocked (Stage 148) ─────────── */
// Stage 148 — there is no longer a 12–15 cap to violate, so heavy dialogue no longer throws a planning
// conflict. The 16 two-line boards each fit their 4–6s budget and stay below the content ceiling, so the
// plan is returned intact with every one of the 32 speech segments preserved, exactly once, in source order.
const huge = buildSource(32, cast2); // 32 segments, 16 two-line boards
const ids32 = huge.src.segments.map(s => s.id);
const rawHuge: RawDirectedBoard[] = Array.from({ length: 16 }, (_, i): RawDirectedBoard => ({
  actionOrDialogue: `Dense ${i + 1}`, actionEnglish: 'Both speak.', durationSec: 6, region: 'at the table',
  speechIds: [huge.src.segments[2 * i].id, huge.src.segments[2 * i + 1].id], shot: 'over_shoulder',
}));
let hugeThrew = false;
let balancedHuge: RawDirectedBoard[] = [];
try { balancedHuge = balanceBoardCount(rawHuge, huge.src.segments); } catch { hugeThrew = true; }
ok(!hugeThrew, 'high-volume dialogue (32 segments) no longer raises a planning conflict (no 12–15 cap — Stage 148)');
ok(balancedHuge.length === 16, `all 16 two-line boards are kept (content-derived; got ${balancedHuge.length})`);
ok(JSON.stringify(balancedHuge.flatMap(b => b.speechIds ?? [])) === JSON.stringify(ids32),
  'every one of the 32 speech segments is preserved, exactly once, in source order (no truncation)');
ok(balancedHuge.every(b => (b.speechIds?.length ?? 0) <= 2), 'no kept board holds more than two spoken lines');
const finHuge = finalizeDirectedBoards(balancedHuge, huge.src.segments, cast2, huge.src.actionSource);
ok(finHuge.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'every high-volume board stays inside the 4–6s window');

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
// 18 mostly-mute boards sit above the content ceiling for 4 short lines, so the pathological-over-split
// guard folds adjacent boards losslessly back down to that ceiling (Stage 148).
const balThree = balanceBoardCount(rawThree, three.segments);
ok(balThree.length < 18 && balThree.length >= 4, `over-split three-speaker plan is folded back to the content ceiling without truncation (got ${balThree.length})`);
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
for (const file of ['lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

await workerFlowCheck();

/* ─────────── 9) REAL worker flow: a 20-board dialogue-heavy plan is PERSISTED intact (no rebuild, no failure) ─────────── */
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
    ok(saved.length === 20 && failures.length === 0,
      `high-volume dialogue persists all 20 content-derived boards (saved ${saved.length}, no 12–15 gate, no planning hard-block)`);
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
