/** Stage 132: pure planning + mocked REAL provider transport, no network or paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractSpokenLines, segmentSpeech, storyboardSource, hasActorTravel } from '../lib/storyboard-dialogue';
import { finalizeDirectedBoards, readBoardDirection, boardShotContext, type RawDirectedBoard } from '../lib/storyboard-direction';
import { buildStoryboardVideoRequest, buildStoryboardAnimationPrompt, storyboardCameraMode, STORYBOARD_I2V_EXTRA_REFS_SUPPORTED } from '../lib/storyboard-animation';
import { buildBoardFramePrompt } from '../lib/storyboard-prompt';
import { storyboardBoardsSystemPrompt } from '../lib/storyboard';
import { buildSeedanceImageToVideoBody, SEEDANCE_I2V_BODY_KEYS, SEEDANCE_I2V_SLUG } from '../lib/wavespeed';
import { startImageToVideoGeneration } from '../lib/providers/video-provider';
let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
function rejects(fn: () => unknown, message: string) { assert.throws(fn, message); passed++; }
const cast = ['Anna', 'Boris'];
const sourceText = 'Anna (whispering): "Не уходи. Стой рядом."\nBoris (gently): "Я здесь."';
const scenes = [{ number: 1, action: 'Anna and Boris walk across the room.', dialogue: sourceText }];
const source = storyboardSource({ description: 'A short story.', script: 'UNRELATED OLD TEXT' }, scenes, cast);
ok(source.segments.length === 2, 'original-language scene dialogue, not alternate script or translation');
ok(source.segments[0].speaker === 'Anna' && source.segments[0].delivery.includes('whispering'), 'speaker and original delivery preserved');
ok(source.segments[0].text === 'Не уходи. Стой рядом.', 'verbatim source language');
ok(extractSpokenLines('Anna asks Boris: "Stay here."', cast)[0].speaker === 'Anna', 'recipient name is not mistaken for speaker');
ok(extractSpokenLines('Anna: Stay here.\nBoris: "I will."', cast).map(s => s.speaker).join(',') === 'Anna,Boris', 'mixed labelled quote formats preserve source order');
const raw: RawDirectedBoard[] = Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: `Beat ${i + 1}: Anna reacts.`, actionEnglish: 'Anna nods to Boris.', motion: 'legacy camera push-in',
  durationSec: 6, region: 'by the wall', speechIds: i < 2 ? [source.segments[i].id] : [],
  shot: i === 1 ? 'listener_reverse' : 'over_shoulder', listener: i === 1 ? 'Anna' : 'Boris',
}));
const boards = finalizeDirectedBoards(raw, source.segments, cast, source.actionSource);
const plan = readBoardDirection(boards[0].directionJson)!;
ok(plan.cameraMode === 'LOCKED_OFF', 'static dialogue defaults locked off');
ok(plan.speech[0].text === source.segments[0].text, 'source text persisted in board direction');
ok(boards[0].actionOrDialogue.includes('Не уходи. Стой рядом.'), 'display text also comes from source');
ok(boards.length === 12 && boards.every(b => b.durationSec >= 4 && b.durationSec <= 6), 'board count and duration unchanged');
ok(boards.every(b => b.regionKey === 'by the wall'), 'location zone authority preserved');
ok(readBoardDirection(boards[1].directionJson)?.focus === 'Anna', 'listener reverse plan focuses correct partner while Boris speaks');
const staticCases = [
  'Anna nods.', 'Anna turns her head.', 'Anna gestures toward the door.',
  'Anna does not walk across the room.', 'Anna is not walking.', 'Anna never walks away.',
  'Anna walks in place.', 'The camera walks through the room.', 'Anna wants to walk to the door.',
  'Anna says "I walk across the room."', 'Anna: "We should walk home."', "Anna: 'I walk home.'",
  'Анна не идёт к двери.', 'Анна поворачивает голову.', 'Anna walks on a treadmill.', 'Anna stopped walking.', 'Anna talks about walking across the room.',
];
for (const text of staticCases) ok(!hasActorTravel(text), `not travel: ${text}`);
for (const text of ['Anna walks across the room.', 'Anna is walking toward Boris.', 'Both run down the corridor.', 'Anna sprints away.', 'Анна идёт к двери.', 'Anna does not wave, but Boris walks away.', 'Anna walks away without speaking.', 'Anna does not wave and Boris walks away.'])
  ok(hasActorTravel(text), `physical travel: ${text}`);
const walkRaw = raw.map(b => ({ ...b }));
walkRaw[0] = { ...raw[0], travelEvidence: scenes[0].action!, actionEnglish: 'Anna and Boris walk across the room.' };
const walkBoards = finalizeDirectedBoards(walkRaw, source.segments, cast, source.actionSource);
const walking = { actionOrDialogue: walkBoards[0].actionOrDialogue, directionJson: walkBoards[0].directionJson, durationSec: 6, imageUrl: 'https://www.brantfoundation.org/wp-content/uploads/2016/05/remembering-henry-show-2-15.jpg' };
const walkRequest = buildStoryboardVideoRequest(walking);
ok(storyboardCameraMode(walking) === 'TRACKING', 'walking dialogue tracks');
ok(walkRequest.prompt.includes('stable subject distance') && walkRequest.prompt.includes('Hold when they stop'), 'tracking subject-relative geometry and stop rule');
ok(!walkRequest.prompt.includes('CAMERA MODE: LOCKED-OFF'), 'tracking has no contradictory locked-off instruction');
const animationBoard = { ...walking, actionOrDialogue: boards[0].actionOrDialogue, directionJson: boards[0].directionJson };
const request = buildStoryboardVideoRequest(animationBoard);
ok(request.prompt.includes('CAMERA MODE: LOCKED-OFF'), 'static camera reaches actual request input');
ok(request.prompt.includes('No push-in, pull-out, zoom, pan, tilt, orbit, drift or reframing'), 'all autonomous camera motion prohibited');
ok(!request.prompt.includes('legacy camera push-in'), 'old motion camera instruction not reused');
ok(request.prompt.includes('No internal cuts'), 'no animation-internal shot/reverse shot');
ok(request.prompt.includes('SPEAKER: Anna') && request.prompt.includes('whispering'), 'speaker and delivery reach animation');
ok(request.prompt.includes(JSON.stringify(source.segments[0].text)), 'exact spoken bytes survive visual sanitizer');
ok(request.prompt.includes('Lip sync ONLY') && request.prompt.includes('NEVER mouths or speaks'), 'speaker-only lip sync; partner listens');
ok(request.generate_audio === true && request.resolution === '720p', 'native documented audio and existing resolution');
ok(request.image === walking.imageUrl && !('last_image' in request), 'original opening image is not replaced/resized; no end frame abuse');
ok(STORYBOARD_I2V_EXTRA_REFS_SUPPORTED === false, 'extra refs explicitly unsupported');
const body = buildSeedanceImageToVideoBody(request);
ok(Object.keys(body).every(k => (SEEDANCE_I2V_BODY_KEYS as readonly string[]).includes(k)), 'only documented provider fields');
ok(!('reference_images' in body) && !('image_input' in body), 'no fake i2v character reference fields');
const legacy = buildStoryboardAnimationPrompt({ actionOrDialogue: 'Anna (softly): "Stay here."', motion: 'slow zoom, fly away', characters: cast, durationSec: 4 });
ok(legacy.includes('Stay here.') && legacy.includes('LOCKED-OFF') && !legacy.includes('slow zoom, fly away'), 'legacy clips preserve attributed dialogue, discard old camera motion');
ok(storyboardCameraMode({ actionOrDialogue: 'Anna walks across the room while speaking: "Stay here."', characters: cast }) === 'TRACKING', 'legacy speaking while walking can track');
const frame = buildBoardFramePrompt({ board: { ...boards[0] }, characters: cast.map(name => ({ name, gender: name === 'Anna' ? 'female' : 'male' })), locationName: 'Room', hasPlate: true, hasRegionPlate: true });
ok(frame.aspectRatio === '9:16', 'vertical frame unchanged');
ok(frame.prompt.includes('over shoulder') && frame.prompt.includes('focus Anna'), 'actual frame uses dialogue shot and speaker');
ok(frame.prompt.includes('180-degree') && frame.prompt.includes('screen-left') && frame.prompt.includes('screen-right'), 'axis and screen-side mapping carried to frame');
ok(frame.prompt.includes('off-screen') && frame.prompt.includes('NOT disappearance'), 'close-up does not remove partner from location');
ok(frame.prompt.includes('REGION PLATE IS THE PRIMARY') && /FLUSH against/.test(frame.prompt), 'geometry authority and wall adjacency retained');
ok(frame.prompt.includes('camera is NOT locked') && frame.prompt.includes('BETWEEN boards'), 'free inter-board camera selection retained');
ok(boardShotContext(plan).includes('never inside the animation'), 'hard cuts only between boards');
// Budget/ledger integrity failures must be loud and occur before persistence/media generation.
rejects(() => finalizeDirectedBoards(raw.slice(0, 11), source.segments, cast, source.actionSource), 'too few boards');
rejects(() => finalizeDirectedBoards([...raw, ...raw], source.segments, cast, source.actionSource), 'no silent 15-board truncation');
rejects(() => finalizeDirectedBoards(raw.map(b => ({ ...b, speechIds: [] })), source.segments, cast, source.actionSource), 'cannot omit dialogue');
rejects(() => finalizeDirectedBoards(raw.map((b, i) => ({ ...b, speechIds: i < 2 ? [source.segments[1-i].id] : [] })), source.segments, cast, source.actionSource), 'cannot reorder speakers/lines');
rejects(() => finalizeDirectedBoards(raw.map((b, i) => ({ ...b, speechIds: i === 2 ? [source.segments[0].id] : b.speechIds })), source.segments, cast, source.actionSource), 'cannot repeat dialogue');
rejects(() => finalizeDirectedBoards(raw.map(b => ({ ...b, durationSec: 7 })), source.segments, cast, source.actionSource), 'no global duration expansion');
rejects(() => finalizeDirectedBoards(raw.map(b => ({ ...b, travelEvidence: 'Anna walks on Mars.' })), source.segments, cast, source.actionSource), 'no invented movement evidence');
rejects(() => finalizeDirectedBoards(raw.map(b => ({ ...b, travelEvidence: scenes[0].action! })), source.segments, cast, source.actionSource), 'no tracking static gestures from another action');
rejects(() => extractSpokenLines('A voice says "Hello."', cast), 'unknown speaker cannot become narrator');
rejects(() => storyboardSource({}, [{ number: 1, action: '', dialogue: 'Something spoken without attribution' }], cast), 'unparsed dialogue cannot silently disappear');
rejects(() => segmentSpeech([{ speaker: 'Anna', delivery: '', text: 'word '.repeat(40).trim() }]), 'unbroken overlong phrase explicit conflict');
const longText = 'We have to leave right now. The door is finally open. Please stay close to me.';
const longSegments = segmentSpeech([{ speaker: 'Anna', delivery: 'slowly', text: longText }]);
ok(longSegments.length > 1 && longSegments.map(s => s.text).join('') === longText, 'long phrase split at natural boundaries without loss');
const longRaw = raw.map((b, i) => ({ ...b, listener: 'Boris', speechIds: longSegments[i] ? [longSegments[i].id] : [] }));
const longBoards = finalizeDirectedBoards(longRaw, longSegments, cast, source.actionSource);
ok(longBoards.slice(0, longSegments.length).map(b => readBoardDirection(b.directionJson)!.speech[0].text).join('') === longText, 'long dialogue spans consecutive persisted boards losslessly');
rejects(() => finalizeDirectedBoards(longRaw.map((b, i) => ({ ...b, speechIds: i === 1 ? [] : i === 2 ? [longSegments[1].id] : b.speechIds })), longSegments, cast, source.actionSource), 'no silent gap between parts');
rejects(() => buildStoryboardVideoRequest({ ...animationBoard, directionJson: null, actionOrDialogue: 'Anna: "' + 'word '.repeat(40) + '"', characters: cast }), 'legacy overlong clip fails before paid submit');
const sys = storyboardBoardsSystemPrompt();
ok(sys.includes('speechIds') && sys.includes('listener_reverse') && sys.includes('LOCKED-OFF'), 'split requests directed camera/speech/shots');
// Baseline bytes prove SCENES and assembly were not changed, stronger than export-name checks.
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}
const worker = readFileSync('lib/workers/storyboard-job.ts', 'utf8');
ok(worker.includes('buildStoryboardVideoRequest(animationBoard)') && worker.includes('startImageToVideoGeneration(request)'), 'real worker submits tested request builder');
ok(worker.includes('finalizeDirectedBoards') && worker.includes('directionJson: b.directionJson') && worker.includes('prisma.$transaction'), 'validation precedes atomic board persistence');

/** Exercise the REAL workers with in-memory DB/LLM/media mocks. No dependency may reach the network. */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  let saved: any[] = [];
  let actualVideoRequest: any;
  let actualFrameRequest: any;
  const failures: string[] = [];
  const episode = { id: 'ep1', mode: 'STORYBOARD', description: 'Anna and Boris meet.', locationId: 'loc1', locationName: 'Room', locationDesc: 'Room with a bench flush against the wall.' };
  const prisma = {
    episode: { findUnique: async () => episode },
    episodeCharacter: { findMany: async () => cast.map((name, i) => ({ character: { name, imageFull: `https://example.org/character-${i}.png`, gender: i ? 'male' : 'female' } })) },
    scene: { findMany: async () => scenes },
    location: { findUnique: async () => ({ id: 'loc1', imageUrl: 'https://example.org/master.png', imageReverse: 'https://example.org/layout.png', regionPlates: null }) },
    board: {
      deleteMany: async () => { saved = []; },
      createMany: async ({ data }: any) => { saved = data.map((b: any, i: number) => ({ ...b, id: `board-${i}` })); },
      findUnique: async () => ({ ...saved[0], episode }),
      update: async ({ data }: any) => { Object.assign(saved[0], data); return saved[0]; },
    },
    $transaction: async (fn: (tx: any) => unknown) => fn(prisma),
  };
  let modelRaw = raw;
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
      generateImage: async (input: any) => { actualFrameRequest = input; return 'https://example.org/original-board-opening.png'; },
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
    ok(saved.length === 12 && failures.length === 0, 'real split worker persists validated source-directed boards');
    await workers.runBoardImageJob('mock-job', 'project1', 'board-0');
    ok(actualFrameRequest.prompt.includes('over shoulder') && actualFrameRequest.image_input.includes('https://example.org/master.png'), 'real frame worker uses shot planning plus existing geometry plates');
    await workers.runBoardVideoJob('mock-job', 'project1', 'board-0');
    ok(failures.length === 0 && saved[0].status === 'done', 'real animation worker completes with mocked media');
    ok(actualVideoRequest.image === saved[0].imageUrl && actualVideoRequest.prompt.includes(JSON.stringify(source.segments[0].text)), 'source → split → DB → actual animation request retains text and opening image');
    ok(actualVideoRequest.generate_audio === true && !('reference_images' in actualVideoRequest), 'real worker uses documented audio, never pretends to attach character refs');
    const priorBoards = JSON.stringify(saved);
    modelRaw = raw.map(b => ({ ...b, speechIds: [] }));
    await workers.runStoryboardBoardsJob('bad-plan', 'project1', 'ep1');
    ok(failures.some(e => e.includes('Dialogue integrity conflict')) && JSON.stringify(saved) === priorBoards, 'invalid replanning leaves old boards intact, no silent loss');
    episode.mode = 'SCENES';
    actualVideoRequest = null;
    await workers.runBoardVideoJob('wrong-mode', 'project1', 'board-0');
    ok(actualVideoRequest === null && failures.at(-1)?.includes('not in STORYBOARD'), 'SCENES cannot reach Storyboard i2v');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
}

