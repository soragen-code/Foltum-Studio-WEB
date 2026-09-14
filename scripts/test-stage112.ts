import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { buildScenePrompt, REANGLE_REFERENCE_NOTE } from '../lib/scene-prompt';
import { TerminalReangleError, buildReangleRequest, obtainReangle, resolveVideoPredecessor, assertPredecessorReady, type ReangleCache } from '../lib/reangle';
import { finalVideoPrompt } from '../lib/video-prompt-final';
import { VISUAL_STYLE_ID } from '../lib/visual-style';
import { WAVESPEED_SEEDREAM_EDIT } from '../lib/providers/image-provider';
import * as realLook from '../lib/character-look';
let checks = 0;
const ok = (c: unknown, message: string) => { assert(c, message); checks++; };
const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';
const raw = url('actual-last'); const old = url('old-keyframe'); const edited = url('reangled');
const characters = [{ characterId: 'a', name: 'Anna', imageFull: url('anna'), appearance: 'grey jacket', tier: 'LEAD' }];
const location = { id: 'loc', name: 'Office', imageUrl: url('wide'), imageReverse: url('layout'), imageDetail: url('detail') };
const previous = { id: 's1', number: 1, episodeId: 'ep1', videoUrl: url('video'), lastFrameUrl: raw, status: 'generated', endStateActual: 'CAMERA OF THIS FRAME: frontal wide.\nWORLD: Anna at desk, right hand holding cup.', keyframeUrl: old };
const dialogue = 'ANNA (quietly): "Keep the door open. I will come back."';
const scene = { id: 's2', number: 2, episodeId: 'ep1', status: 'generating', videoPrompt: '[SHOT TYPE]: side medium\n[ACTION]: Anna lowers the cup.\n[CHARACTER]: Anna\n[TRANSITION]: cut', dialogue, startState: 'WORLD: Anna at desk.\nCAMERA: reverse medium shot at shoulder height', endState: 'Anna sets the cup down.', keyframeUrl: old, keyframeStatus: 'done', promptOverride: null, endStateActual: null, lookCache: null };
const base = { scene, characters, location, previous, forbiddenReferenceUrls: [raw, old] };
const support = buildScenePrompt(base).retryRefs;
const requestInput = { sceneId: scene.id, number: scene.number, startState: scene.startState, videoPrompt: scene.videoPrompt, previous, refs: support };

