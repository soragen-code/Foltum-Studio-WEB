/** Stage 135: RESOLVING dialogue attribution (Storyboard only). Quoted speech with no unambiguous cast
 * speaker no longer HARD-BLOCKS board rebuilding: a deterministic pass runs first, then ONE optional LLM
 * repair round forces an explicit canonical NAME (delivery): "line" so boards rebuild. A hard, INFORMATIVE
 * conflict is thrown only when even the repair cannot attribute a line. Stage 132/133/134 invariants
 * (attribution, addressee/eyeline, multi-speaker staging, verbatim text/order, no unsupported i2v fields,
 * SCENES untouched) are regressed here. Pure logic + mocked REAL provider transport and workers.
 * No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  extractSpokenLines,
  extractSpokenLinesResilient,
  storyboardSource,
  storyboardSourceResilient,
  segmentSpeech,
  type DialogueRepairFn,
} from '../lib/storyboard-dialogue';
import {
  storyboardBoardsSystemPrompt,
  dialogueRepairSystemPrompt,
  dialogueRepairUserPrompt,
} from '../lib/storyboard';
import { finalizeDirectedBoards, readBoardDirection, type RawDirectedBoard } from '../lib/storyboard-direction';
import { buildStoryboardVideoRequest } from '../lib/storyboard-animation';
import { buildSeedanceImageToVideoBody } from '../lib/wavespeed';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
function rejectsSync(fn: () => unknown, message: string) { assert.throws(fn, message); passed++; }
async function throwsAsync(fn: () => Promise<unknown>, check: (msg: string) => boolean, message: string) {
  let threw = false; let caught = '';
  try { await fn(); } catch (err) { threw = true; caught = err instanceof Error ? err.message : String(err); }
  assert.ok(threw && check(caught), `${message} (got: ${caught || 'no throw'})`);
  passed++;
}

async function main() {
const cast2 = ['Anna', 'Boris'];
const cast3 = ['Anna', 'Boris', 'Clara'];
const g3 = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }, { name: 'Clara', gender: 'female' }];
const img = 'https://storyboardart.org/wp-content/uploads/2022/04/mimoshort_thumbnails_01-scaled.jpg';

/* ─────────── 1) The board-split prompt now DEMANDS the explicit NAME (delivery): "line" format ─────────── */
const boardsPrompt = storyboardBoardsSystemPrompt();
ok(boardsPrompt.includes('NAME (delivery): "line"'), 'board-split prompt requires the explicit NAME (delivery): "line" attribution');
// Stage 132/133/134 requirements the prompt must keep.
for (const substr of ['speechIds', 'listener_reverse', 'LOCKED-OFF', '180-degree', 'NOT disappearance']) {
  ok(boardsPrompt.includes(substr), `board-split prompt still carries the Stage 133/134 requirement: ${substr}`);
}
// The repair prompt is self-contained and never rewrites text.
const repairPrompt = dialogueRepairSystemPrompt();
ok(/canonical/i.test(repairPrompt) && /never change|immutable/i.test(repairPrompt), 'repair prompt forces canonical cast names and never rewrites text');
const repairUser = dialogueRepairUserPrompt(cast3, [{ id: 0, text: 'Кто здесь?', contextBefore: '' }]);
ok(repairUser.includes('Anna, Boris, Clara') && repairUser.includes('Кто здесь?'), 'repair user prompt lists the cast and the exact unresolved line');

/* ─────────── 2) The legacy fail-closed extractor STILL throws on ambiguous speech (contract unchanged) ─────────── */
const dAmb3 = '"Отчёт готов?"\n"Да, вчера вечером."\n"Я проверила цифры."\n"Отлично, спасибо."';
rejectsSync(() => extractSpokenLines(dAmb3, cast3), 'sync extractSpokenLines still throws on unattributed 3-cast speech (Stage 132/133/134 contract intact)');

/* ─────────── 3) Resilient WITHOUT repair throws an INFORMATIVE conflict (names the line + candidates) ─────────── */
await throwsAsync(
  () => extractSpokenLinesResilient(dAmb3, cast3),
  (m) => m.includes('Отчёт готов?') && m.includes('Anna, Boris, Clara') && /explicit NAME \(delivery\)/i.test(m),
  'resilient without a repairer throws an informative conflict quoting the exact line and the candidate cast',
);

