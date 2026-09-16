/** Stage 133: deterministic dialogue attribution (Storyboard only). Pure logic + mocked REAL provider
 * transport and workers. No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractSpokenLines, segmentSpeech, storyboardSource } from '../lib/storyboard-dialogue';
import { finalizeDirectedBoards, readBoardDirection, type RawDirectedBoard } from '../lib/storyboard-direction';
import { buildStoryboardVideoRequest, buildStoryboardAnimationPrompt } from '../lib/storyboard-animation';
import { buildSeedanceImageToVideoBody } from '../lib/wavespeed';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
function rejects(fn: () => unknown, message: string) { assert.throws(fn, message); passed++; }

const cast = ['Anna', 'Boris'];
const gcast = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }];
const speakers = (src: string, c: any[] = cast) => extractSpokenLines(src, c).map(l => l.speaker).join(',');

/* ─────────── 1) Every quoted line resolves to a UNIQUE cast speaker (NAME) ─────────── */
// Bare alternating quotes: turn-taking from the first explicit speaker (no random guess).
ok(speakers('Anna: "Ты пришёл?"\n"Да, я здесь."\n"Я скучала."\n"И я тоже."') === 'Anna,Boris,Anna,Boris',
  'bare alternating quotes resolve to unique speakers by two-hander alternation');
// Addressee turn-taking: the partner explicitly addressed replies next.
ok(speakers('Anna asks Boris: "Где ты был?"\n"Я был на работе."') === 'Anna,Boris',
  'reply is attributed to the addressed partner, speaker not confused with recipient');
// Gender-lock: a pronoun reporter maps to the sole cast member of that sex.
ok(extractSpokenLines('She whispers: "Останься."', gcast)[0].speaker === 'Anna', 'female pronoun reporter → sole female cast');
ok(extractSpokenLines('He says: "Хорошо."', gcast)[0].speaker === 'Boris', 'male pronoun reporter → sole male cast');
// Aliases/diminutives resolve to the canonical cast NAME.
ok(speakers('Аня: "Привет."\nБоря: "Здравствуй."', [{ name: 'Анна', aliases: ['Аня'] }, { name: 'Борис', aliases: ['Боря'] }]) === 'Анна,Борис',
  'aliases resolve to canonical cast names');
// Regression: recipient is not the speaker; mixed labelled/quoted formats keep source order.
ok(extractSpokenLines('Anna asks Boris: "Stay here."', cast)[0].speaker === 'Anna', 'recipient name is not mistaken for speaker');
ok(speakers('Anna: Stay here.\nBoris: "I will."') === 'Anna,Boris', 'mixed labelled quote formats preserve source order');

/* ─────────── 2) Genuinely ambiguous / unmappable speech is a CONFLICT, never guessed ─────────── */
rejects(() => extractSpokenLines('"Привет."', cast), 'first bare quote with no cue is an explicit conflict, not a coin-flip');
rejects(() => extractSpokenLines('A voice says "Hello."', cast), 'unknown speaker cannot become a narrator');
rejects(() => extractSpokenLines('Anna: "Hi."\n"Bye."', ['Anna', 'Boris', 'Clara']), 'a bare line among 3+ cast with no cue is a conflict, not an arbitrary pick');
rejects(() => extractSpokenLines('She says: "Hi."', [{ name: 'Anna', gender: 'female' }, { name: 'Clara', gender: 'female' }]), 'ambiguous gender (two women) is a conflict, never a guess');
// The conflict surfaces at the SPLIT level (storyboardSource), before any board/media is generated.
rejects(() => storyboardSource({}, [{ number: 1, action: '', dialogue: '"Кто здесь?"' }], cast), 'ambiguous scene speech fails the atomic split, before board generation');