async function transportCheck() {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.WAVESPEED_API_KEY;
  process.env.WAVESPEED_API_KEY = 'synthetic-test-key';
  let calls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), `https://api.wavespeed.ai/api/v3/${SEEDANCE_I2V_SLUG}`);
    assert.equal(init?.method, 'POST');
    const submitted = JSON.parse(String(init?.body));
    assert.deepEqual(submitted, body);
    assert.equal(submitted.image, walking.imageUrl);
    assert.equal(submitted.generate_audio, true);
    assert.ok(String(submitted.prompt).includes(JSON.stringify(source.segments[0].text)));
    return new Response(JSON.stringify({ data: { id: 'mock-only-no-generation' } }), { status: 200 });
  }) as typeof fetch;
  try {
    ok(await startImageToVideoGeneration(request) === 'mock-only-no-generation', 'actual adapter transports exact source speech/audio/opening frame in mocked POST');
    ok(calls === 1, 'single mock submit, no generation/poll/retry');
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.WAVESPEED_API_KEY; else process.env.WAVESPEED_API_KEY = oldKey;
  }
  await workerFlowCheck();
  console.log(`Stage 132: PASS (${passed} checks; transport mocked, no paid generation)`);
}
transportCheck().catch(err => { console.error(err); process.exitCode = 1; });