/* ─────────── 4) Resilient WITH repair RESOLVES ambiguous 3-speaker speech (no throw) ─────────── */
// The LLM repairer is exercised here as a deterministic stub keyed by line id (no network).
const repair3: DialogueRepairFn = async ({ lines }) => lines.map((l, i) => ({
  id: l.id,
  speaker: ['Anna', 'Boris', 'Clara', 'Anna'][i] ?? 'Anna',
  delivery: ['firmly', 'calmly', 'softly', 'nodding'][i] ?? '',
}));
const fixed3 = await extractSpokenLinesResilient(dAmb3, g3, { repair: repair3 });
ok(fixed3.map(l => l.speaker).join(',') === 'Anna,Boris,Clara,Anna', 'repair assigns every ambiguous 3-cast line to an explicit canonical speaker in source order');
ok(fixed3.map(l => l.text).join('|') === 'Отчёт готов?|Да, вчера вечером.|Я проверила цифры.|Отлично, спасибо.', 'repair never rewrites, reorders or omits the spoken text');
ok(fixed3[0].delivery === 'firmly' && fixed3[1].delivery === 'calmly', 'repair fills the delivery cue for the explicit NAME (delivery): "line" format');
// Addressee/eyeline still derives from turn-taking, not from the repairer picking the speaker.
ok(fixed3.map(l => l.addressee ?? '-').join(',') === '-,Anna,Boris,Clara', 'per-line addressee (eyeline) flows from turn-taking after repair');

/* ─────────── 5) Repair only needs to seed a two-hander; deterministic alternation fills the rest ─────────── */
const dAmb2 = '"Ты пришёл?"\n"Да, я здесь."';
const repairSeed: DialogueRepairFn = async ({ lines }) => [{ id: lines[0].id, speaker: 'Anna', delivery: 'anxious' }];
const fixed2 = await extractSpokenLinesResilient(dAmb2, cast2, { repair: repairSeed });
ok(fixed2.map(l => l.speaker).join(',') === 'Anna,Boris', 'a single repaired speaker lets two-hander alternation resolve the neighbour');
ok(fixed2.map(l => l.addressee ?? '-').join(',') === 'Boris,Anna', 'two-hander addressees stay the single partner after repair');

/* ─────────── 6) An out-of-cast / empty repair still HARD-FAILS with the informative message (edge case) ─────────── */
const repairBad: DialogueRepairFn = async () => [];
await throwsAsync(
  () => extractSpokenLinesResilient(dAmb3, cast3, { repair: repairBad }),
  (m) => m.includes('Отчёт готов?') && /could not assign a unique speaker/i.test(m),
  'when the repair round returns nothing, the truly-unresolvable line still raises an informative conflict',
);
const repairOffCast: DialogueRepairFn = async ({ lines }) => lines.map(l => ({ id: l.id, speaker: 'Zoltan' }));
await throwsAsync(
  () => extractSpokenLinesResilient(dAmb3, cast3, { repair: repairOffCast }),
  (m) => /could not assign a unique speaker/i.test(m),
  'an out-of-cast repair guess is ignored (never silently accepted) and still reports the conflict',
);

/* ─────────── 7) Deterministic (already-attributed) speech is UNCHANGED by the resilient path ─────────── */
const dLabelled = 'Anna (firmly): "Отчёт готов?"\nBoris (calmly): "Да, вчера вечером."\nClara (softly): "Я проверила цифры."\nAnna (nodding): "Отлично, спасибо."';
const labelledSync = extractSpokenLines(dLabelled, cast3);
const labelledRes = await extractSpokenLinesResilient(dLabelled, cast3, { repair: repair3 });
ok(JSON.stringify(labelledSync) === JSON.stringify(labelledRes), 'fully-attributed speech resolves identically with or without the resilient repair path (repair never runs)');

/* ─────────── 8) storyboardSourceResilient rebuilds a whole ambiguous scene into a splittable ledger ─────────── */
const scenesAmb = [{ number: 1, action: 'Anna, Boris and Clara stand around the table.', dialogue: dAmb3 }];
const srcAmb = await storyboardSourceResilient({ description: 'A team meeting.' }, scenesAmb, g3, { repair: repair3 });
ok(srcAmb.segments.length === 4, 'resilient source builder keeps all four repaired lines through the split');
ok(srcAmb.segments.map(s => s.speaker).join(',') === 'Anna,Boris,Clara,Anna', 'resilient source ledger carries the explicit repaired speakers');
ok(srcAmb.segments.map(s => s.addressee ?? '-').join(',') === '-,Anna,Boris,Clara', 'resilient source ledger carries the per-line addressee');
// The sync storyboardSource still throws on the same ambiguous scene (unchanged contract).
rejectsSync(() => storyboardSource({ description: 'A team meeting.' }, scenesAmb, g3), 'sync storyboardSource still hard-fails the same ambiguous scene');