/* ─────────── 3) Verbatim text, order, delivery + explicit NAME (delivery): "line" format ─────────── */
const scenes = [{ number: 1, action: 'Anna and Boris walk across the room.', dialogue: 'Anna (whispering): "Не уходи. Стой рядом."\nBoris (gently): "Я здесь."' }];
const source = storyboardSource({ description: 'A short story.' }, scenes, gcast);
ok(source.segments.length === 2, 'both source lines survive the split');
ok(source.segments[0].speaker === 'Anna' && source.segments[0].delivery === 'whispering', 'canonical speaker and clean delivery (no wrapping parens)');
ok(source.segments[0].text === 'Не уходи. Стой рядом.' && source.segments[1].text === 'Я здесь.', 'verbatim original-language text preserved');
const raw: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}: Anna reacts.`, actionEnglish: 'Anna nods to Boris.', motion: 'legacy camera push-in',
  durationSec: 6, region: 'by the wall', speechIds: i < 2 ? [source.segments[i].id] : [],
  shot: i === 1 ? 'listener_reverse' : 'over_shoulder', listener: i === 1 ? 'Anna' : 'Boris',
}));
const boards = finalizeDirectedBoards(raw, source.segments, cast, source.actionSource);
ok(boards[0].actionOrDialogue.includes('Anna (whispering): "Не уходи. Стой рядом."'), 'board display uses explicit NAME (delivery): "quoted line"');
ok(boards[1].actionOrDialogue.includes('Boris (gently): "Я здесь."'), 'second speaker line rendered with its own attribution');
ok(!boards[0].actionOrDialogue.includes('Boris'), 'a speaker board does not carry the partner line (listener reacts, does not speak it)');
const plan0 = readBoardDirection(boards[0].directionJson)!;
ok(plan0.speech[0].speaker === 'Anna' && plan0.speech[0].text === 'Не уходи. Стой рядом.', 'direction ledger keeps speaker + verbatim text');
ok(plan0.listener === 'Boris' && plan0.listener !== plan0.speech[0].speaker, 'listener is the partner, never the speaker');
ok(readBoardDirection(boards[1].directionJson)!.focus === 'Anna', 'reverse-shot focuses the listener while Boris speaks');

/* ─────────── 4) Attribution reaches the REAL i2v payload with speaker/order/delivery/text ─────────── */
const altScenes = [{ number: 1, action: 'Anna and Boris talk by the wall.', dialogue: 'Anna: "Ты пришёл?"\n"Да, я здесь."' }];
const altSource = storyboardSource({ description: 'x' }, altScenes, gcast);
ok(altSource.segments.map(s => s.speaker).join(',') === 'Anna,Boris', 'alternation-resolved speakers flow through the split ledger');
const altRaw: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}`, actionEnglish: 'Anna nods to Boris.', durationSec: 6, region: 'by the wall',
  speechIds: i < 2 ? [altSource.segments[i].id] : [], shot: 'over_shoulder', listener: i < 2 ? (i === 0 ? 'Boris' : 'Anna') : 'Boris',
}));
const altBoards = finalizeDirectedBoards(altRaw, altSource.segments, cast, altSource.actionSource);
const img = 'https://www.brantfoundation.org/wp-content/uploads/2016/05/remembering-henry-show-2-15.jpg';
const req = buildStoryboardVideoRequest({ actionOrDialogue: altBoards[1].actionOrDialogue, directionJson: altBoards[1].directionJson, durationSec: 6, imageUrl: img });
ok(req.prompt.includes('SPEAKER: Boris'), 'the alternation-resolved speaker reaches the real i2v request');
ok(req.prompt.includes('DELIVERY: natural, consistent with the script'), 'a line with no source delivery gets an explicit default delivery, never invented text');
ok(req.prompt.includes(JSON.stringify('Да, я здесь.')), 'verbatim original speech bytes reach the request');
ok(req.prompt.includes('Lip sync ONLY') && req.prompt.includes('NEVER mouths or speaks'), 'speaker-only lip sync; the partner listens');
const body = buildSeedanceImageToVideoBody(req);
ok(!('reference_images' in body) && !('image_input' in body), 'no unsupported i2v character-reference fields introduced');
ok(req.generate_audio === true && req.resolution === '720p' && !('last_image' in req), 'documented i2v fields only; opening image untouched');
// Order preserved across consecutive boards; each spoken segment used exactly once.
ok([altBoards[0], altBoards[1]].map(b => readBoardDirection(b.directionJson)!.speech[0].text).join('|') === 'Ты пришёл?|Да, я здесь.', 'source order preserved across boards');

