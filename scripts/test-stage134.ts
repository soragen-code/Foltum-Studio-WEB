/** Stage 134: multi-speaker (3+) dialogue staging (Storyboard only). Each line goes to the correct
 * speaker AND names the real per-line addressee (eyeline / reverse target); everyone present keeps a
 * stable screen side and nobody disappears. Pure logic + mocked REAL provider transport and workers.
 * No network, no paid generation. Stage 132/133 two-hander invariants are regressed here too. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractSpokenLines, segmentSpeech, storyboardSource, type SpeechSegment } from '../lib/storyboard-dialogue';
import { finalizeDirectedBoards, readBoardDirection, boardShotContext, type RawDirectedBoard } from '../lib/storyboard-direction';
import { buildStoryboardVideoRequest, buildStoryboardAnimationPrompt } from '../lib/storyboard-animation';
import { buildSeedanceImageToVideoBody } from '../lib/wavespeed';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
function rejects(fn: () => unknown, message: string) { assert.throws(fn, message); passed++; }

const cast2 = ['Anna', 'Boris'];
const cast3 = ['Anna', 'Boris', 'Clara'];
const cast4 = ['Anna', 'Boris', 'Clara', 'Dmitri'];
const g3 = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }, { name: 'Clara', gender: 'female' }];
const speakers = (src: string, c: any[]) => extractSpokenLines(src, c).map(l => l.speaker).join(',');
const addressees = (src: string, c: any[]) => extractSpokenLines(src, c).map(l => l.addressee ?? '-').join(',');

/* ─────────── 1) THREE speakers: each line resolves to the right speaker AND the right addressee ─────────── */
// Labelled lines resolve every speaker deterministically among 3 cast; the addressee defaults to the
// person who just spoke (natural reply target), so it changes on every turn instead of sticking to one
// partner. The first line has no prior speaker → it is addressed to the group.
const d3 = 'Anna (firmly): "Отчёт готов?"\nBoris (calmly): "Да, вчера вечером."\nClara (softly): "Я проверила цифры."\nAnna (nodding): "Отлично, спасибо."';
ok(speakers(d3, cast3) === 'Anna,Boris,Clara,Anna', 'three-speaker lines resolve to the correct speakers in source order');
ok(addressees(d3, cast3) === '-,Anna,Boris,Clara', 'each line looks at the previous speaker by default; the addressee changes per line, never fixed to one partner');
// Explicit "asks X" overrides the default and points at a specific person — WITHOUT ever changing who speaks.
const dExplicit = 'Boris (calmly): "Начнём."\nAnna asks Clara: "Ты проверила цифры?"';
ok(extractSpokenLines(dExplicit, cast3)[1].speaker === 'Anna' && extractSpokenLines(dExplicit, cast3)[1].addressee === 'Clara',
  'explicit "asks X" makes Anna address Clara (not the previous speaker Boris), and never changes who speaks');

/* ─────────── 2) THREE speakers reach the board ledger with per-line addressee + eyeline ─────────── */
const scenes3 = [{ number: 1, action: 'Anna, Boris and Clara stand around the table.', dialogue: d3 }];
const src3 = storyboardSource({ description: 'A team meeting.' }, scenes3, g3);
ok(src3.segments.length === 4, 'all four three-speaker lines survive the split');
ok(src3.segments.map(s => s.addressee ?? '-').join(',') === '-,Anna,Boris,Clara', 'segment ledger carries the per-line addressee');
const raw3: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna gestures toward the team.', durationSec: 6, region: 'at the table',
  speechIds: i < 4 ? [src3.segments[i].id] : [],
  // Note: no listener supplied — the addressee must flow from the source line, not the model.
  shot: i === 2 ? 'three_shot' : i === 3 ? 'listener_reverse' : 'over_shoulder',
}));
const boards3 = finalizeDirectedBoards(raw3, src3.segments, cast3, src3.actionSource);
const p0 = readBoardDirection(boards3[0].directionJson)!;
const p1 = readBoardDirection(boards3[1].directionJson)!;
const p2 = readBoardDirection(boards3[2].directionJson)!;
const p3 = readBoardDirection(boards3[3].directionJson)!;
ok(p0.addressee === '' && p0.focus === 'Anna', 'board 1: Anna opens to the group (no single addressee), focus on the speaker');
ok(p1.addressee === 'Anna' && p1.listener === 'Anna' && p1.focus === 'Boris', 'board 2: Boris replies to Anna, reverse target = Anna');
ok(p2.addressee === 'Boris' && p2.listener === 'Boris' && p2.shot === 'three_shot' && p2.focus === 'Clara', 'board 3: addressee moved to Boris (not a fixed partner) with a three-shot');
ok(p3.shot === 'listener_reverse' && p3.focus === 'Clara' && p3.addressee === 'Clara', 'board 4: reverse-shot to Clara, the person Anna addresses');
ok(p0.version === 134, 'multi-speaker boards persist as version 134');
// Verbatim text + delivery + order preserved across the boards.
ok(boards3[0].actionOrDialogue.includes('Anna (firmly): "Отчёт готов?"'), 'board display uses NAME (delivery): "line"');
ok(boards3[1].actionOrDialogue.includes('Boris (calmly): "Да, вчера вечером."'), 'delivery cue preserved verbatim as NAME (delivery): "line"');
ok(!boards3[1].actionOrDialogue.includes('Anna'), 'a speaker board carries only its own speaker line, not another partner name');
ok([p0, p1, p2, p3].map(p => p.speech[0].text).join('|') === 'Отчёт готов?|Да, вчера вечером.|Я проверила цифры.|Отлично, спасибо.',
  'verbatim original-language text preserved in source order across boards');

