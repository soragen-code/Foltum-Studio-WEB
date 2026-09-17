/** Stage 144: ACTION / POSE CONTINUITY between adjacent boards of one scene (Storyboard only).
 * Every board used to re-plan its blocking from scratch — boardShotContext literally said "Start from the
 * beginning of this scripted action, not its end", and the only image reference carried forward was the SCENE
 * ANCHOR (set/furniture geometry), never the people's poses. So if two characters were embracing on board N,
 * board N+1 (a different camera of the SAME instant) restarted them from a neutral standing pose and broke the
 * contact. Fix: the immediately previous board of the SAME scene AND SAME region becomes this board's CONTINUITY
 * source — its still is attached as a CONTINUITY reference image (priority: chars → continuity → anchor → plates)
 * and its action text is passed so the board CONTINUES the exact ongoing action (poses / body contact / props
 * carry over; only the camera angle + shot size change). Inheritance resets at a region boundary and at the
 * first board of a scene (which ESTABLISHES the action). i2v motion continues from the inherited opening pose.
 * When the previous board IS the scene anchor (board 2 of a scene) the shared still is attached once and both
 * roles point at it — image_input stays byte-identical to Stage 143 for that board.
 * Pure logic + a mocked REAL board_image worker. No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { boardShotContext, type BoardDirection } from '../lib/storyboard-direction';
import { composeBoardImageInput, buildContinuityLine, buildSceneAnchorLine, BOARD_BODY_FURNITURE_LINE } from '../lib/board-anchor';
import { buildBoardFramePrompt, BOARD_ACTION_CONTINUITY_LINE } from '../lib/storyboard-prompt';
import { buildStoryboardAnimationPrompt, buildStoryboardVideoRequest } from '../lib/storyboard-animation';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
const u = (n: string) => ["https:/", "boards.s3.amazonaws.com", `${n}.png`].join("/");

const cast2 = ['Anna', 'Boris'];
const g2 = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }];
const sp = (speaker: string, addressee: string, text = 'x', delivery = '') => ({ id: `s-${speaker}`, sourceId: 'src', speaker, addressee, text, delivery, estimatedSec: 1 });
const dir = (over: Partial<BoardDirection>): BoardDirection => ({
  version: 134, cast: cast2, shot: 'two_shot', focus: 'Anna', listener: 'Boris', addressee: 'Boris', actionEnglish: 'Anna embraces Boris.',
  speech: [], cameraMode: 'LOCKED_OFF', travelEvidence: '', ...over,
} as BoardDirection);
const links2 = [
  { name: 'Anna', gender: 'female', appearance: 'Anna appearance', age: 'adult' },
  { name: 'Boris', gender: 'male', appearance: 'Boris appearance', age: 'adult' },
];

async function main() {

/* ─────────── (A) boardShotContext: continuation vs establishing ─────────── */
const planA = dir({ actionEnglish: 'Anna embraces Boris.' });
const opening = boardShotContext(planA, 1, undefined, false);
const cont = boardShotContext(planA, 1, undefined, true);
ok(/OPENING ACTOR BLOCKING:/.test(opening) && !/CONTINUE this action from the exact moment/.test(opening) && /the boards that follow will CONTINUE it/.test(opening), 'boardShotContext: first board ESTABLISHES the action (OPENING ACTOR BLOCKING), later boards continue it');
ok(/ACTOR BLOCKING:/.test(cont) && /CONTINUE this action from the exact moment the immediately previous board left off/.test(cont) && /do NOT restart it from a neutral pose/.test(cont), 'boardShotContext: continuation carries every pose / body contact / prop forward, only the camera changes');
ok(!/Start from the beginning/.test(opening) && !/Start from the beginning/.test(cont), 'boardShotContext: the obsolete "start from the beginning of this scripted action, not its end" wording is gone');
ok(/AXIS: maintain a coherent 180-degree layout/.test(cont) && /Anna: staging position 1/.test(cont) && /Boris: staging position 2/.test(cont), 'boardShotContext: S134 axis + stable screen sides preserved under continuation');