/* ─────────── 5) Stage 132 regression invariants still hold ─────────── */
rejects(() => finalizeDirectedBoards(raw.map(b => ({ ...b, speechIds: [] })), source.segments, cast, source.actionSource), 'still cannot omit dialogue');
rejects(() => finalizeDirectedBoards(raw.map((b, i) => ({ ...b, speechIds: i < 2 ? [source.segments[1 - i].id] : [] })), source.segments, cast, source.actionSource), 'still cannot reorder speakers/lines');
rejects(() => finalizeDirectedBoards(raw.map(b => ({ ...b, durationSec: 7 })), source.segments, cast, source.actionSource), 'still enforces 4–6s duration');
rejects(() => segmentSpeech([{ speaker: 'Anna', delivery: '', text: 'word '.repeat(40).trim() }]), 'still rejects an unbroken overlong phrase');
ok(readBoardDirection(boards[0].directionJson)!.cameraMode === 'LOCKED_OFF', 'static dialogue stays locked-off');
const walkRaw = raw.map(b => ({ ...b }));
walkRaw[0] = { ...raw[0], travelEvidence: scenes[0].action!, actionEnglish: 'Anna and Boris walk across the room.' };
const walkBoards = finalizeDirectedBoards(walkRaw, source.segments, cast, source.actionSource);
ok(readBoardDirection(walkBoards[0].directionJson)!.cameraMode === 'TRACKING', 'real scripted travel still tracks');
const anim = buildStoryboardAnimationPrompt({ actionOrDialogue: boards[0].actionOrDialogue, directionJson: boards[0].directionJson, durationSec: 6 });
ok(anim.includes('180-degree') && anim.includes('CAMERA MODE: LOCKED-OFF'), 'axis + locked-off camera retained in animation prompt');

// SCENES / shared adapters must be byte-identical (Storyboard-only change).
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

/* ─────────── 6) REAL worker flow: previously-throwing bare-alternation dialogue now splits ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  let saved: any[] = [];
  let actualVideoRequest: any;
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna and Boris meet.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  const modelRaw = altRaw;
  const prisma = {
    episode: { findUnique: async () => episode },
    episodeCharacter: { findMany: async () => gcast.map((c, i) => ({ character: { name: c.name, imageFull: `https://cdn3.toonboom.com/wp-content/uploads/2025/05/29110423/roughs-and-cleans-1.jpg`, gender: c.gender } })) },
    scene: { findMany: async () => altScenes },
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
    ok(saved.length === 12 && failures.length === 0, 'bare-alternation dialogue that previously threw now splits into validated boards');
    ok(saved[1].actionOrDialogue.includes('Boris: "Да, я здесь."'), 'DB board keeps the resolved speaker + verbatim line');
    await workers.runBoardImageJob('mock-job', 'project1', 'board-1');
    await workers.runBoardVideoJob('mock-job', 'project1', 'board-1');
    ok(failures.length === 0 && saved[1].status === 'done', 'real animation worker completes with mocked media');
    ok(actualVideoRequest.prompt.includes('SPEAKER: Boris') && actualVideoRequest.prompt.includes(JSON.stringify('Да, я здесь.')), 'source → split → DB → real i2v request retains resolved speaker + text');
    ok(actualVideoRequest.generate_audio === true && !('reference_images' in actualVideoRequest), 'real worker uses documented audio, never fakes character refs');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 133: PASS (${passed} checks; transport mocked, no paid generation)`);
}
workerFlowCheck().catch(err => { console.error(err); process.exitCode = 1; });