/* ─────────── 3) Everyone present is staged; eyeline follows the addressee; nobody disappears ─────────── */
const ctx0 = boardShotContext(p0);
const ctx1 = boardShotContext(p1);
const ctx2 = boardShotContext(p2);
ok(ctx1.includes('Anna') && ctx1.includes('Boris') && ctx1.includes('Clara'), 'all three cast members remain listed in the scene context — none disappears');
ok(ctx1.includes('screen-left') && ctx1.includes('screen-right'), 'stable screen sides retained (Stage 132 axis wording)');
ok(ctx1.includes('EYELINES: Boris → Anna'), 'board 2 eyeline points Boris at Anna (his real addressee)');
ok(ctx1.includes('PRESENT AND REACTING') && ctx1.includes('Anna, Clara'), 'the non-speaking cast is explicitly listed as present and reacting');
ok(ctx2.includes('Clara → Boris') && !ctx2.includes('Clara → Anna'), 'when the addressee changes the eyeline moves to the new addressee, not the old partner');
ok(ctx0.includes('Anna → the group'), 'a group-addressed opener is staged toward the whole group');
ok(ctx1.includes('NOT disappearance') && ctx1.includes('180-degree'), 'off-screen ≠ disappearance and 180-degree axis wording retained');

/* ─────────── 4) FOUR speakers: addressee travels around the group, all four stay present ─────────── */
const d4 = 'Anna asks Boris: "Ты готов?"\nBoris asks Clara: "Где ключи?"\nClara asks Dmitri: "Ты их видел?"\nDmitri (firmly): "Они на столе."';
ok(speakers(d4, cast4) === 'Anna,Boris,Clara,Dmitri', 'four distinct speakers resolve in order');
ok(addressees(d4, cast4) === 'Boris,Clara,Dmitri,Clara', 'addressee moves around the group (Boris→Clara→Dmitri→Clara), never fixed');
const scenes4 = [{ number: 1, action: 'Four colleagues gather by the door.', dialogue: d4 }];
const src4 = storyboardSource({ description: 'Four at the door.' }, scenes4, cast4);
const raw4: RawDirectedBoard[] = Array.from({ length: 13 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'The four exchange glances.', durationSec: 5, region: 'by the door',
  speechIds: i < 4 ? [src4.segments[i].id] : [], shot: i === 3 ? 'group' : 'over_shoulder',
}));
const boards4 = finalizeDirectedBoards(raw4, src4.segments, cast4, src4.actionSource);
const q3 = readBoardDirection(boards4[3].directionJson)!;
ok(q3.speech[0].speaker === 'Dmitri' && q3.addressee === 'Clara' && q3.focus === 'Dmitri' && q3.shot === 'group', 'Dmitri addresses Clara on a group board; focus on the active speaker');
const ctxq3 = boardShotContext(q3);
ok(ctxq3.includes('Anna') && ctxq3.includes('Boris') && ctxq3.includes('Clara') && ctxq3.includes('Dmitri'), 'all four remain present in the four-speaker board context');
ok(ctxq3.includes('PRESENT AND REACTING') && ctxq3.includes('Anna, Boris, Clara'), 'the three non-speakers are staged as reacting, none removed');
ok(ctxq3.includes('Dmitri → Clara'), 'four-speaker eyeline points the active speaker at his real addressee');