/* ─────────── (B) buildContinuityLine content ─────────── */
const cl = buildContinuityLine(3);
ok(/CONTINUITY FRAME \(reference image 3\)/.test(cl), 'continuity line: names its reference index');
ok(/Carry over the EXACT physical action and body contact/.test(cl) && /if characters were embracing/.test(cl) && /REMAIN in that exact pose/.test(cl), 'continuity line: carry over the exact pose/contact (an embrace stays an embrace)');
ok(/do NOT reset anyone to a neutral standing pose/.test(cl) && /do NOT break physical contact/.test(cl) && /do NOT restart the action/.test(cl), 'continuity line: no neutral reset / no broken contact / no restart');
ok(/take the set\/furniture from the anchor frame/.test(cl) && /WHO is in frame and the framing from the SHOT SIZE line/.test(cl) && /may enter at the frame edge/.test(cl), 'continuity line: set from anchor, framing from SHOT SIZE, a partner\'s touching hand may enter at the frame edge');

/* ─────────── (C) composeBoardImageInput — priority / dedup / cap ─────────── */
const chars2 = [u('anna'), u('boris')];
const plates = [u('wide'), u('layout')];
const c0 = composeBoardImageInput({ characterRefs: chars2, continuityUrl: null, anchorUrl: null, plateUrls: plates, hasRegionPlate: false, maxRefs: 10 });
ok(c0.imageInput.join() === [...chars2, ...plates].join() && c0.continuityRefIndex === null && c0.anchorRefIndex === null, 'compose: first board = chars + plates, no continuity/anchor');
const cd = composeBoardImageInput({ characterRefs: chars2, continuityUrl: u('anchor'), anchorUrl: u('anchor'), plateUrls: plates, hasRegionPlate: false, maxRefs: 10 });
ok(cd.imageInput.join() === [...chars2, u('anchor'), ...plates].join() && cd.continuityRefIndex === 3 && cd.anchorRefIndex === 3, 'compose: previous board IS the anchor → single shared entry, both indices point at it (byte-identical to S143)');
const cc = composeBoardImageInput({ characterRefs: chars2, continuityUrl: u('prev'), anchorUrl: u('anchor'), plateUrls: plates, hasRegionPlate: false, maxRefs: 10 });
ok(cc.imageInput.join() === [...chars2, u('prev'), u('anchor'), ...plates].join() && cc.continuityRefIndex === 3 && cc.anchorRefIndex === 4, 'compose: distinct continuity is placed BEFORE the anchor (priority chars → continuity → anchor → plates)');
const cap = composeBoardImageInput({ characterRefs: [u('a'), u('b'), u('c')], continuityUrl: u('prev'), anchorUrl: u('anchor'), plateUrls: plates, hasRegionPlate: true, maxRefs: 6 });
ok(cap.imageInput.length === 6 && cap.imageInput.includes(u('prev')) && cap.imageInput.includes(u('anchor')) && cap.imageInput.slice(0, 3).join() === [u('a'), u('b'), u('c')].join(), 'compose cap: chars + continuity + anchor always survive the cap');
ok(cap.imageInput[3] === u('prev') && cap.imageInput[4] === u('anchor') && cap.imageInput[5] === u('layout') && cap.regionPlateAttached === false, 'compose cap: plates cut from the front — the region (wide) plate drops first, continuity/anchor never dropped');