async function main() {
  globalThis.fetch = async () => { throw Error("Unexpected network call in mocked tests"); };
  const request = buildReangleRequest(requestInput);
  ok(request.slug === WAVESPEED_SEEDREAM_EDIT, 'Seedream edit, not text-to-image');
  assert.deepEqual(request.body.images, [raw, characters[0].imageFull, location.imageUrl, location.imageReverse]); checks++;
  ok(request.camera.includes('reverse medium'), 'camera comes from next scene');
  for (const text of ['Move ONLY THE CAMERA', 'No time passes', 'world-space positions', 'occupied/empty hands', 'Never mirror', 'Image1 overrides']) ok(String(request.body.prompt).includes(text), text);
  ok(!JSON.stringify(request.body).includes(old), 'old still never enters edit');
  const built = buildScenePrompt({ ...base, reangleUrl: edited });
  assert.deepEqual(built.referenceImages, [edited, characters[0].imageFull, location.imageUrl, location.imageReverse]); checks++;
  ok(built.prompt.includes(`[Image1] ${REANGLE_REFERENCE_NOTE}`), 'opening note is actual first image');
  ok(built.prompt.includes("[Image2] defines Anna's"), 'cast index follows edit');
  ok(built.prompt.includes('[Image3] the location') && built.prompt.includes('[Image4] the location'), 'wide/layout map actual indices');
  ok(built.dialogue === dialogue && built.prompt.includes('Keep the door open. I will come back.'), 'English speech stays verbatim');
  ok(!built.referenceImages.includes(raw) && !built.referenceImages.includes(old), 'no raw/old still in video');
  ok(!built.fallbackRefs.some(r => r.url === raw || r.url === old), 'retry/fallback excludes raw/old');
  const override = buildScenePrompt({ ...base, scene: { ...scene, skipReferences: true, promptOverride: '[Image1] old keyframe\nREFERENCE MAP: old\n[ACTION]: Anna lowers the cup.' }, reangleUrl: edited });
  ok(override.referenceImages[0] === edited && override.prompt.includes('[Image2] defines Anna'), 'override/legacy skip cannot bypass required refs');
  ok(!override.prompt.includes('old keyframe') && override.prompt.includes('Keep the door open. I will come back.'), 'override removes stale legend and retains exact audio');
  const contamination = buildScenePrompt({ ...base, characters: [...characters, { characterId: 'x', name: 'Wrong', imageFull: raw }], reangleUrl: edited });
  ok(!contamination.referenceImages.includes(raw), 'generic cast refs cannot leak raw');
  assert.throws(() => buildScenePrompt({ ...base, reangleUrl: raw }), /raw last frame/); checks++;
  const first = buildScenePrompt({ ...base, previous: null, scene: { ...scene, number: 1 } });
  ok(!first.newSceneReference && !first.retryRefs.some(r => r.kind === 'reangle'), 'series opening never creates intermediate still');
  const empty = buildScenePrompt({ scene, characters: [], location: null, previous: null });
  ok(!empty.newSceneReference && empty.referenceImages.length === 0, 'no-ref opening never generates hidden still');
  for (const changed of [
    { previous: { ...previous, videoUrl: url('video2') } }, { previous: { ...previous, lastFrameUrl: url('last2') } },
    { startState: 'CAMERA: low wide from doorway' }, { refs: support.map((r,i) => i === 0 ? { ...r, url: url('anna2') } : r) },
    { refs: support.map((r,i) => i === 2 ? { ...r, url: url('layout2') } : r) }, { videoPrompt: '[SHOT TYPE]: low close-up' },
  ]) ok(buildReangleRequest({ ...requestInput, ...changed }).hash !== request.hash, 'significant-input cache invalidation');
  let cache: ReangleCache | null = null; let submits = 0; let polls = 0; let uploads = 0;
  const store = { read: async () => cache, claim: async (failed?: ReangleCache) => { if(cache && cache !== failed) return false; cache = { phase: 'claimed' }; return true; }, save: async (v: ReangleCache) => { cache = v; } };
  const io = { submit: async () => { submits++; return 'image-task'; }, wait: async (_id: string) => { polls++; return edited; }, upload: async (u: string) => { uploads++; return u; } };
  const a = await obtainReangle(request, store, io); const b = await obtainReangle(request, store, io);
  ok(a.url === edited && b.cacheHit && submits === 1 && polls === 1 && uploads === 1, 'cache hit avoids all paid work/upload');
  cache = { phase: 'submitted', predictionId: 'saved-task' };
  await obtainReangle(request, store, io); ok(submits === 1, 'retry resumes persisted task, does not resubmit');
  cache = null;
  await assert.rejects(obtainReangle(request, store, { ...io, submit: async () => { throw Error('ambiguous timeout'); } }), /ambiguous/); checks++;
  await assert.rejects(obtainReangle(request, store, io), /needs recovery/); checks++;
  ok(submits === 1, 'uncertain submit never duplicates');
  cache = { phase: 'submitted', predictionId: 'failed-task' };
  await assert.rejects(obtainReangle(request, store, { ...io, wait: async () => { throw Error('edit failed'); } }), /edit failed/); checks++;
  ok((cache as ReangleCache).phase === 'submitted', 'failed edit retains task id; no fallback');
  await assert.rejects(obtainReangle(request, store, { ...io, upload: async () => raw }), /source frame/); checks++;
  cache = { phase: 'submitted', predictionId: 'terminal' };
  await assert.rejects(obtainReangle(request, store, { ...io, wait: async () => { throw new TerminalReangleError('confirmed provider failure'); } }), /confirmed/); checks++;
  ok((cache as ReangleCache).phase === 'failed', 'only confirmed terminal failure becomes retryable');
  await obtainReangle(request, store, io);
  ok(submits === 2, 'user retry after confirmed failed edit submits exactly one replacement');
  cache = null;
  const concurrent = await Promise.allSettled([obtainReangle(request, store, io), obtainReangle(request, store, io)]);
  ok(concurrent.some(r => r.status === 'fulfilled') && submits === 3, 'concurrent cache claim submits only one paid edit');
  assert.throws(() => assertPredecessorReady({ ...previous, status: 'generating' }), /Finish the previous/); checks++;
  assert.throws(() => assertPredecessorReady({ ...previous, lastFrameUrl: null }), /no extracted last frame/); checks++;
  const calls: any[] = [];
  const resolverDb = { episode: { findUnique: async () => ({ number: 2, seasonId: 'season' }), findFirst: async (q: any) => { calls.push(q); return { id: 'ep1' }; } }, scene: { findFirst: async (q: any) => { calls.push(q); return previous; } } };
  ok((await resolveVideoPredecessor(resolverDb, { number: 1, episodeId: 'ep2' }))?.id === previous.id, 'cross-episode predecessor');
  ok(calls[0].where.number === 1 && calls[1].orderBy.number === 'desc', 'previous episode final scene, not current episode keyframe');
  await assert.rejects(resolveVideoPredecessor({ ...resolverDb, scene: { findFirst: async () => null } }, { number: 2, episodeId: 'ep1' }), /Previous scene is missing/); checks++;

  // Execute the REAL video worker with all network/LLM/billing/storage dependencies mocked.
  let current: any = { ...scene }; let prior: any = previous; let epNumber = 1; let editFails = false;
  let editCalls: any[] = []; let videoCalls: any[] = []; let row: any; let refund = 0;
  const linked = () => characters.map(c => ({ characterId: c.characterId, character: { ...c, id: c.characterId } }));
  const db: any = {
    scene: { findUnique: async () => ({ ...current, characters: linked(), episode: { id: current.episodeId, location, chainRunActive: false } }),
      findFirst: async (q: any) => q.where?.id ? ({ ...current, characters: linked(), episode: { id: current.episodeId, location, propRegistry: null, season: { project: { isTest: false } } } }) : prior,
      update: async () => ({}) },
    episode: { findUnique: async () => ({ id: current.episodeId, number: epNumber, seasonId: 'season', script: '', propRegistry: null, location, season: { project: { isTest: false } } }), findFirst: async () => ({ id: 'ep1' }), update: async () => ({}) },
    sceneCharacter: { findMany: async () => linked() },
    generationJob: { updateMany: async ({where, data}: any) => {
      if (where.resultData === null && row.resultData !== null) return { count: 0 };
      Object.assign(row, data); return { count: 1 };
    }, update: async ({data}: any) => Object.assign(row, data) },
    user: { update: async () => { refund++; } }, creditTransaction: { create: async () => ({}) },
  };
  db.$transaction = async (fn: any) => fn(db);
  const mocked: Record<string, any> = {
    '@/lib/generation-diagnostics': { ...require('../lib/generation-diagnostics'), logAttempt: () => {} },
    '@/lib/db': { prisma: db }, '@/auth': { auth: async () => ({ user: { id: 'owner', email: 'test@invalid.test' } }) },
    '@/lib/rate-limit': { rateLimitByUser: () => null, RATE_LIMITS: { ai: {} } },
    '@/lib/character-look': { ...realLook, rewriteSceneLook: async (_chars: any, texts: any) => ({ texts, fromCache: true }) },
    '@/lib/prop-registry': { buildPropRegistry: async () => ({ registry: { props: [] }, fromCache: true }), parsePropRegistry: () => null },
    '@/lib/reangle-store': { ensureReangle: async (req: any) => { editCalls.push(req); if(editFails) throw Error('Camera edit failed: check the provider task and retry'); return { url: edited, cacheHit: false }; }, readReangleCache: async () => ({ phase: 'ready', url: edited }) },
    '@/lib/providers/video-provider': { startVideoGeneration: async (input: any) => { videoCalls.push(input); return 'video-task'; } },
    '@/lib/jobs': { updateJob: async (_id: string, data: any) => Object.assign(row, data), heartbeatJob: async () => {}, isCancelRequested: async () => false },
    '@/lib/reference-downscale': { downscaleReferences: async (u: string[]) => u, REFERENCE_WIDTH: 768 },
  };
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function(name: string, ...args: any[]) { return name in mocked ? mocked[name] : originalLoad.call(this, name, ...args); };
  const { runVideoJob } = require('../lib/workers/video-job');
  const preview = require('../app/api/ai/scenes/[id]/prompt/route');
  (Module as any)._load = originalLoad;
  async function run(number: number, episodeNumber = 1) {
    current = { ...scene, number, episodeId: `ep${episodeNumber}` }; epNumber = episodeNumber;
    row = { status: 'processing', resultData: null }; editCalls = []; videoCalls = [];
    await runVideoJob({ jobId: 'job', sceneId: current.id, projectId: 'p', userId: 'u', cost: 3, duration: 30 });
  }
  await run(1);
  ok(editCalls.length === 0 && videoCalls.length === 1, 'REAL worker series opening skips still/edit');
  await run(2);
  ok(editCalls.length === 1 && videoCalls.length === 1, 'REAL worker subsequent scene edits before video');
  assert.deepEqual(editCalls[0].body.images, [raw, characters[0].imageFull, location.imageUrl, location.imageReverse]); checks++;
  assert.deepEqual(videoCalls[0].reference_images, [edited, characters[0].imageFull, location.imageUrl, location.imageReverse]); checks++;
  ok(videoCalls[0].generate_audio === true && !('image' in videoCalls[0]) && !('last_image' in videoCalls[0]), 'audio enabled, T2V only');
  ok(videoCalls[0].prompt.includes('Keep the door open. I will come back.'), 'actual submitted dialogue verbatim');
  const response = await preview.GET(new Request('https://app.invalid/prompt'), { params: Promise.resolve({ id: current.id }) });
  const body = await response.json();
  assert.equal(body.prompt, videoCalls[0].prompt, 'preview and REAL worker final prompt identical'); checks++;
  assert.deepEqual(body.referenceKinds, JSON.parse(row.resultData).submittedReferences.map((r: any) => r.kind)); checks++;
  await runVideoJob({ jobId: 'job', sceneId: current.id, projectId: 'p', duration: 30 });
  ok(videoCalls.length === 1, 'duplicate worker invocation no second submission');
  await run(1, 2);
  ok(editCalls.length === 1 && videoCalls[0].reference_images[0] === edited, 'REAL worker episode boundary uses camera edit');
  editFails = true; await run(2);
  ok(!videoCalls.length && row.status === 'failed' && refund === 1, 'edit failure blocks video and preserves refund path');
  editFails = false; prior = { ...previous, lastFrameUrl: null }; await run(2);
  ok(!editCalls.length && !videoCalls.length && row.status === 'failed', 'missing frame fails before any generation');
  prior = { ...previous, status: 'generating' }; await run(2);
  ok(!editCalls.length && !videoCalls.length && row.status === 'failed', 'sequential guard inside worker');
  const read = (p: string) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const view = read('app/project/[id]/episode/[episodeId]/episode-view.tsx');
  ok(!/keyframe|kfBusy|generateKeyframe/i.test(view), 'no old keyframe UI/status/lightbox/buttons');
  ok(view.includes('scene.lastFrameUrl') && view.includes('openLightbox'), 'last-frame viewer kept');
  ok(read('app/api/ai/scenes/[id]/keyframe/route.ts').includes('status: 410'), 'legacy endpoint retired');
  ok(!/wavespeed|prisma|buildKeyframeRequest/.test(read('lib/workers/keyframe-job.ts')), 'legacy worker cannot generate');
  ok(!/ensureKeyframe|startImageGeneration|startImageToVideoGeneration/.test(read('lib/workers/video-job.ts')), 'no hidden old generation path');
  console.log(`Stage112: ${checks} checks passed; mocked only, no paid generation.`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