/* ─────────── 5) Group line addressed to everyone → empty addressee + group framing ─────────── */
const dGroup = 'Anna (announcing): "Слушайте все внимательно."\nBoris asks Anna: "Что случилось?"';
ok(extractSpokenLines(dGroup, cast3)[0].addressee === undefined, 'a line addressed to the whole group has no single addressee');
ok(extractSpokenLines(dGroup, cast3)[1].addressee === 'Anna', 'the follow-up question is addressed back to Anna');
const srcG = storyboardSource({ description: 'Announcement.' }, [{ number: 1, action: 'Anna faces the room.', dialogue: dGroup }], cast3);
const rawG: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna addresses the room.', durationSec: 6, region: 'in the room',
  speechIds: i < 2 ? [srcG.segments[i].id] : [], shot: i === 0 ? 'group' : 'over_shoulder',
}));
const boardsG = finalizeDirectedBoards(rawG, srcG.segments, cast3, srcG.actionSource);
const pg0 = readBoardDirection(boardsG[0].directionJson)!;
ok(pg0.shot === 'group' && pg0.addressee === '' && pg0.focus === 'Anna', 'group board keeps an empty addressee and focuses the speaker');
ok(boardShotContext(pg0).includes('Anna → the group'), 'group eyeline is staged toward the whole group');

/* ─────────── 6) The real i2v payload carries speaker + addressee + verbatim line for 3+ speakers ─────────── */
const img = 'https://www.brantfoundation.org/wp-content/uploads/2016/05/remembering-henry-show-2-15.jpg';
const req2 = buildStoryboardVideoRequest({ actionOrDialogue: boards3[2].actionOrDialogue, directionJson: boards3[2].directionJson, durationSec: 6, imageUrl: img });
ok(req2.prompt.includes('SPEAKER: Clara') && req2.prompt.includes('TO: Boris'), 'i2v prompt names the active speaker and her real addressee');
ok(req2.prompt.includes(JSON.stringify('Я проверила цифры.')), 'verbatim original speech bytes reach the i2v request');
ok(req2.prompt.includes('Lip sync ONLY') && req2.prompt.includes('NEVER mouths or speaks'), 'only the named speaker lip-syncs; the others react');
const body2 = buildSeedanceImageToVideoBody(req2);
ok(!('reference_images' in body2) && !('image_input' in body2), 'no unsupported i2v character-reference fields introduced for multi-speaker boards');
ok(req2.generate_audio === true && req2.resolution === '720p' && !('last_image' in req2), 'documented i2v fields only; opening image untouched');
const animG = buildStoryboardAnimationPrompt({ actionOrDialogue: boardsG[0].actionOrDialogue, directionJson: boardsG[0].directionJson, durationSec: 6 });
ok(animG.includes('TO: the group'), 'a group line is voiced to the whole group in the animation prompt');
ok(animG.includes('180-degree') && animG.includes('CAMERA MODE: LOCKED-OFF'), 'axis + locked-off camera retained for stationary multi-speaker dialogue');