/* ─────────── (D) buildBoardFramePrompt — continuity block presence/absence ─────────── */
const b0dir = JSON.stringify(dir({ actionEnglish: 'Anna embraces Boris.', shot: 'group' }));
const b1dir = JSON.stringify(dir({ actionEnglish: 'Anna holds Boris in the embrace.', shot: 'two_shot' }));
const fpFirst = buildBoardFramePrompt({ board: { index: 0, actionOrDialogue: 'Anna embraces Boris.', directionJson: b0dir }, characters: links2, hasPlate: true, anchorRefIndex: null });
ok(!/ACTION CONTINUITY/.test(fpFirst.prompt) && !/PREVIOUS SHOT ACTION/.test(fpFirst.prompt) && !/CONTINUITY FRAME/.test(fpFirst.prompt) && !/SCENE ANCHOR FRAME/.test(fpFirst.prompt), 'frame prompt (first board): no continuity block and no anchor block — the action is established here');
ok(/OPENING ACTOR BLOCKING/.test(fpFirst.prompt), 'frame prompt (first board): OPENING ACTOR BLOCKING');
const fpCont = buildBoardFramePrompt({ board: { index: 1, actionOrDialogue: 'Anna holds Boris.', directionJson: b1dir }, characters: links2, hasPlate: true, anchorRefIndex: 4, continuity: { previousActionText: 'Anna embraces Boris.', continuityRefIndex: 3 } });
ok(fpCont.prompt.includes(BOARD_ACTION_CONTINUITY_LINE), 'frame prompt (continued board): ACTION CONTINUITY block present');
ok(/PREVIOUS SHOT ACTION \(continue this exact moment\): Anna embraces Boris\./.test(fpCont.prompt), 'frame prompt (continued board): PREVIOUS SHOT ACTION carries the previous board\'s action text');
ok(fpCont.prompt.includes(buildContinuityLine(3)) && /CONTINUE this action from the exact moment/.test(fpCont.prompt), 'frame prompt (continued board): CONTINUITY reference frame + continuation blocking');
ok(fpCont.prompt.includes(buildSceneAnchorLine(4)) && fpCont.prompt.includes(BOARD_BODY_FURNITURE_LINE) && /GEOMETRY AUTHORITY/.test(fpCont.prompt), 'frame prompt (continued board): S142 anchor + body/furniture + S131 geometry still present');
const fpNoRef = buildBoardFramePrompt({ board: { index: 1, actionOrDialogue: 'Anna holds Boris.', directionJson: b1dir }, characters: links2, hasPlate: true, anchorRefIndex: 3, continuity: { previousActionText: 'Anna embraces Boris.', continuityRefIndex: null } });
ok(fpNoRef.prompt.includes(BOARD_ACTION_CONTINUITY_LINE) && /PREVIOUS SHOT ACTION/.test(fpNoRef.prompt) && !/CONTINUITY FRAME \(reference image/.test(fpNoRef.prompt), 'frame prompt: the continuity TEXT still applies even when no continuity IMAGE survived the cap');
// S143 visible-cast integrity is not broken by continuity: a close-up continued board still frames exactly one.
const cuDir = JSON.stringify(dir({ actionEnglish: 'Anna holds Boris in the embrace.', speech: [sp('Anna', 'Boris', 'Stay.')], shot: 'close_up' }));
const fpCU = buildBoardFramePrompt({ board: { index: 2, actionOrDialogue: 'Anna: "Stay."', directionJson: cuDir }, characters: links2, hasPlate: true, anchorRefIndex: 4, continuity: { previousActionText: 'Anna holds Boris in the embrace.', continuityRefIndex: 3 } });
ok(/CHARACTERS IN FRAME \(EXACTLY these 1 — nobody else\):\nAnna:/.test(fpCU.prompt) && /OFF-SCREEN[^\n]*Boris/.test(fpCU.prompt), 'frame prompt (close-up continued): S143 visible cast still EXACTLY one, the partner is off-screen');
ok(fpCU.prompt.includes(BOARD_ACTION_CONTINUITY_LINE) && /may enter at the frame edge/.test(fpCU.prompt), 'frame prompt (close-up continued): embrace continuity preserved; a partner\'s touching hand may enter at the edge');

/* ─────────── (E) i2v motion continues from the inherited opening pose ─────────── */
const mpFirst = buildStoryboardAnimationPrompt({ actionOrDialogue: 'Anna embraces Boris.', directionJson: b0dir, characters: cast2, durationSec: 5, boardIndex: 0 });
ok(/ACTOR ACTION ONLY:/.test(mpFirst) && !/continued from the previous shot/.test(mpFirst) && /OPENING ACTOR BLOCKING/.test(mpFirst), 'i2v (first board): no continuation note; the action is established');
const mpCont = buildStoryboardAnimationPrompt({ actionOrDialogue: 'Anna holds Boris.', directionJson: b1dir, characters: cast2, durationSec: 5, boardIndex: 1, previousActionText: 'Anna embraces Boris.' });
ok(/The opening frame already shows the ongoing action continued from the previous shot \(Anna embraces Boris\.\)/.test(mpCont) && /CONTINUE the motion smoothly from it/.test(mpCont) && /do NOT reset to a neutral pose/.test(mpCont), 'i2v (continued board): the motion continues from the inherited opening pose, not a neutral stance');
ok(/CONTINUE this action from the exact moment/.test(mpCont), 'i2v (continued board): boardShotContext continuation wording present');
const req = buildStoryboardVideoRequest({ actionOrDialogue: 'Anna holds Boris.', directionJson: b1dir, characters: cast2, durationSec: 5, boardIndex: 1, previousActionText: 'Anna embraces Boris.', imageUrl: u('frame-2') });
ok(!('reference_images' in (req as any)) && !('image_input' in (req as any)) && req.image === u('frame-2'), 'i2v request: continuity is TEXT-only — no extra image refs added (Seedance i2v contract unchanged)');
// S139 speech integrity under continuity: a dialogue board still emits its verbatim line.
const spCont = buildStoryboardAnimationPrompt({ actionOrDialogue: 'Anna: "Stay."', directionJson: cuDir, characters: cast2, durationSec: 5, boardIndex: 2, previousActionText: 'Anna holds Boris in the embrace.' });
ok(/ENGLISH SPOKEN LINES/.test(spCont) && /SAY EXACTLY: "Stay\."/.test(spCont), 'i2v (continued dialogue board): S139 verbatim speech is untouched by continuity');

/* ─────────── (F) unchanged SCENES / shared adapters + no obsolete wording in code ─────────── */
for (const file of ['lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}
{
  const s = readFileSync('lib/storyboard-direction.ts', 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(!/Start from the beginning/.test(s), 'lib/storyboard-direction.ts: obsolete "start from the beginning … not its end" wording removed from code');
}

await workerFlowCheck();

/* ─────────── (G) REAL board_image worker: continuity frame + text passed deterministically ─────────── */
async function workerFlowCheck() {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  process.env.BOARD_ANCHOR_WAIT_POLL_MS = '5';
  const ref: Record<string, string> = { Anna: u('anna-ref'), Boris: u('boris-ref') };
  const episode = { id: 'ep1', mode: 'STORYBOARD', locationId: 'loc1', locationName: 'Office', locationDesc: 'A long meeting table.' };
  // One scene (episode × location) with two regions: window (b0-b2) and door (b3-b4). Continuity carries over
  // WITHIN a region and resets at the region boundary; the anchor (b0) is shared across the whole scene.
  const spec = [
    { region: 'window', action: 'Anna embraces Boris.', shot: 'group' },
    { region: 'window', action: 'Anna holds Boris in the embrace.', shot: 'two_shot' },
    { region: 'window', action: 'Anna and Boris stay close together.', shot: 'two_shot' },
    { region: 'door', action: 'Anna and Boris part slightly.', shot: 'two_shot' },
    { region: 'door', action: 'Anna rests a hand on Boris shoulder.', shot: 'two_shot' },
  ];
  const mk = (i: number): Record<string, any> => ({
    id: `b${i}`, episodeId: 'ep1', index: i, actionOrDialogue: spec[i].action, motionEn: null,
    directionJson: JSON.stringify(dir({ actionEnglish: spec[i].action, shot: spec[i].shot as BoardDirection['shot'], speech: [] })),
    region: spec[i].region, status: 'pending', imageUrl: null, imagePrompt: null, anchorUrl: null, anchorBoardId: null,
  });
  const saved = [0, 1, 2, 3, 4].map(mk);
  const failures: string[] = [];
  const calls: Array<{ image_input: string[]; prompt: string }> = [];
  let renderCount = 0;
  const prisma = {
    board: {
      findUnique: async ({ where }: any) => { const b = saved.find(s => s.id === where.id); return b ? { ...b, episode } : null; },
      findMany: async ({ where }: any) => saved.filter(s => !where?.episodeId || s.episodeId === where.episodeId),
      update: async ({ where, data }: any) => { const b = saved.find(s => s.id === where.id); if (b) Object.assign(b, data); return b; },
    },
    episodeCharacter: { findMany: async () => g2.map(c => ({ character: { name: c.name, imageFull: ref[c.name], gender: c.gender, appearance: `${c.name} appearance`, age: 'adult' } })) },
    location: { findUnique: async () => ({ id: 'loc1', name: 'Office', imageUrl: u('wide'), imageReverse: u('layout'), regionPlates: null }) },
  };
  const mocks: Record<string, unknown> = {
    '@/lib/db': { prisma },
    '@/lib/jobs': { updateJob: async () => {}, completeJob: async () => {}, isCancelRequested: async () => false, markCanceled: async () => {}, failJob: async (_id: string, message: string) => { failures.push(message); } },
    '@/lib/s3-upload': { uploadRemoteToS3: async (url: string) => url },
    '@/lib/providers/image-provider': {
      WAVESPEED_IMAGE_MAX_REFS: 10,
      generateImage: async (req: any) => { calls.push({ image_input: req.image_input ?? [], prompt: req.prompt }); renderCount++; return u(`frame-${renderCount}`); },
      GenerationCanceledError: class extends Error {},
    },
  };
  internal._load = function(id: string, ...rest: any[]) {
    const key = id.replace(/^.*\/lib\//, '@/lib/').replace(/\.(?:ts|js)$/, '');
    return mocks[key] ?? originalLoad.call(this, id, ...rest);
  };
  try {
    const workers = require('../lib/workers/storyboard-job');
    for (const b of [...saved]) await workers.runBoardImageJob(`job-${b.id}`, 'project1', b.id);
    ok(failures.length === 0 && calls.length === 5, `worker: 5 boards rendered without failures (${failures.join(' | ') || 'none'})`);
    const anchor = saved[0].imageUrl as string; // = u('frame-1')
    // b0 — first board of the scene: becomes the anchor, no continuity, no anchor block.
    ok(calls[0].image_input.join() === [ref.Anna, ref.Boris, u('wide'), u('layout')].join() && !/SCENE ANCHOR FRAME/.test(calls[0].prompt) && !/ACTION CONTINUITY/.test(calls[0].prompt) && /OPENING ACTOR BLOCKING/.test(calls[0].prompt), 'worker b1 (first): chars + plates only; establishes the action, becomes the anchor');
    // b1 — previous board IS the anchor → shared still attached ONCE (dedup), image_input byte-identical to S143.
    ok(calls[1].image_input.join() === [ref.Anna, ref.Boris, anchor, u('wide'), u('layout')].join(), 'worker b2 (dedup): continuity==anchor → the shared still is attached once');
    ok(/CONTINUITY FRAME \(reference image 3\)/.test(calls[1].prompt) && /SCENE ANCHOR FRAME \(reference image 3\)/.test(calls[1].prompt) && /PREVIOUS SHOT ACTION \(continue this exact moment\): Anna embraces Boris\./.test(calls[1].prompt), 'worker b2: continuity + anchor both point at reference image 3; previous action text = b1');
    // b2 — distinct continuity (b1 = frame-2) placed before the anchor (b0 = frame-1).
    ok(calls[2].image_input.join() === [ref.Anna, ref.Boris, u('frame-2'), anchor, u('wide'), u('layout')].join() && /CONTINUITY FRAME \(reference image 3\)/.test(calls[2].prompt) && /SCENE ANCHOR FRAME \(reference image 4\)/.test(calls[2].prompt) && /PREVIOUS SHOT ACTION \(continue this exact moment\): Anna holds Boris in the embrace\./.test(calls[2].prompt), 'worker b3: distinct continuity frame (b2) as ref image 3, anchor as ref image 4, previous action = b2');
    // b3 — region boundary (window → door): continuity RESETS, but the scene anchor (b0) is still attached.
    ok(calls[3].image_input.join() === [ref.Anna, ref.Boris, anchor, u('wide'), u('layout')].join() && !/CONTINUITY FRAME/.test(calls[3].prompt) && !/ACTION CONTINUITY/.test(calls[3].prompt) && /SCENE ANCHOR FRAME \(reference image 3\)/.test(calls[3].prompt) && /OPENING ACTOR BLOCKING/.test(calls[3].prompt), 'worker b4 (region boundary): continuity reset — no continuity frame/block; anchor still attached, action re-established');
    // b4 — continuity within the new region (b3 = frame-4).
    ok(calls[4].image_input.join() === [ref.Anna, ref.Boris, u('frame-4'), anchor, u('wide'), u('layout')].join() && /CONTINUITY FRAME \(reference image 3\)/.test(calls[4].prompt) && /SCENE ANCHOR FRAME \(reference image 4\)/.test(calls[4].prompt) && /PREVIOUS SHOT ACTION \(continue this exact moment\): Anna and Boris part slightly\./.test(calls[4].prompt), 'worker b5: continuity within the new region (b4), anchor ref image 4, previous action = b4');
    // Global invariants.
    ok(calls.slice(1).every(c => c.image_input.includes(anchor)) && calls.slice(1).every(c => /NOT a framing or cast reference/.test(c.prompt)), 'worker: the scene anchor is attached to every later board with the people caveat (S142)');
    ok(calls.every(c => c.prompt.includes(BOARD_BODY_FURNITURE_LINE) && /PERSISTENT SET PIECES|GEOMETRY AUTHORITY/.test(c.prompt) && !/Choose ONE framing/.test(c.prompt) && !/Start from the beginning/.test(c.prompt)), 'worker: S140/S142 lines kept; no soft framing and no obsolete "start from the beginning" wording in any prompt');
    ok(saved.every(b => b.status === 'frame_ready') && saved.slice(1).every(b => b.anchorBoardId === 'b0'), 'worker: statuses + S142 anchor persistence unchanged');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 144: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