/* ─────────── 9) Repaired segments reach the board ledger with speaker + addressee + verbatim text ─────────── */
const rawAmb: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna gestures toward the team.', durationSec: 6, region: 'at the table',
  speechIds: i < 4 ? [srcAmb.segments[i].id] : [],
  shot: i === 2 ? 'three_shot' : i === 3 ? 'listener_reverse' : 'over_shoulder',
}));
const boardsAmb = finalizeDirectedBoards(rawAmb, srcAmb.segments, cast3, srcAmb.actionSource);
ok(boardsAmb.length === 12, 'ambiguous-but-repaired scene rebuilds a full 12-board plan');
ok(boardsAmb[2].actionOrDialogue.includes('Clara (softly): "Я проверила цифры."'), 'board 3 renders the repaired NAME (delivery): "line" verbatim');
const pAmb3 = readBoardDirection(boardsAmb[3].directionJson)!;
ok(pAmb3.shot === 'listener_reverse' && pAmb3.focus === 'Clara' && pAmb3.addressee === 'Clara', 'board 4: repaired Anna line reverse-shots its real addressee Clara (eyeline preserved)');
ok(readBoardDirection(boardsAmb[0].directionJson)!.version === 134, 'repaired boards persist as the Stage 134 direction version');
const reqAmb = buildStoryboardVideoRequest({ actionOrDialogue: boardsAmb[2].actionOrDialogue, directionJson: boardsAmb[2].directionJson, durationSec: 6, imageUrl: img });
ok(reqAmb.prompt.includes('SPEAKER: Clara') && reqAmb.prompt.includes('TO: Boris') && reqAmb.prompt.includes(JSON.stringify('Я проверила цифры.')),
  'i2v request for a repaired line carries the resolved speaker, real addressee and verbatim text');
ok(!('reference_images' in buildSeedanceImageToVideoBody(reqAmb)) && !('image_input' in buildSeedanceImageToVideoBody(reqAmb)),
  'repaired-line i2v still adds no unsupported character-reference fields');

/* ─────────── 10) SCENES / shared adapters remain byte-identical (Storyboard-only change) ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

await workerFlowCheck();

/* ─────────── 11) REAL worker flow: an AMBIGUOUS scene now rebuilds boards instead of failing the job ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  let saved: any[] = [];
  let actualVideoRequest: any;
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna, Boris and Clara meet.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  const modelRaw = rawAmb;
  // Merged mock: the SAME chatJSON serves BOTH the dialogue repair (reads .assignments) and the board split
  // (reads .boards). The repair returns the ambiguous scene's explicit speakers.
  const assignments = [
    { id: 0, speaker: 'Anna', delivery: 'firmly' },
    { id: 1, speaker: 'Boris', delivery: 'calmly' },
    { id: 2, speaker: 'Clara', delivery: 'softly' },
    { id: 3, speaker: 'Anna', delivery: 'nodding' },
  ];
  const prisma = {
    episode: { findUnique: async () => episode },
    episodeCharacter: { findMany: async () => g3.map((c) => ({ character: { name: c.name, imageFull: 'https://cdn3.toonboom.com/wp-content/uploads/2025/05/29110423/roughs-and-cleans-1.jpg', gender: c.gender } })) },
    scene: { findMany: async () => scenesAmb },
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
    '@/lib/ai': { chatJSON: async () => ({ boards: modelRaw, assignments }) },
    '@/lib/jobs': {
      updateJob: async () => {}, completeJob: async () => {}, isCancelRequested: async () => false,
      markCanceled: async () => {}, failJob: async (_id: string, message: string) => { failures.push(message); },
    },
    '@/lib/s3-upload': { uploadRemoteToS3: async (url: string) => url },
    '@/lib/assemble': { assembleStoryboardVideo: async () => { throw new Error('Unexpected assembly'); } },
    '@/lib/providers/image-provider': {
      generateImage: async () => img,
      GenerationCanceledError: class extends Error {},
    },
    '@/lib/providers/video-provider': {
      startImageToVideoGeneration: async (input: any) => { actualVideoRequest = input; return 'mock-video'; },
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
    ok(saved.length === 12 && failures.length === 0, 'ambiguous dialogue now REBUILDS into 12 validated boards (no attribution hard-block)');
    ok(saved[2].actionOrDialogue.includes('Clara (softly): "Я проверила цифры."'), 'DB board 3 keeps the LLM-repaired speaker Clara + verbatim line');
    await workers.runBoardImageJob('mock-job', 'project1', 'board-2');
    await workers.runBoardVideoJob('mock-job', 'project1', 'board-2');
    ok(failures.length === 0 && saved[2].status === 'done', 'real animation worker completes with mocked media');
    ok(actualVideoRequest.prompt.includes('SPEAKER: Clara') && actualVideoRequest.prompt.includes('TO: Boris') && actualVideoRequest.prompt.includes(JSON.stringify('Я проверила цифры.')),
      'source → repair → split → DB → real i2v request retains the repaired speaker, real addressee and verbatim text');
    ok(actualVideoRequest.generate_audio === true && !('reference_images' in actualVideoRequest), 'real worker uses documented audio, never fakes character refs');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 135: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