/* ─────────── 7) Multi-speaker conflict / integrity guards ─────────── */
rejects(() => extractSpokenLines('Anna: "Hi."\n"Bye."', cast3), 'a bare line among 3 cast with no cue is still a conflict, never an arbitrary pick');
rejects(() => extractSpokenLines('"Кто здесь?"', cast3), 'a first bare quote among 3 cast is a conflict, not a coin-flip');
// A per-line addressee that is not another cast member is rejected before any media is generated.
const badSeg: SpeechSegment[] = [{ id: 's.1', sourceId: 's', speaker: 'Anna', text: 'Привет.', delivery: '', estimatedSec: 1, addressee: 'Zed' }];
const badRaw: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({ actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna waves.', durationSec: 6, region: 'x', speechIds: i === 0 ? ['s.1'] : [], shot: 'over_shoulder' }));
rejects(() => finalizeDirectedBoards(badRaw, badSeg, cast3, ''), 'an addressee outside the cast is rejected before render');
// A self-addressed listener mapping is rejected (group line + model listener pointing at the speaker).
const selfRaw = rawG.map((b, i) => (i === 0 ? { ...b, listener: 'Anna' } : b));
rejects(() => finalizeDirectedBoards(selfRaw, srcG.segments, cast3, srcG.actionSource), 'a self-addressed listener mapping is rejected');

/* ─────────── 8) Stage 132/133 TWO-hander + single-line invariants still hold ─────────── */
const d2 = 'Anna: "Ты пришёл?"\n"Да, я здесь."';
ok(speakers(d2, cast2) === 'Anna,Boris', 'two-hander bare alternation still resolves');
ok(addressees(d2, cast2) === 'Boris,Anna', 'two-hander addressee is automatically the single partner');
const src2 = storyboardSource({ description: 'x' }, [{ number: 1, action: 'Anna and Boris meet by the wall.', dialogue: d2 }], cast2);
const raw2: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna nods to Boris.', durationSec: 6, region: 'by the wall',
  speechIds: i < 2 ? [src2.segments[i].id] : [], shot: i === 1 ? 'listener_reverse' : 'over_shoulder',
}));
const boards2 = finalizeDirectedBoards(raw2, src2.segments, cast2, src2.actionSource);
ok(readBoardDirection(boards2[0].directionJson)!.listener === 'Boris' && readBoardDirection(boards2[1].directionJson)!.focus === 'Anna', 'two-hander listener/reverse-focus unchanged');
const req2h = buildStoryboardVideoRequest({ actionOrDialogue: boards2[1].actionOrDialogue, directionJson: boards2[1].directionJson, durationSec: 6, imageUrl: img });
ok(req2h.prompt.includes('SPEAKER: Boris') && req2h.prompt.includes('TO: Anna'), 'two-hander i2v still carries speaker + partner addressee');
ok(!('reference_images' in buildSeedanceImageToVideoBody(req2h)), 'two-hander i2v still adds no unsupported character-reference fields');
// Single spoken line, single speaker board.
const src1 = storyboardSource({ description: 'x' }, [{ number: 1, action: 'Anna pauses.', dialogue: 'Anna: "Стой."' }], cast2);
const raw1: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({ actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna raises a hand.', durationSec: 6, region: 'here', speechIds: i === 0 ? [src1.segments[0].id] : [], shot: 'close_up' }));
const boards1 = finalizeDirectedBoards(raw1, src1.segments, cast2, src1.actionSource);
ok(readBoardDirection(boards1[0].directionJson)!.speech[0].text === 'Стой.' && readBoardDirection(boards1[0].directionJson)!.addressee === 'Boris', 'single line preserved verbatim with the partner as addressee');
// Stage 132 core guards.
rejects(() => finalizeDirectedBoards(raw3.map(b => ({ ...b, speechIds: [] })), src3.segments, cast3, src3.actionSource), 'still cannot omit dialogue');
rejects(() => finalizeDirectedBoards(raw3.map((b, i) => ({ ...b, speechIds: i < 4 ? [src3.segments[3 - i].id] : [] })), src3.segments, cast3, src3.actionSource), 'still cannot reorder speakers/lines');
rejects(() => finalizeDirectedBoards(raw3.map(b => ({ ...b, durationSec: 7 })), src3.segments, cast3, src3.actionSource), 'still enforces 4–6s duration');
rejects(() => segmentSpeech([{ speaker: 'Anna', delivery: '', text: 'word '.repeat(40).trim() }]), 'still rejects an unbroken overlong phrase');
ok(readBoardDirection(boards3[0].directionJson)!.cameraMode === 'LOCKED_OFF', 'static multi-speaker dialogue stays locked-off');

// SCENES / shared adapters must be byte-identical (Storyboard-only change).
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

/* ─────────── 9) REAL worker flow: a 3-speaker scene splits and reaches the real i2v request ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  let saved: any[] = [];
  let actualVideoRequest: any;
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna, Boris and Clara meet.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  const modelRaw = raw3;
  const prisma = {
    episode: { findUnique: async () => episode },
    episodeCharacter: { findMany: async () => g3.map((c) => ({ character: { name: c.name, imageFull: 'https://cdn3.toonboom.com/wp-content/uploads/2025/05/29110423/roughs-and-cleans-1.jpg', gender: c.gender } })) },
    scene: { findMany: async () => scenes3 },
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
    '@/lib/providers/image-provider': {
      generateImage: async () => 'https://storyboardart.org/wp-content/uploads/2022/04/mimoshort_thumbnails_01-scaled.jpg',
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
    ok(saved.length === 12 && failures.length === 0, 'three-speaker dialogue splits into validated boards with no failures');
    ok(saved[2].actionOrDialogue.includes('Clara (softly): "Я проверила цифры."'), 'DB board 3 keeps Clara as the resolved speaker + verbatim line');
    await workers.runBoardImageJob('mock-job', 'project1', 'board-2');
    await workers.runBoardVideoJob('mock-job', 'project1', 'board-2');
    ok(failures.length === 0 && saved[2].status === 'done', 'real animation worker completes with mocked media');
    ok(actualVideoRequest.prompt.includes('SPEAKER: Clara') && actualVideoRequest.prompt.includes('TO: Boris') && actualVideoRequest.prompt.includes(JSON.stringify('Я проверила цифры.')),
      'source → split → DB → real i2v request retains resolved speaker, real addressee and verbatim text');
    ok(actualVideoRequest.generate_audio === true && !('reference_images' in actualVideoRequest), 'real worker uses documented audio, never fakes character refs');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 134: PASS (${passed} checks; transport mocked, no paid generation)`);
}
workerFlowCheck().catch(err => { console.error(err); process.exitCode = 1; });
